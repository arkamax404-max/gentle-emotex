import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AvatarStateStore } from "../src/avatar_state.ts";

test("avatar preference is a global scalar, validates writes and preserves corrupt storage", () => {
  const root = mkdtempSync(join(tmpdir(), "avatar-state-"));
  try {
    const store = new AvatarStateStore(root);
    const path = join(root, "extensions", "gentle-emote", "avatar.json");
    assert.equal(store.load(assert.fail), null);
    store.save("my.avatar");
    assert.equal(readFileSync(path, "utf8"), '"my.avatar"\n');
    assert.equal(new AvatarStateStore(root).load(assert.fail), "my.avatar");
    assert.throws(() => store.save("../escape"));
    assert.equal(store.load(assert.fail), "my.avatar");
    store.save(null);
    assert.equal(readFileSync(path, "utf8"), "null\n");
    writeFileSync(path, "{broken");
    const warnings: string[] = [];
    assert.equal(store.load(message => warnings.push(message)), null);
    assert.deepEqual(warnings, ["cannot read saved avatar; using automatic selection"]);
    assert.throws(() => store.save("next"));
    assert.equal(readFileSync(path, "utf8"), "{broken");
    const other = new AvatarStateStore(join(root, "blocked"));
    mkdirSync(join(root, "blocked", "extensions", "gentle-emote", "avatar.json"), { recursive: true });
    assert.throws(() => other.save("next"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
