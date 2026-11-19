import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutputStateStore } from "../src/output_state.ts";

const DEFAULTS = { internal: false, debug: true, d200: false, display: false, usb: false };

test("local output defaults on and preserves each independent saved boolean", () => {
  const root = mkdtempSync(join(tmpdir(), "emote-output-state-"));
  const warnings: string[] = [];
  try {
    const first = new OutputStateStore(root);
    const second = new OutputStateStore(root);
    assert.deepEqual(first.load(message => warnings.push(message)), DEFAULTS);
    first.save("debug", false);
    assert.equal(second.load(message => warnings.push(message)).debug, false, "saved localOff wins over the new-install default");
    first.save("internal", true);
    second.save("display", true);
    first.save("debug", true);
    second.save("d200", true);
    first.save("display", false);
    assert.deepEqual(new OutputStateStore(root).load(message => warnings.push(message)), {
      internal: true, debug: true, d200: true, display: false, usb: false,
    });
    assert.deepEqual(warnings, []);
    const dir = join(root, "extensions", "gentle-emote", "output-states");
    assert.deepEqual(readdirSync(dir).sort(), ["d200.json", "debug.json", "display.json", "internal.json"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("malformed local preference stays off instead of using the missing-file default", () => {
  const root = mkdtempSync(join(tmpdir(), "emote-local-invalid-"));
  const dir = join(root, "extensions", "gentle-emote", "output-states");
  mkdirSync(dir, { recursive: true });
  try {
    const store = new OutputStateStore(root);
    for (const text of ["{broken", "null", '"true"', "0"]) {
      writeFileSync(join(dir, "debug.json"), text);
      const warnings: string[] = [];
      assert.equal(store.load(message => warnings.push(message)).debug, false);
      assert.deepEqual(warnings, ["cannot read saved debug state; output stays off"]);
      assert.throws(() => store.save("debug", true));
      assert.equal(readFileSync(join(dir, "debug.json"), "utf8"), text);
      assert.deepEqual(readdirSync(dir), ["debug.json"]);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("invalid or unreadable saved output state fails closed and is not overwritten", () => {
  const root = mkdtempSync(join(tmpdir(), "emote-output-invalid-"));
  const dir = join(root, "extensions", "gentle-emote", "output-states");
  mkdirSync(dir, { recursive: true });
  try {
    const store = new OutputStateStore(root);
    for (const text of ["{broken", "null", "1", '"true"']) {
      writeFileSync(join(dir, "display.json"), text);
      const warnings: string[] = [];
      assert.deepEqual(store.load(message => warnings.push(message)), DEFAULTS);
      assert.deepEqual(warnings, ["cannot read saved display state; output stays off"]);
      assert.throws(() => store.save("display", true));
      assert.equal(readFileSync(join(dir, "display.json"), "utf8"), text);
      assert.deepEqual(readdirSync(dir), ["display.json"], "no partial write or temporary remains");
    }
    rmSync(join(dir, "display.json"));
    mkdirSync(join(dir, "display.json"));
    const warnings: string[] = [];
    assert.deepEqual(store.load(message => warnings.push(message)), DEFAULTS);
    assert.equal(warnings.length, 1);
    assert.throws(() => store.save("display", true));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
