import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { avatarNames, findAvatar, validAvatarName } from "../src/avatar_selection.ts";
import { encodePng } from "../src/png.ts";

test("direct avatar lookup is layered, deterministic, bounded and requires usable idle frames", (t) => {
  const root = mkdtempSync(join(tmpdir(), "avatar-selection-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "profile");
  const ext = join(root, "ext"), cwd = join(root, "project");
  const project = join(cwd, ".pi", "extensions", "gentle-emote", "emotes");
  const user = join(process.env.PI_CODING_AGENT_DIR, "extensions", "gentle-emote", "emotes");
  const shipped = join(ext, "emotes");
  const make = (base: string, name: string) => {
    const dir = join(base, name); mkdirSync(join(dir, "idle"), { recursive: true });
    writeFileSync(join(dir, "idle", "idle.png"), encodePng({ width: 1, height: 1, data: new Uint8Array([0, 0, 0, 255]) }));
    return dir;
  };
  try {
    make(shipped, "z"); make(user, "same"); const preferred = make(project, "same"); make(shipped, "my.avatar");
    mkdirSync(join(project, "empty"), { recursive: true });
    const partial = join(project, "partial");
    mkdirSync(join(partial, "read"), { recursive: true });
    writeFileSync(join(partial, "read", "read.png"), encodePng({ width: 1, height: 1, data: new Uint8Array([0, 0, 0, 255]) }));
    assert.equal(findAvatar("partial", ext, cwd), null, "manual lookup remains idle-only");
    assert.equal(findAvatar("partial", ext, cwd, "automatic-partial"), partial);
    assert.equal(findAvatar("same", ext, cwd, "automatic-partial"), preferred);
    assert.equal(findAvatar("empty", ext, cwd, "automatic-partial"), null);
    mkdirSync(join(project, "broken", "idle"), { recursive: true });
    writeFileSync(join(project, "broken", "idle", "idle.png"), "not png");
    for (const name of ["auto", "", ".", "..", "../z", "a/b", "a\\b", "C:foo", "/abs", "a\u0000b", "a\u0085b"]) {
      assert.equal(validAvatarName(name), false, name);
      assert.equal(findAvatar(name, ext, cwd), null, name);
      assert.equal(findAvatar(name, ext, cwd, "automatic-partial"), null, name);
    }
    const dotted = make(project, "foo..bar");
    assert.equal(validAvatarName("foo..bar"), true);
    assert.equal(findAvatar("foo..bar", ext, cwd), dotted);
    assert.equal(validAvatarName("my.avatar"), true);
    assert.equal(findAvatar("same", ext, cwd), preferred);
    assert.equal(findAvatar("missing", ext, cwd), null);
    assert.equal(findAvatar("empty", ext, cwd), null);
    assert.equal(findAvatar("broken", ext, cwd, "automatic-partial"), null);
    assert.deepEqual(avatarNames(ext, cwd), ["foo..bar", "my.avatar", "same", "z"]);
    // Every file the loaders could read is checked, even when idle itself is safe.
    const outside = make(join(root, "outside"), "escape");
    try { symlinkSync(outside, join(project, "escape"), "junction"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") { t.diagnostic("symlink permission unavailable"); return; } throw error; }
    assert.equal(findAvatar("escape", ext, cwd), null);
    assert.equal(findAvatar("escape", ext, cwd, "automatic-partial"), null);
    symlinkSync(preferred, join(project, "internal-link"), "junction");
    assert.equal(findAvatar("internal-link", ext, cwd), join(project, "internal-link"), "child links within the emotes tree remain permitted");
    symlinkSync(join(outside, "idle"), join(preferred, "read"), "junction");
    assert.equal(findAvatar("same", ext, cwd), null, "unsafe higher priority shadow cannot fall through");
    assert.equal(findAvatar("same", ext, cwd, "automatic-partial"), null, "automatic shadow cannot fall through either");
    const config = make(project, "config-escape");
    try {
      symlinkSync(join(outside, "idle", "idle.png"), join(config, "emotes.json"), "file");
      assert.equal(findAvatar("config-escape", ext, cwd), null);
      assert.equal(findAvatar("config-escape", ext, cwd, "automatic-partial"), null);
      const frame = make(project, "frame-escape");
      symlinkSync(join(outside, "idle", "idle.png"), join(frame, "idle", "other.png"), "file");
      assert.equal(findAvatar("frame-escape", ext, cwd), null);
      assert.equal(findAvatar("frame-escape", ext, cwd, "automatic-partial"), null);
      symlinkSync(join(outside, "idle", "idle.png"), join(partial, "read", "other.png"), "file");
      assert.equal(findAvatar("partial", ext, cwd, "automatic-partial"), null, "partial layouts still validate every frame");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      t.diagnostic("file symlinks unavailable (EPERM); directory junction escape checks passed");
    }
    assert.equal(validAvatarName("my.avatar"), true);
    for (const name of ["auto", ".", "..", "a/b", "a\\b", "C:foo", "a\u0001b"]) assert.equal(validAvatarName(name), false);
    symlinkSync(join(root, "outside"), join(shipped, "linked-root"), "junction");
    assert.ok(!avatarNames(ext, cwd).includes("escape"));
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("an emotes root junction to a sibling is rejected by lookup and completion", (t) => {
  const root = mkdtempSync(join(tmpdir(), "avatar-root-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "profile");
  const ext = join(root, "ext");
  const sibling = join(ext, "sibling");
  mkdirSync(join(sibling, "safe", "idle"), { recursive: true });
  writeFileSync(join(sibling, "safe", "idle", "idle.png"), encodePng({ width: 1, height: 1, data: new Uint8Array([0, 0, 0, 255]) }));
  try {
    try { symlinkSync(sibling, join(ext, "emotes"), "junction"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      t.skip("junction permissions unavailable"); return;
    }
    assert.equal(findAvatar("safe", ext, join(root, "project")), null);
    assert.equal(findAvatar("safe", ext, join(root, "project"), "automatic-partial"), null);
    assert.deepEqual(avatarNames(ext, join(root, "project")), []);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
