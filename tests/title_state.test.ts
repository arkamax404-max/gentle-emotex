import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TitleStore, normalizeTitle } from "../src/title_state.ts";

test("title validation trims and mirrors the sender's project-name encoding", () => {
  assert.equal(normalizeTitle("  Mi Proyecto ñ  "), "Mi Proyecto ñ");
  assert.equal(normalizeTitle("mi repo ñ"), "mi repo ñ");
  assert.equal(normalizeTitle("v1.2"), "v1.2");
  assert.equal(normalizeTitle("日本語"), "日本語");
  assert.equal(normalizeTitle("a b (x)"), "a b (x)");
  assert.equal(normalizeTitle(null), null, "null is an explicit reset to the folder basename");
  for (const invalid of ["", "   ", 42, undefined, {}, [], true, "x".repeat(129), "a/b", "a\\b", ".", "..", "a\u0000b", "bad\u007f", "\ud800", "mi repo \ud800"]) {
    assert.equal(normalizeTitle(invalid), undefined, `invalid: ${JSON.stringify(invalid)}`);
  }
});

test("the title store persists one validated override per project and resets to null", () => {
  const root = mkdtempSync(join(tmpdir(), "emote-title-store-"));
  try {
    const store = new TitleStore(root);
    const warnings: string[] = [];
    assert.equal(store.load(message => warnings.push(message)), null, "no override without a file");
    assert.deepEqual(warnings, []);
    store.save("  Mi Proyecto ñ  ");
    assert.equal(store.load(() => { throw Error("no warning expected"); }), "Mi Proyecto ñ", "the saved title is trimmed");
    const dir = join(root, ".pi", "extensions", "gentle-emote");
    const file = join(dir, "title.json");
    assert.deepEqual(readdirSync(dir).sort(), ["title.json"], "no temporary file remains");
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { title: "Mi Proyecto ñ" });
    store.save(null);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { title: null }, "reset stores an explicit null");
    assert.equal(new TitleStore(root).load(() => {}), null, "reset restores the folder basename");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a second project keeps its own title override", () => {
  const root = mkdtempSync(join(tmpdir(), "emote-title-isolation-"));
  const a = join(root, "a");
  const b = join(root, "b");
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  try {
    new TitleStore(a).save("Alpha");
    assert.equal(new TitleStore(a).load(() => {}), "Alpha");
    assert.equal(new TitleStore(b).load(() => {}), null, "project b has no override");
    new TitleStore(b).save("Beta");
    assert.equal(new TitleStore(b).load(() => {}), "Beta");
    assert.equal(new TitleStore(a).load(() => {}), "Alpha", "project a is untouched");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("malformed stored overrides warn, fall back to the folder name and preserve the file", () => {
  const root = mkdtempSync(join(tmpdir(), "emote-title-malformed-"));
  const dir = join(root, ".pi", "extensions", "gentle-emote");
  mkdirSync(dir, { recursive: true });
  try {
    const store = new TitleStore(root);
    for (const text of ["{broken", "null", '"x"', "[]", "5", "{}", JSON.stringify({ title: 5 }), JSON.stringify({ title: "   " }), JSON.stringify({ title: "a/b" })]) {
      writeFileSync(join(dir, "title.json"), text);
      const warnings: string[] = [];
      assert.equal(store.load(message => warnings.push(message)), null);
      assert.deepEqual(warnings, ["cannot read saved title override; using the project folder name"]);
      assert.equal(readFileSync(join(dir, "title.json"), "utf8"), text, "the malformed file is preserved");
      rmSync(join(dir, "title.json"));
    }
    assert.deepEqual(readdirSync(dir), [], "no temporary file remains");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an unreadable title file warns and falls back; save validates its input", () => {
  const root = mkdtempSync(join(tmpdir(), "emote-title-unreadable-"));
  const dir = join(root, ".pi", "extensions", "gentle-emote");
  mkdirSync(join(dir, "title.json"), { recursive: true });
  try {
    const warnings: string[] = [];
    assert.equal(new TitleStore(root).load(message => warnings.push(message)), null);
    assert.deepEqual(warnings, ["cannot read saved title override; using the project folder name"]);
    assert.throws(() => new TitleStore(root).save("a/b"), "save rejects invalid titles");
    assert.throws(() => new TitleStore(root).save(42 as unknown as string), "save rejects non-string titles");
    assert.equal(readdirSync(dir).join(","), "title.json", "no temporary file remains");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
