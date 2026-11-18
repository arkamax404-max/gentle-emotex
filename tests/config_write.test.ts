import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePanelConfig, validatePanelConfigValue, PANEL_CONFIG_KEYS } from "../src/config_write.ts";

function workspace(): { root: string; file: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "emote-config-write-"));
  const dir = join(root, "extensions", "gentle-emote");
  mkdirSync(dir, { recursive: true });
  return { root, file: join(dir, "config.json"), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("a panel key is written atomically and every other key survives", () => {
  const space = workspace();
  try {
    writeFileSync(space.file, JSON.stringify({
      enabled: true,
      size: 10,
      externalDisplay: { enabled: true, targets: [{ enabled: true, url: "http://127.0.0.1:8001/emote" }] },
    }));
    const before = JSON.parse(readFileSync(space.file, "utf8"));
    assert.deepEqual(writePanelConfig(space.root, "size", 12), { ok: true, error: null });
    const after = JSON.parse(readFileSync(space.file, "utf8"));
    assert.equal(after.size, 12, "the requested key changed");
    assert.deepEqual(after.externalDisplay, before.externalDisplay, "unrelated keys are preserved byte for byte");
    assert.equal(after.enabled, true);
    assert.ok(readFileSync(space.file, "utf8").endsWith("}\n"), "the file keeps a trailing newline");
    assert.deepEqual(readdirSync(join(space.root, "extensions", "gentle-emote")), ["config.json"], "no temporary file is left behind");
  } finally { space.cleanup(); }
});

test("a missing configuration is created with only the requested key", () => {
  const space = workspace();
  try {
    assert.equal(existsSync(space.file), false);
    assert.deepEqual(writePanelConfig(space.root, "frame", false), { ok: true, error: null });
    assert.deepEqual(JSON.parse(readFileSync(space.file, "utf8")), { frame: false });
  } finally { space.cleanup(); }
});

test("only the whitelisted appearance keys are accepted", () => {
  assert.deepEqual([...PANEL_CONFIG_KEYS], ["size", "placement", "frame", "accent"]);
  const space = workspace();
  try {
    writeFileSync(space.file, JSON.stringify({ enabled: true }));
    const before = readFileSync(space.file, "utf8");
    for (const key of ["enabled", "emotes", "externalDisplay", "sizee", "toString"]) {
      const result = writePanelConfig(space.root, key as never, 1);
      assert.equal(result.ok, false, `${key} is refused`);
      assert.equal(result.error, "unsupported configuration key");
    }
    assert.equal(readFileSync(space.file, "utf8"), before, "a refused key never touches the file");
  } finally { space.cleanup(); }
});

test("invalid values are refused per key, and valid ones are accepted", () => {
  for (const [key, value] of [["size", 3], ["size", 25], ["size", 10.5], ["size", "10"], ["size", null]] as const) {
    assert.equal(validatePanelConfigValue(key, value), "invalid size", `${key}=${String(value)}`);
  }
  for (const size of [4, 10, 24]) assert.equal(validatePanelConfigValue("size", size), null);
  for (const value of ["left", "ABOVE", "", null, 1]) assert.equal(validatePanelConfigValue("placement", value), "invalid placement");
  for (const value of ["beside-editor", "above-editor"]) assert.equal(validatePanelConfigValue("placement", value), null);
  for (const value of ["yes", 1, null, 0]) assert.equal(validatePanelConfigValue("frame", value), "invalid frame");
  for (const value of [true, false]) assert.equal(validatePanelConfigValue("frame", value), null);
  for (const value of ["purple", "#12345", "#GGGGGG", "", null, 3]) assert.equal(validatePanelConfigValue("accent", value), "invalid accent");
  for (const value of ["auto", "pink", "cyan", "yellow", "green", "#a1b2c3"]) assert.equal(validatePanelConfigValue("accent", value), null);

  const space = workspace();
  try {
    writeFileSync(space.file, JSON.stringify({ size: 10 }));
    const before = readFileSync(space.file, "utf8");
    assert.deepEqual(writePanelConfig(space.root, "size", 99), { ok: false, error: "invalid size" });
    assert.equal(readFileSync(space.file, "utf8"), before, "an invalid value never writes");
  } finally { space.cleanup(); }
});

test("an unreadable or non-object configuration fails closed and is left untouched", () => {
  const space = workspace();
  try {
    for (const content of ["{ not json", "[]", "null", '"text"', "42"]) {
      writeFileSync(space.file, content);
      const result = writePanelConfig(space.root, "size", 12);
      assert.equal(result.ok, false, `${content} is refused`);
      assert.equal(result.error, "cannot read configuration");
      assert.equal(readFileSync(space.file, "utf8"), content, "the file is untouched");
    }
  } finally { space.cleanup(); }
});

test("a write failure reports an error instead of claiming success", () => {
  const root = mkdtempSync(join(tmpdir(), "emote-config-readonly-"));
  try {
    // A directory where the file should be makes every write fail.
    mkdirSync(join(root, "extensions", "gentle-emote", "config.json"), { recursive: true });
    const result = writePanelConfig(root, "size", 12);
    assert.equal(result.ok, false);
    // A directory where the file belongs is an unreadable configuration, so the
    // writer must refuse instead of claiming success either way.
    assert.match(result.error ?? "", /cannot (read|write) configuration/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
