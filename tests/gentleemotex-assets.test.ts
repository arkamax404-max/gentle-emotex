import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { avatarNames, findAvatar } from "../src/avatar_selection.ts";
import { decodePng } from "../src/png.ts";

const ROOT = join(import.meta.dirname, "..");
const SET = join(ROOT, "emotes", "gentleemotex");

const EXPECTED_FILES = [
  "ask/ask_1.png",
  "ask/ask_2.png",
  "build/build_1.png",
  "build/build_2.png",
  "build/build_3.png",
  "bye/bye_1.png",
  "bye/bye_2.png",
  "bye/in_1.png",
  "bye/in_2.png",
  "compact/compact_1.png",
  "compact/compact_2.png",
  "compact/compact_3.png",
  "delegate/delegate_1.png",
  "delegate/delegate_2.png",
  "delegate/delegate_3.png",
  "emotes.json",
  "explore/explore_1.png",
  "explore/explore_2.png",
  "explore/explore_3.png",
  "failure/failure_1.png",
  "failure/failure_2.png",
  "failure/failure_3.png",
  "grandma/in_1.png",
  "grandma/in_2.png",
  "grandma/in_3.png",
  "grandma/knit_1.png",
  "grandma/knit_2.png",
  "grandma_old/in_1.png",
  "grandma_old/in_2.png",
  "grandma_old/in_3.png",
  "grandma_old/knit_1.png",
  "grandma_old/knit_2.png",
  "hi/in_1.png",
  "hi/in_2.png",
  "hi/in_3.png",
  "hi/in_4.png",
  "hi/in_5.png",
  "hi/in_6.png",
  "hi/landed_1.png",
  "hi/landed_2.png",
  "idle/idle.png",
  "idle/idle_blink.png",
  "jira/jira_1.png",
  "jira/jira_2.png",
  "jira/jira_3.png",
  "jobs/jobs_1.png",
  "jobs/jobs_2.png",
  "jobs/jobs_3.png",
  "judge/judge_1.png",
  "judge/judge_2.png",
  "read/read_1.png",
  "read/read_2.png",
  "read/read_3.png",
  "remember/remember_1.png",
  "remember/remember_2.png",
  "review/review_1.png",
  "review/review_2.png",
  "review/review_3.png",
  "review/review_4.png",
  "success/success_1.png",
  "success/success_2.png",
  "super-yolo/super-yolo.png",
  "super-yolo/super-yolo_blink.png",
  "talk/talk_close.png",
  "talk/talk_mid.png",
  "talk/talk_small.png",
  "talk/talk_wide.png",
  "think/think_1.png",
  "think/think_2.png",
  "tool/tool_1.png",
  "tool/tool_2.png",
  "tool/tool_3.png",
  "verify/fail.png",
  "verify/verify_1.png",
  "verify/verify_2.png",
  "verify/verify_3.png",
  "write/write_1.png",
  "write/write_2.png",
  "write/write_3.png",
  "write/write_4.png",
  "yolo/yolo.png",
  "yolo/yolo_blink.png",
];

function collect(set: string): string[] {
  const files: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else files.push(rel);
    }
  };
  walk(set, "");
  return files.sort();
}

test("the imported gentleemotex set is discoverable through the public avatar selection", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gentleemotex-assets-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = join(root, "profile");
    const cwd = join(root, "project");
    assert.equal(findAvatar("gentleemotex", ROOT, cwd), SET,
      "the repository emotes layer exposes the set for /emote avatar gentleemotex");
    assert.ok(avatarNames(ROOT, cwd).includes("gentleemotex"), "tab completion lists the set");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("the imported gentleemotex set is complete: every frame decodes 48x40 with binary alpha", () => {
  const actual = collect(SET);
  assert.deepEqual(actual, EXPECTED_FILES, "the set keeps its exact imported inventory");
  assert.equal(actual.filter((file) => file.endsWith(".png")).length, 81);

  const stateDirs = readdirSync(SET, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  assert.deepEqual(stateDirs, [
    "ask", "build", "bye", "compact", "delegate", "explore", "failure", "grandma",
    "grandma_old", "hi", "idle", "jira", "jobs", "judge", "read", "remember",
    "review", "success", "super-yolo", "talk", "think", "tool", "verify", "write", "yolo",
  ], "grandma_old stays verbatim as an inert extra state");

  for (const file of actual) {
    if (!file.endsWith(".png")) continue;
    const png = decodePng(readFileSync(join(SET, file)));
    assert.deepEqual([png.width, png.height], [48, 40], file);
    for (let i = 3; i < png.data.length; i += 4) {
      assert.ok(png.data[i] === 0 || png.data[i] === 255, `binary alpha: ${file}`);
    }
  }

  const files = new Set(actual);
  const metadata = JSON.parse(readFileSync(join(SET, "emotes.json"), "utf8"));
  const references = [
    metadata.idle?.default, metadata.idle?.blink,
    ...Object.keys(metadata.talk?.weights ?? {}),
  ].filter((name) => typeof name === "string") as string[];
  assert.ok(references.length > 0, "emotes.json names its special frames");
  for (const name of references) {
    assert.ok(files.has(`idle/${name}`) || files.has(`talk/${name}`) || files.has(name),
      `emotes.json reference resolves: ${name}`);
  }
});
