import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, chmodSync, realpathSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAppearance, patchDesktopAppearance, resolveAppearanceAgentDir } from "../src/appearance.ts";

const defaults = { version: 1, revision: 0, desktop: { backgroundRgb: [0, 0, 0], backgroundOpacity: 55, transparentBackground: true } };
function fixture(t: any) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "emote-appearance-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent"), dir = join(agentDir, "extensions/gentle-emote"), file = join(dir, "appearance.json");
  return { root, agentDir, dir, file, options: { agentDir }, seed(text: string | Uint8Array) { mkdirSync(dir, { recursive: true, mode: 0o700 }); writeFileSync(file, text, { mode: 0o600 }); } };
}
test("missing read is virtual and save/reload preserves grouped checkbox semantics", async t => {
  const f = fixture(t);
  assert.deepEqual(await readAppearance(f.options), { status: "missing", snapshot: defaults });
  assert.equal(existsSync(f.agentDir), false);
  const saved = await patchDesktopAppearance(f.options, 0, { transparentBackground: false, backgroundOpacity: 100 });
  assert.equal(saved.status, "saved");
  const read = await readAppearance(f.options);
  assert.equal(read.status, "ready"); assert.equal(read.snapshot?.revision, 1);
  assert.deepEqual(read.snapshot?.desktop, { ...defaults.desktop, transparentBackground: false, backgroundOpacity: 100 });
  assert.equal((await patchDesktopAppearance(f.options, 1, { transparentBackground: true })).status, "saved");
  assert.equal((await readAppearance(f.options)).snapshot?.desktop.backgroundOpacity, 100);
});
test("turning transparency off requires an explicit grouped opacity even at 100", async t => {
  const f = fixture(t);
  const initial = { ...defaults, desktop: { ...defaults.desktop, backgroundOpacity: 100 } };
  f.seed(JSON.stringify(initial)); const before = readFileSync(f.file);
  assert.deepEqual(await patchDesktopAppearance(f.options, 0, { transparentBackground: false }), { status: "invalid" });
  assert.deepEqual(readFileSync(f.file), before);
  assert.deepEqual(await readAppearance(f.options), { status: "ready", snapshot: initial });
  assert.equal(existsSync(`${f.file}.lock`), false);
  assert.equal((await patchDesktopAppearance(f.options, 0, { transparentBackground: false, backgroundOpacity: 100 })).status, "saved");
  assert.deepEqual((await readAppearance(f.options)).snapshot, { ...initial, revision: 1, desktop: { ...initial.desktop, transparentBackground: false } });
  assert.equal(existsSync(`${f.file}.lock`), false);
});
test("temporary cleanup failure still releases the owned lock and preserves the original error", async t => {
  const f = fixture(t); f.seed(JSON.stringify(defaults)); const before = readFileSync(f.file);
  const originalUnlink = fsPromises.unlink;
  let renameFailures = 0, cleanupFailures = 0;
  const renameMock = t.mock.method(fsPromises, "rename", async () => {
    renameFailures++; throw Object.assign(new Error("injected rename failure"), { code: "EIO" });
  });
  const unlinkMock = t.mock.method(fsPromises, "unlink", async (path: string) => {
    if (path.startsWith(f.file + ".") && path.endsWith(".tmp")) {
      cleanupFailures++; throw Object.assign(new Error("injected cleanup failure"), { code: "EACCES" });
    }
    return originalUnlink(path);
  });
  syncBuiltinESMExports();
  let result;
  try { result = await patchDesktopAppearance(f.options, 0, { backgroundOpacity: 60 }); }
  finally { renameMock.mock.restore(); unlinkMock.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(renameFailures, 1); assert.equal(cleanupFailures, 1);
  assert.deepEqual(result, { status: "io-error", cleanupError: true });
  assert.equal(existsSync(`${f.file}.lock`), false);
  assert.deepEqual(readFileSync(f.file), before);
  assert.deepEqual(await readAppearance(f.options), { status: "ready", snapshot: defaults });
  assert.equal((await patchDesktopAppearance(f.options, 0, { backgroundOpacity: 60 })).status, "saved");
  assert.equal((await readAppearance(f.options)).snapshot?.revision, 1);
});
test("Unicode scalar policy rejects BOM and lone surrogates without mutation", async t => {
  const base = JSON.stringify(defaults);
  const cases = [
    ["leading BOM", "\ufeff" + base],
    ["high surrogate value", base.replace('"version":1', '"unknown":"\\uD800","version":1')],
    ["low surrogate value", base.replace('"version":1', '"unknown":"\\uDC00","version":1')],
    ["high surrogate key", base.replace('"version":1', '"\\uD800":0,"version":1')],
    ["low surrogate key", base.replace('"version":1', '"\\uDC00":0,"version":1')],
    ["nested surrogate", base.replace('"version":1', '"unknown":[{"value":"x\\uD800y"}],"version":1')],
  ];
  for (const [name, text] of cases) await t.test(name, async child => {
    const f = fixture(child); f.seed(text); const before = readFileSync(f.file);
    assert.deepEqual(await readAppearance(f.options), { status: "invalid" });
    assert.deepEqual(await patchDesktopAppearance(f.options, 0, { backgroundOpacity: 60 }), { status: "invalid" });
    assert.deepEqual(readFileSync(f.file), before);
    assert.equal(existsSync(`${f.file}.lock`), false);
  });
});
test("valid Unicode pairs in unknown keys and values survive read and save", async t => {
  const f = fixture(t);
  const text = JSON.stringify(defaults).replace('"version":1', '"\\uD83D\\uDE00":{"nested":["\\uD83D\\uDE03","literal 😄"]},"version":1');
  f.seed(text); const initial = JSON.parse(text);
  assert.deepEqual(await readAppearance(f.options), { status: "ready", snapshot: initial });
  assert.equal((await patchDesktopAppearance(f.options, 0, { backgroundOpacity: 60 })).status, "saved");
  assert.deepEqual((await readAppearance(f.options)).snapshot, { ...initial, revision: 1, desktop: { ...initial.desktop, backgroundOpacity: 60 } });
});
test("desktop leaf validation rejects without mutation; integer boundaries accepted", async t => {
  const f = fixture(t); f.seed(JSON.stringify(defaults));
  for (const patch of [{ backgroundRgb: [0, 256, 0] }, { backgroundRgb: [-1, 0, 0] }, { backgroundRgb: [0, 0] }, { backgroundRgb: [0, 0, 0.5] }, { backgroundOpacity: -1 }, { backgroundOpacity: 101 }, { backgroundOpacity: 1.5 }, { backgroundOpacity: "55" }, { transparentBackground: 1 }, { transparentBackground: false }, { image: {} }, { revision: 9 }, {}]) {
    const before = readFileSync(f.file);
    assert.equal((await patchDesktopAppearance(f.options, 0, patch as any)).status, "invalid");
    assert.deepEqual(readFileSync(f.file), before);
    assert.deepEqual((await readAppearance(f.options)).snapshot, defaults);
  }
  assert.equal((await patchDesktopAppearance(f.options, 0, { backgroundRgb: [0, 255, 128], backgroundOpacity: 0 })).status, "saved");
  assert.deepEqual((await readAppearance(f.options)).snapshot?.desktop.backgroundRgb, [0, 255, 128]);
});
test("unknown nested members survive CAS conflicts and concurrent disjoint edits", async t => {
  const f = fixture(t); const original = { ...defaults, image: { future: 3 }, extra: { nested: [null, -9007199254740991, "value"] }, desktop: { ...defaults.desktop, future: true } };
  f.seed(JSON.stringify(original));
  const results = await Promise.all([patchDesktopAppearance(f.options, 0, { backgroundRgb: [1, 2, 3] }), patchDesktopAppearance(f.options, 0, { backgroundOpacity: 80 })]);
  assert.deepEqual(results.map(r => r.status).sort(), ["conflict", "saved"]);
  const current = await readAppearance(f.options); const before = readFileSync(f.file);
  assert.equal((await patchDesktopAppearance(f.options, 0, { backgroundOpacity: 90 })).status, "conflict");
  assert.deepEqual(readFileSync(f.file), before);
  const remaining = current.snapshot!.desktop.backgroundOpacity === 80 ? { backgroundRgb: [1, 2, 3] as [number, number, number] } : { backgroundOpacity: 80 };
  assert.equal((await patchDesktopAppearance(f.options, 1, remaining)).status, "saved");
  assert.deepEqual((await readAppearance(f.options)).snapshot, { ...original, revision: 2, desktop: { ...original.desktop, backgroundRgb: [1, 2, 3], backgroundOpacity: 80 } });
});
test("malformed/future/duplicate/unsafe/oversized input remains byte-identical", async t => {
  const f = fixture(t); const base = JSON.stringify(defaults);
  for (const text of ["{", "[]", base.replace('"version":1', '"version":2'), base.replace('"revision":0', '"revision":0,"revision":0'), base.replace('"revision":0', '"revision":0,"\\u0072evision":0'), ...["1.0", "1e0", "9007199254740992", "-9007199254740992"].map(n => base.replace('"version":1', `"unknown":${n},"version":1`)), base.replace('"version":1', '"image":{"coverage":0.5},"version":1'), base.replace('"version":1', `"padding":"${"x".repeat(65536)}","version":1`), base.replace('"backgroundOpacity":55', '"backgroundOpacity":101'), base.replace('"transparentBackground":true', '"transparentBackground":false')]) {
    f.seed(text); const before = readFileSync(f.file);
    assert.equal((await readAppearance(f.options)).status, "invalid");
    assert.equal((await patchDesktopAppearance(f.options, 0, { backgroundOpacity: 60 })).status, "invalid");
    assert.deepEqual(readFileSync(f.file), before);
  }
  f.seed(base.replace('"revision":0', '"revision":9007199254740991'));
  const before = readFileSync(f.file);
  assert.equal((await patchDesktopAppearance(f.options, Number.MAX_SAFE_INTEGER, { backgroundOpacity: 60 })).status, "revision-exhausted");
  assert.deepEqual(readFileSync(f.file), before);
});
test("UTF-8 validity and outgoing cap are enforced without overwriting", async t => {
  const f = fixture(t);
  f.seed(new Uint8Array([0xff]));
  assert.equal((await readAppearance(f.options)).status, "invalid");
  assert.equal((await patchDesktopAppearance(f.options, 0, { backgroundOpacity: 60 })).status, "invalid");
  assert.deepEqual(readFileSync(f.file), Buffer.from([0xff]));
  const value = { ...defaults, revision: 9, padding: "" };
  value.padding = "x".repeat(65536 - Buffer.byteLength(JSON.stringify(value)));
  f.seed(JSON.stringify(value)); const before = readFileSync(f.file);
  assert.equal((await readAppearance(f.options)).status, "ready");
  assert.equal((await patchDesktopAppearance(f.options, 9, { backgroundOpacity: 60 })).status, "invalid");
  assert.deepEqual(readFileSync(f.file), before);
  assert.deepEqual((await readAppearance(f.options)).snapshot, value);
});
test("agent-dir precedence has no cwd fallback", () => {
  assert.equal(resolveAppearanceAgentDir({ agentDir: "/explicit", env: { PI_CODING_AGENT_DIR: "/env", HOME: "/home" } }), "/explicit");
  assert.equal(resolveAppearanceAgentDir({ env: { PI_CODING_AGENT_DIR: "/env" } }), "/env");
  assert.equal(resolveAppearanceAgentDir({ env: { HOME: "/home" } }), "/home/.pi/agent");
  for (const options of [{ agentDir: "" }, { agentDir: "relative" }, { env: { PI_CODING_AGENT_DIR: "", HOME: "/home" } }, { env: { PI_CODING_AGENT_DIR: "relative" } }, { env: {} }]) assert.throws(() => resolveAppearanceAgentDir(options));
});
test("symlink paths and unsafe files fail closed", async t => {
  const f = fixture(t); f.seed(JSON.stringify(defaults));
  chmodSync(f.file, 0o666);
  assert.equal((await readAppearance(f.options)).status, "unsafe-path");
  assert.equal((await patchDesktopAppearance(f.options, 0, { backgroundOpacity: 60 })).status, "unsafe-path");
  chmodSync(f.file, 0o600);
  const alias = join(f.root, "alias"); symlinkSync(f.agentDir, alias);
  assert.equal((await readAppearance({ agentDir: alias })).status, "unsafe-path");
  const other = fixture(t); mkdirSync(other.dir, { recursive: true, mode: 0o700 }); symlinkSync(f.file, other.file);
  assert.equal((await readAppearance(other.options)).status, "unsafe-path");
  assert.equal((await patchDesktopAppearance(other.options, 0, { backgroundOpacity: 60 })).status, "unsafe-path");
  assert.deepEqual((await readAppearance(f.options)).snapshot, defaults);
});
test("existing lock times out without stealing or mutating", async t => {
  const f = fixture(t); f.seed(JSON.stringify(defaults));
  mkdirSync(`${f.file}.lock`, { mode: 0o700 }); const marker = join(`${f.file}.lock`, "owner");
  writeFileSync(marker, "v1:00000000000000000000000000000000\n", { mode: 0o600 });
  const before = readFileSync(f.file); const start = performance.now();
  assert.equal((await patchDesktopAppearance(f.options, 0, { backgroundOpacity: 60 })).status, "busy");
  assert.ok(performance.now() - start >= 1000);
  assert.equal(readFileSync(marker, "utf8"), "v1:00000000000000000000000000000000\n");
  assert.deepEqual(readFileSync(f.file), before); assert.deepEqual((await readAppearance(f.options)).snapshot, defaults);
});
