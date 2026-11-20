import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Animator } from "../src/animator.ts";
import { prepareDisplayImage } from "../src/display_image.ts";
import { drawDisplayText } from "../src/display_text.ts";
import { decodePng, encodePng } from "../src/png.ts";
import { installNetworkGuard } from "./helpers/network.ts";
import { boot } from "./helpers/boot.ts";

const SUBAGENT_CHANNEL = "gentle-pi:notification:source";
const SESSION_ID = "integration-session";

// --- Unit-level config ---

const config = {
  enabled: true, debug: false, size: 10, placement: "beside-editor" as const, frame: true, frameRows: 4, minEditorWidth: 40, readingSpeed: 4,
  holdDuration: { hi: 1000, success: 1000, failure: 1000, bye: 1000 },
  blinkInterval: [60_000, 60_000] as [number, number], talkTickMs: 120, cycleMs: 100, grandmaAfterMs: 1000,
  accent: "auto" as const, farewellPattern: "^chau", emotes: [], terminals: [],
};

function fakeRenderer(files: Partial<Record<string, string[]>>) {
  const shown: string[] = [];
  return {
    shown,
    setTui() {}, loadFrames() {}, getRenderedFrame: () => null, dispose() {}, resetCache() {},
    getFrameFiles: (state: string) => files[state] ?? [],
    showFrame: (state: string, name: string) => { shown.push(`${state}/${name}`); return true; },
    showRandomFrame: () => true, showTalkFrame: () => true, showTalkCloseFrame: () => true,
    showCycleFrame: () => true, getCycleFrameCount: () => 0,
  };
}

// --- Animator: known subagent activity suppresses the grandma ---

test("a known active subagent suppresses the grandma while the parent rests", () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  try {
    const renderer = fakeRenderer({ idle: ["idle.png"], grandma: ["knit_1.png"] });
    const animator = new Animator(config, renderer as any);
    animator.transitionTo("idle");
    // The suppression lands while the grandma timer is already running.
    mock.timers.tick(500);
    animator.setSubagentActive(true);
    mock.timers.tick(10_000);
    assert.equal(animator.currentState, "idle", "no grandma while a subagent is known to run");
    // Deactivation restarts the resting timeout from that moment.
    animator.setSubagentActive(false);
    mock.timers.tick(999);
    assert.equal(animator.currentState, "idle");
    mock.timers.tick(1);
    assert.equal(animator.currentState, "grandma");
    animator.stop();
  } finally {
    mock.timers.reset();
  }
});

test("subagent activity wakes an already transformed grandma", () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  try {
    const renderer = fakeRenderer({ idle: ["idle.png"], grandma: ["knit_1.png"] });
    const animator = new Animator(config, renderer as any);
    animator.transitionTo("idle");
    mock.timers.tick(1_000);
    assert.equal(animator.currentState, "grandma");
    animator.setSubagentActive(true);
    // A count update publishes an idle activity; the resting pose returns.
    animator.transitionTo("idle");
    mock.timers.tick(10_000);
    assert.equal(animator.currentState, "idle");
    animator.stop();
  } finally {
    mock.timers.reset();
  }
});

test("the parent's own idle behavior without subagents is unchanged", () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  try {
    const renderer = fakeRenderer({ idle: ["idle.png"], grandma: ["knit_1.png"] });
    const animator = new Animator(config, renderer as any);
    animator.setSubagentActive(false);
    animator.transitionTo("idle");
    mock.timers.tick(999);
    assert.equal(animator.currentState, "idle");
    mock.timers.tick(1);
    assert.equal(animator.currentState, "grandma");
    animator.stop();
  } finally {
    mock.timers.reset();
  }
});

// --- Display labels: exactly one child reads SUBAGENT / RUNNING ---

const statusRow = (image: ReturnType<typeof decodePng>) => image.data.slice(44 * 64 * 4, 49 * 64 * 4);
const phaseRow = (image: ReturnType<typeof decodePng>) => image.data.slice(54 * 64 * 4, 59 * 64 * 4);
const referenceRow = (top: number, text: string, color: readonly number[] | ((index: number) => readonly number[])) => {
  const data = new Uint8Array(64 * 64 * 4);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  drawDisplayText(data, text, top, color);
  return data.slice(top * 64 * 4, (top + 5) * 64 * 4);
};

test("one resting parent with one child reads SUBAGENT and RUNNING without inventing a phase", () => {
  const base64 = encodePng({ width: 1, height: 1, data: new Uint8Array([0, 0, 0, 255]) }).toString("base64");
  for (const [status, color] of [["idle", [128, 224, 160]], ["error", [255, 96, 96]]] as const) {
    const image = decodePng(prepareDisplayImage(base64, { status, phase: "idle", activeSubagents: 1, state: "idle" }));
    assert.deepEqual(statusRow(image), referenceRow(44, "SUBAGENT", color), `${status} row spells SUBAGENT without a count`);
    assert.deepEqual(phaseRow(image), referenceRow(54, "RUNNING", [238, 238, 238]), `${status} phase row spells RUNNING`);
  }
  // A busy parent keeps its own labels and count; no invented child phase.
  const busy = decodePng(prepareDisplayImage(base64, { status: "busy", phase: "executing", activeSubagents: 1, state: "read" }));
  assert.deepEqual(statusRow(busy), referenceRow(44, "busy (1)", index => index > 4 ? [255, 255, 0] : [255, 208, 96]));
  assert.deepEqual(phaseRow(busy), referenceRow(54, "READING", [238, 238, 238]));
});

test("several running children keep the generic SUBAGENTS treatment with the count", () => {
  const base64 = encodePng({ width: 1, height: 1, data: new Uint8Array([0, 0, 0, 255]) }).toString("base64");
  const image = decodePng(prepareDisplayImage(base64, { status: "idle", phase: "idle", activeSubagents: 2, state: "idle" }));
  assert.deepEqual(statusRow(image), referenceRow(44, "SUBAGENTS (2)", index => index > "SUBAGENTS".length ? [255, 255, 0] : [128, 224, 160]));
  assert.deepEqual(phaseRow(image), referenceRow(54, "RUNNING", [238, 238, 238]));
});

// --- End-to-end: the dedicated child avatar swaps in and out ---

const png = () => encodePng({ width: 1, height: 1, data: new Uint8Array([0, 0, 0, 255]) });
const subagentEvent = (status: string, sequence: number, overrides: Record<string, unknown> = {}) => ({
  source: "subagent", producerId: "producer-1", sessionId: SESSION_ID, parentSessionId: SESSION_ID,
  taskId: "t1", runId: "producer-1:run-1", status, event: `subagent.${status}`, sequence, occurredAt: 5, ...overrides,
});

type Lab = Awaited<ReturnType<typeof boot>>;
const header = (init: RequestInit, name: string) => new Headers(init.headers).get(name);
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function sceneLab(root: string, config: Record<string, unknown>) {
  const dir = join(root, ".pi", "extensions", "gentle-emote");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    externalDisplay: { enabled: true, url: "http://127.0.0.1:8000/emote" },
    ...config,
  }));
  const lab = await boot(root);
  return lab;
}

test("one known child swaps the resting parent to the dedicated avatar and back — nothing persists", async () => {
  const originalFetch = globalThis.fetch;
  const calls: RequestInit[] = [];
  globalThis.fetch = async (_url, init) => { calls.push(init!); return new Response(); };
  const root = mkdtempSync(join(tmpdir(), "emote-subagent-scene-"));
  let lab: Lab | undefined;
  try {
    // A custom set so the child avatar can never be confused with the parent's.
    const dir = join(root, ".pi", "extensions", "gentle-emote");
    for (const state of ["idle", "read"]) {
      mkdirSync(join(dir, "emotes", "custom", state), { recursive: true });
      writeFileSync(join(dir, "emotes", "custom", state, `${state}.png`), png());
    }
    lab = await sceneLab(root, {
      emotes: [{ model: "*", "emote-set": "custom" }],
      holdDuration: { hi: 5, success: 5, failure: 5, bye: 5 },
      grandmaAfterMs: 40,
    });
    // The startup greeting settles before the baseline: the parent's own resting frame.
    await wait(700);
    await lab.emit("agent_end");
    await wait(30);
    assert.equal(header(calls.at(-1)!, "X-Emote-Set"), "custom");
    assert.equal(header(calls.at(-1)!, "X-Emote-State"), "idle");
    assert.equal(header(calls.at(-1)!, "X-Emote-Active-Subagents"), "0");

    // One (and only one) known child swaps the resting avatar to the child set.
    lab.emitBus(SUBAGENT_CHANNEL, subagentEvent("queued", 1));
    await wait(30);
    assert.equal(header(calls.at(-1)!, "X-Emote-Set"), "gentleled", "the dedicated child avatar is shown at rest");
    assert.equal(header(calls.at(-1)!, "X-Emote-State"), "idle");
    assert.equal(header(calls.at(-1)!, "X-Emote-Active-Subagents"), "1");
    await lab.emit("agent_end");
    await wait(60);
    assert.equal(header(calls.at(-1)!, "X-Emote-Set"), "gentleled", "the scene survives the turn boundary while the child runs");
    assert.equal(header(calls.at(-1)!, "X-Emote-Active-Subagents"), "1");

    // The parent's own work restores its own avatar immediately.
    await lab.emit("tool_execution_start", { toolName: "read", toolCallId: "r1" });
    await wait(30);
    assert.equal(header(calls.at(-1)!, "X-Emote-Set"), "custom", "parent work restores the primary avatar");
    assert.equal(header(calls.at(-1)!, "X-Emote-State"), "read");

    // At rest again with the child still running, the scene is back.
    await lab.emit("agent_end");
    await wait(60);
    assert.equal(header(calls.at(-1)!, "X-Emote-Set"), "gentleled");
    assert.equal(header(calls.at(-1)!, "X-Emote-State"), "idle");

    // The child finishes: the parent's avatar and rest timing return.
    lab.emitBus(SUBAGENT_CHANNEL, subagentEvent("completed", 5));
    await wait(30);
    assert.equal(header(calls.at(-1)!, "X-Emote-Set"), "custom", "count zero restores the parent selection");
    assert.equal(header(calls.at(-1)!, "X-Emote-State"), "idle");

    // Nothing was enabled or persisted to display the child.
    assert.equal(existsSync(join(lab.ctx.cwd, "avatar.json")), false);
    assert.ok(!lab.notices.some(notice => notice.level === "error"));
  } finally {
    await lab?.shutdown();
    lab?.restore();
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test("the grandma stays suppressed while a child runs and returns after it finishes", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response();
  const calls: RequestInit[] = [];
  globalThis.fetch = async (_url, init) => { calls.push(init!); return new Response(); };
  const root = mkdtempSync(join(tmpdir(), "emote-subagent-grandma-"));
  let lab: Lab | undefined;
  try {
    const dir = join(root, ".pi", "extensions", "gentle-emote");
    mkdirSync(join(dir, "emotes", "custom", "idle"), { recursive: true });
    writeFileSync(join(dir, "emotes", "custom", "idle", "idle.png"), png());
    mkdirSync(join(dir, "emotes", "custom", "grandma"), { recursive: true });
    writeFileSync(join(dir, "emotes", "custom", "grandma", "knit.png"), png());
    lab = await sceneLab(root, {
      emotes: [{ model: "*", "emote-set": "custom" }],
      holdDuration: { hi: 5, success: 5, failure: 5, bye: 5 },
      grandmaAfterMs: 40,
    });
    await wait(700);
    await lab.emit("agent_end");
    await wait(30);
    lab.emitBus(SUBAGENT_CHANNEL, subagentEvent("queued", 1));
    await wait(200);
    await lab.commands.get("emote").handler("status", lab.ctx);
    assert.match(lab.notices.at(-1)!.message, /PNG state=idle frame=idle\.png set=gentleled/,
      "no grandma while one child is known to run");
    lab.emitBus(SUBAGENT_CHANNEL, subagentEvent("completed", 2));
    await wait(200);
    await lab.commands.get("emote").handler("status", lab.ctx);
    assert.match(lab.notices.at(-1)!.message, /PNG state=grandma .*set=custom/,
      "the parent's rest timing (grandma) returns when the count reaches zero");
  } finally {
    await lab?.shutdown();
    lab?.restore();
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test("default child selection: gentleled, or gentleman when gentleled is the parent", async () => {
  const originalFetch = globalThis.fetch;
  const calls: RequestInit[] = [];
  let lab: Lab | undefined;
  const root = mkdtempSync(join(tmpdir(), "emote-subagent-default-"));
  globalThis.fetch = async (_url, init) => { calls.push(init!); return new Response(); };
  try {
    const dir = join(root, ".pi", "extensions", "gentle-emote");
    mkdirSync(join(dir, "emotes", "custom", "idle"), { recursive: true });
    writeFileSync(join(dir, "emotes", "custom", "idle", "idle.png"), png());
    lab = await sceneLab(root, { emotes: [{ model: "*", "emote-set": "custom" }] });
    await lab.emit("agent_end");
    lab.emitBus(SUBAGENT_CHANNEL, subagentEvent("queued", 1));
    await wait(30);
    assert.equal(header(calls.at(-1)!, "X-Emote-Set"), "gentleled", "the shipped gentleled set is the default child");
    await lab.shutdown(); lab.restore(); calls.length = 0; lab = undefined;

    lab = await sceneLab(root, { emotes: [{ model: "*", "emote-set": "gentleled" }] });
    await lab.emit("agent_end");
    lab.emitBus(SUBAGENT_CHANNEL, subagentEvent("queued", 1));
    await wait(30);
    assert.equal(header(calls.at(-1)!, "X-Emote-Set"), "gentleman", "a gentleled parent falls back to gentleman");
  } finally {
    await lab?.shutdown();
    lab?.restore();
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a configured child avatar is honored; a missing one warns and falls back without rewriting preferences", async () => {
  const originalFetch = globalThis.fetch;
  const calls: RequestInit[] = [];
  let lab: Lab | undefined;
  const root = mkdtempSync(join(tmpdir(), "emote-subagent-config-"));
  globalThis.fetch = async (_url, init) => { calls.push(init!); return new Response(); };
  try {
    const dir = join(root, ".pi", "extensions", "gentle-emote");
    mkdirSync(join(dir, "emotes", "custom", "idle"), { recursive: true });
    writeFileSync(join(dir, "emotes", "custom", "idle", "idle.png"), png());
    mkdirSync(join(dir, "emotes", "child", "idle"), { recursive: true });
    writeFileSync(join(dir, "emotes", "child", "idle", "idle.png"), png());

    lab = await sceneLab(root, {
      emotes: [{ model: "*", "emote-set": "custom" }],
      subagentAvatar: "child",
    });
    await lab.emit("agent_end");
    lab.emitBus(SUBAGENT_CHANNEL, subagentEvent("queued", 1));
    await wait(30);
    assert.equal(header(calls.at(-1)!, "X-Emote-Set"), "child", "the configured child avatar is used");
    await lab.shutdown(); lab.restore(); calls.length = 0; lab = undefined;

    lab = await sceneLab(root, {
      emotes: [{ model: "*", "emote-set": "custom" }],
      subagentAvatar: "missing-child",
    });
    await lab.emit("agent_end");
    lab.emitBus(SUBAGENT_CHANNEL, subagentEvent("queued", 1));
    await wait(30);
    assert.equal(header(calls.at(-1)!, "X-Emote-Set"), "gentleled", "a missing configured avatar falls back to the shipped default");
    assert.ok(lab.notices.some(notice => notice.level === "warning" && notice.message.includes("subagentAvatar")),
      "the missing configured avatar was reported");
    const profile = process.env.PI_CODING_AGENT_DIR!;
    assert.equal(existsSync(join(profile, "extensions", "gentle-emote", "avatar.json")), false,
      "displaying the child never writes the manual avatar preference");
    assert.equal(readFileSync(join(root, ".pi", "extensions", "gentle-emote", "config.json"), "utf8").includes("missing-child"), true,
      "the configuration file is never rewritten");
  } finally {
    await lab?.shutdown();
    lab?.restore();
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});
