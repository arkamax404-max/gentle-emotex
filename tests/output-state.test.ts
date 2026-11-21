import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutputStateStore } from "../src/output_state.ts";

test("the d200 state is session-local: never loaded, never saved, legacy bytes ignored untouched", () => {
  const root = mkdtempSync(join(tmpdir(), "emote-d200-session-local-"));
  const dir = join(root, "extensions", "gentle-emote", "output-states");
  mkdirSync(dir, { recursive: true });
  try {
    // A legacy preference left behind by an older version: true, false or corrupt,
    // it is never read, never warned about and never rewritten.
    const legacy = join(dir, "d200.json");
    for (const text of ["true\n", "false\n", "{broken"]) {
      writeFileSync(legacy, text);
      const store = new OutputStateStore(root);
      const warnings: string[] = [];
      assert.equal(store.load(message => warnings.push(message)).d200, false, `${JSON.stringify(text)}: the legacy preference is ignored`);
      assert.deepEqual(warnings, [], `${JSON.stringify(text)}: the unused d200 preference never warns`);
      assert.equal(readFileSync(legacy, "utf8"), text, `${JSON.stringify(text)}: the legacy bytes stay untouched`);
      assert.throws(() => store.save("d200", true), `${JSON.stringify(text)}: saving the session-local state is refused`);
      assert.equal(readFileSync(legacy, "utf8"), text, `${JSON.stringify(text)}: a refused save leaves the bytes untouched`);
    }
    // Sibling persistence is unchanged: display still saves and restores normally.
    const store = new OutputStateStore(root);
    store.save("display", true);
    assert.equal(new OutputStateStore(root).load(() => {}).display, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

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
    first.save("display", false);
    // The d200 state is session-local: no d200.json is ever written, and load
    // always reports it off.
    assert.deepEqual(new OutputStateStore(root).load(message => warnings.push(message)), {
      internal: true, debug: true, d200: false, display: false, usb: false,
    });
    assert.deepEqual(warnings, []);
    const dir = join(root, "extensions", "gentle-emote", "output-states");
    assert.deepEqual(readdirSync(dir).sort(), ["debug.json", "display.json", "internal.json"]);
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
