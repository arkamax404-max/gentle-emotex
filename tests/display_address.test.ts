import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDisplayAddress, persistGlobalDisplayTarget } from "../src/display_address.ts";

const configPath = (root: string) => join(root, "extensions", "gentle-emote", "config.json");

test("a host token becomes the exact /emote destination of the LED group", () => {
  assert.deepEqual(parseDisplayAddress("192.168.1.129"), { url: "http://192.168.1.129/emote", error: null });
  assert.deepEqual(parseDisplayAddress("  192.168.1.129  "), { url: "http://192.168.1.129/emote", error: null });
  assert.deepEqual(parseDisplayAddress("192.168.1.129:8080"), { url: "http://192.168.1.129:8080/emote", error: null });
  assert.deepEqual(parseDisplayAddress("192.168.1.129:80"), { url: "http://192.168.1.129/emote", error: null });
  assert.deepEqual(parseDisplayAddress("gentle-matrix.local"), { url: "http://gentle-matrix.local/emote", error: null });
  assert.deepEqual(parseDisplayAddress("[fd00::1]"), { url: "http://[fd00::1]/emote", error: null });
});

test("only a bare host is accepted: no scheme, path, credentials, query or fragment", () => {
  for (const input of ["http://192.168.1.129/emote", "192.168.1.129/emote", "user@192.168.1.129", "192.168.1.129?x=1", "192.168.1.129#frame", "192.168.1.129 8000", "192.168.1.129:99999"]) {
    const parsed = parseDisplayAddress(input);
    assert.equal(parsed.url, null, input);
    assert.equal(parsed.error, "invalid display address", input);
  }
  // No argument and a whitespace-only argument are the same missing address, not
  // two different failures: the parser reports one bounded message per cause.
  for (const empty of ["", "   ", "\t"]) assert.deepEqual(parseDisplayAddress(empty), { url: null, error: "missing display address" }, JSON.stringify(empty));
});

test("loopback addresses point at the local group and are refused here", () => {
  for (const input of ["127.0.0.1", "localhost", "127.5.5.5", "[::1]"]) {
    assert.deepEqual(parseDisplayAddress(input), { url: null, error: "loopback addresses belong to /emote localOn" }, input);
  }
});

test("the global write keeps every other key and the loopback destination", () => {
  const root = mkdtempSync(join(tmpdir(), "emote-display-address-"));
  try {
    mkdirSync(join(root, "extensions", "gentle-emote"), { recursive: true });
    writeFileSync(configPath(root), JSON.stringify({
      enabled: true,
      size: 10,
      emotes: [{ model: "*", "emote-set": "gentleman-ascii" }],
      externalDisplay: { enabled: true, url: "http://127.0.0.1:8000/emote", timeoutMs: 1500 },
    }, null, 2));
    const result = persistGlobalDisplayTarget("http://192.168.1.129/emote", root);
    assert.equal(result.ok, true, result.error ?? undefined);
    assert.equal(result.loopbackPreserved, 1);
    assert.deepEqual(JSON.parse(readFileSync(configPath(root), "utf8")), {
      enabled: true,
      size: 10,
      emotes: [{ model: "*", "emote-set": "gentleman-ascii" }],
      externalDisplay: {
        enabled: true,
        timeoutMs: 1500,
        targets: [
          { enabled: true, url: "http://127.0.0.1:8000/emote" },
          { enabled: true, url: "http://192.168.1.129/emote" },
        ],
      },
    });
    assert.deepEqual(readdirSync(join(root, "extensions", "gentle-emote")), ["config.json"], "no temporary file survives");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("existing non-loopback targets are replaced, never accumulated", () => {
  const root = mkdtempSync(join(tmpdir(), "emote-display-replace-"));
  try {
    mkdirSync(join(root, "extensions", "gentle-emote"), { recursive: true });
    writeFileSync(configPath(root), JSON.stringify({
      externalDisplay: {
        enabled: true,
        url: "http://192.168.1.50/emote",
        targets: [
          { enabled: true, url: "http://127.0.0.1:8000/emote" },
          { enabled: true, url: "http://192.168.1.50/emote" },
          { enabled: true, url: "http://192.168.1.51/emote", transparentBackground: true },
        ],
      },
    }, null, 2));
    const first = persistGlobalDisplayTarget("http://192.168.1.129/emote", root);
    assert.equal(first.ok, true, first.error ?? undefined);
    assert.equal(first.loopbackPreserved, 1);
    const second = persistGlobalDisplayTarget("http://192.168.1.130/emote", root);
    assert.equal(second.ok, true, second.error ?? undefined);
    assert.deepEqual(JSON.parse(readFileSync(configPath(root), "utf8")).externalDisplay, {
      enabled: true,
      targets: [
        { enabled: true, url: "http://127.0.0.1:8000/emote" },
        { enabled: true, url: "http://192.168.1.130/emote" },
      ],
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a missing global config is created and an unreadable one is never overwritten", () => {
  const root = mkdtempSync(join(tmpdir(), "emote-display-fresh-"));
  try {
    const created = persistGlobalDisplayTarget("http://192.168.1.129/emote", root);
    assert.equal(created.ok, true, created.error ?? undefined);
    assert.equal(created.loopbackPreserved, 0);
    assert.deepEqual(JSON.parse(readFileSync(configPath(root), "utf8")), {
      externalDisplay: { targets: [{ enabled: true, url: "http://192.168.1.129/emote" }] },
    });

    for (const text of ["{broken", "[]", "null", "42"]) {
      writeFileSync(configPath(root), text);
      const result = persistGlobalDisplayTarget("http://192.168.1.129/emote", root);
      assert.equal(result.ok, false, text);
      assert.equal(result.error, "cannot read the global config", text);
      assert.equal(readFileSync(configPath(root), "utf8"), text, "the user's file is preserved byte-for-byte");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
