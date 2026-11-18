import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { ExternalDisplay, ExternalDisplays, normalizeExternalDisplay, type DisplayActivity } from "../src/external_display.ts";
import { DisplayActivityTracker } from "../src/display_activity.ts";
import { IdleClock, IDLE_CLOCK_DELAY_MS } from "../src/idle_clock.ts";
import { createD200Display } from "../src/d200_display.ts";
import { encodePng, decodePng } from "../src/png.ts";
import { prepareDisplayImage } from "../src/display_image.ts";

const options = { enabled: true, url: "http://127.0.0.1:48000/emote", timeoutMs: 30000, idleClock: "receiver" };
const idle: DisplayActivity = { status: "idle", phase: "idle", activeSubagents: 0 };
const busy: DisplayActivity = { status: "busy", phase: "thinking", activeSubagents: 0 };
const base64 = encodePng({ width: 1, height: 1, data: new Uint8Array([255, 0, 0, 255]) }).toString("base64");
const frame = (name = "idle.png", state = "idle") => ({ base64, state, frame: name, set: "gentleman" });
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const headers = (call: RequestInit) => new Headers(call.headers);
function virtualTime(t: TestContext) {
  let elapsed = 0;
  t.mock.method(performance, "now", () => elapsed);
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: new Date(2026, 10, 9, 23, 54, 57).getTime() });
  return async (ms: number) => { elapsed += ms; t.mock.timers.tick(ms); await flush(); };
}

test("receiver sends one cached valid avatar carrier strictly past five minutes, without animation/title churn, and restores latest selection", async t => {
  const advance = virtualTime(t), calls: RequestInit[] = [];
  const sender = new ExternalDisplay(options, async (_url, init) => { calls.push(init!); return new Response(); }, () => {}, null, "project");
  try {
    sender.select(frame("grandma.png", "grandma")); await flush();
    const original = calls[0]!.body;
    await advance(300000); assert.equal(calls.length, 1);
    await advance(1000); assert.equal(calls.length, 2);
    const carrier = calls[1]!;
    assert.strictEqual(carrier.body, original, "reuse prepared cached bytes, including original grandma label");
    assert.deepEqual([decodePng(Buffer.from(carrier.body as Uint8Array)).width, decodePng(Buffer.from(carrier.body as Uint8Array)).height], [64, 64]);
    for (const [name, value] of Object.entries({ "Content-Type": "image/png", "X-Emote-Version": "1", "X-Emote-State": "clock", "X-Emote-Frame": "clock.png", "X-Emote-Set": "idle-clock", "X-Emote-Status": "idle", "X-Emote-Phase": "idle", "X-Emote-Active-Subagents": "0", "X-Emote-Sequence": "2" })) assert.equal(headers(carrier).get(name), value);
    for (let i = 0; i < 8; i++) { await advance(250); sender.select(frame(`animation_${i}.png`, "grandma")); await flush(); }
    assert.equal(sender.setTitle("new title"), true);
    await advance(10000); assert.equal(calls.length, 2, "ambient clocks belong entirely to receiver");
    sender.updateActivity(busy); await flush();
    assert.equal(headers(calls.at(-1)!).get("X-Emote-Frame"), "animation_7.png");
    assert.equal(headers(calls.at(-1)!).get("X-Emote-Project-Name"), "new%20title");
    assert.deepEqual(calls.at(-1)!.body, prepareDisplayImage(base64, { ...busy, state: "grandma" }, undefined, undefined, undefined, undefined, "new title"));
    sender.updateActivity(idle); await flush(); const count = calls.length;
    await advance(300000); assert.equal(calls.length, count);
    await advance(1000); assert.equal(headers(calls.at(-1)!).get("X-Emote-State"), "clock");
  } finally { sender.dispose(); }
});

test("receiver keeps existing bodyless session heartbeats without periodic PNG uploads", async t => {
  const advance = virtualTime(t), calls: Array<{ url: string; init: RequestInit }> = [];
  const sender = new ExternalDisplay(options, async (url, init) => { calls.push({ url: String(url), init: init! }); return new Response(); }, () => {}, "session-A");
  try {
    sender.select(frame()); await flush(); await advance(301000); await flush();
    const count = calls.filter(call => call.init.body).length;
    await advance(10000);
    assert.equal(calls.filter(call => call.init.body).length, count);
    assert.equal(count, 2);
    assert.ok(calls.filter(call => !call.init.body).length > 0);
    for (const call of calls.filter(call => !call.init.body)) {
      assert.equal(call.url, `${options.url}/heartbeat`);
      assert.equal(headers(call.init).get("X-Emote-Session-Id"), "session-A");
      assert.equal(headers(call.init).get("X-Emote-State"), null);
    }
    assert.deepEqual(calls.map(call => Number(headers(call.init).get("X-Emote-Sequence"))), calls.map((_, i) => i + 1));
  } finally { sender.dispose(); }
});

test("silence suppresses PNGs and session heartbeats at and after ambient deadline, resumes immediately", async t => {
  const advance = virtualTime(t), calls: RequestInit[] = [];
  const sender = new ExternalDisplay({ ...options, idleClock: "silence" }, async (_url, init) => { calls.push(init!); return new Response(); }, () => {}, "session-A");
  try {
    sender.select(frame()); await flush();
    await advance(300000); assert.ok(calls.some(call => call.body === undefined), "exact deadline remains ordinary");
    await advance(1000); const count = calls.length;
    sender.select(frame("latest.png")); sender.setTitle("new title");
    await advance(15000); assert.equal(calls.length, count, "including the LED's ten-second fallback window");
    sender.updateActivity(busy); await flush();
    assert.equal(calls.length, count + 1);
    assert.equal(headers(calls.at(-1)!).get("X-Emote-Frame"), "latest.png");
    assert.equal(headers(calls.at(-1)!).get("X-Emote-Status"), "busy");
    await advance(5000); assert.equal(calls.at(-1)!.body, undefined);
  } finally { sender.dispose(); }
});

test("silence clears pending ordinary images and heartbeat behind an in-flight request", async t => {
  const advance = virtualTime(t), calls: RequestInit[] = []; let release: (() => void) | undefined;
  const sender = new ExternalDisplay({ ...options, idleClock: "silence" }, async (_url, init) => {
    calls.push(init!); if (calls.length === 1) return new Promise(resolve => { release = () => resolve(new Response()); }); return new Response();
  }, () => {}, "session-A");
  try {
    sender.select(frame()); sender.select(frame("pending.png"));
    await advance(301000); release!(); await flush();
    assert.equal(calls.length, 1, "no pending image or heartbeat survives ambient entry");
    sender.updateActivity(busy); await flush();
    assert.equal(calls.length, 2); assert.equal(headers(calls[1]!).get("X-Emote-Frame"), "pending.png");
  } finally { sender.dispose(); release?.(); }
});

test("silence stops frames and heartbeats yet an explicit claim and release still reach the receiver", async t => {
  const advance = virtualTime(t), calls: Array<{ url: string; init: RequestInit }> = [], reports: string[] = [];
  const owned = () => new Response(null, { headers: { "X-Emote-Ownership": "1" } });
  const sender = new ExternalDisplay({ ...options, url: "http://matrix/emote", idleClock: "silence" },
    async (url, init) => { calls.push({ url: String(url), init: init! }); return owned(); }, message => reports.push(message), "session-A");
  try {
    sender.select(frame()); await flush();
    await advance(5000);
    assert.equal(calls.at(-1)!.url, "http://matrix/emote/heartbeat", "the reservation renews before silence begins");
    await advance(295000); await advance(1000);
    const silent = calls.length;
    sender.select(frame("latest.png")); await advance(15000); await flush();
    assert.equal(calls.length, silent, "no frame and no heartbeat reaches the receiver while silenced");
    sender.claimOwnership(); await flush(); await flush();
    assert.equal(calls.at(-1)!.url, "http://matrix/emote/claim", "an explicit claim is an order, never ambient traffic");
    assert.equal(headers(calls.at(-1)!.init).get("X-Emote-Session-Id"), "session-A", "the claim carries this session's identity");
    sender.releaseOwnership(); await flush(); await flush();
    assert.equal(calls.at(-1)!.url, "http://matrix/emote/release", "the explicit release is not swallowed by silence either");
    assert.equal(calls.filter(call => call.init.body !== undefined && call.init.body !== null).length, 1, "only the pre-silence image carried a body");
    assert.deepEqual(reports, [], "both controls are answered with the ownership marker, so nothing is warned");
  } finally { sender.dispose(); }
});

test("receiver pending carrier is replaced by latest busy image; disposal aborts active requests", async t => {
  const advance = virtualTime(t), calls: RequestInit[] = []; const release: Array<() => void> = [];
  const sender = new ExternalDisplay(options, async (_url, init) => { calls.push(init!); return new Promise(resolve => release.push(() => resolve(new Response()))); });
  try {
    sender.select(frame()); await advance(301000);
    sender.select(frame("latest.png")); sender.updateActivity(busy);
    release.shift()!(); await flush();
    assert.equal(calls.length, 2); assert.equal(headers(calls[1]!).get("X-Emote-State"), "idle");
    assert.equal(headers(calls[1]!).get("X-Emote-Frame"), "latest.png");
    assert.equal(headers(calls[1]!).get("X-Emote-Sequence"), "2");
    sender.dispose(); assert.equal(calls[1]!.signal!.aborted, true);
    release.shift()!(); await flush(); await advance(10000); assert.equal(calls.length, 2);
  } finally { sender.dispose(); for (const done of release) done(); }
});

test("post-error idle settles like idle: a failed turn no longer blocks the clock", async t => {
  const advance = virtualTime(t), calls: RequestInit[] = [];
  const sender = new ExternalDisplay(options, async (_url, init) => { calls.push(init!); return new Response(); });
  // The real tracker feeds the sender exactly what the extension reports at
  // agent_end after a failed tool: reset to idle, then the terminal error status.
  const tracker = new DisplayActivityTracker(activity => sender.updateActivity(activity));
  try {
    sender.select(frame("grandma.png", "grandma"));
    tracker.set("busy", "thinking");
    tracker.toolStart("read", "r1");
    tracker.toolEnd("r1", true);
    tracker.reset();
    tracker.set("error", "idle");
    sender.select(frame("grandma.png", "grandma"));
    await flush();
    await advance(300000);
    assert.ok(calls.every(call => headers(call).get("X-Emote-State") !== "clock"), "the strict five-minute boundary is unchanged");
    await advance(1000);
    const carrier = calls.at(-1)!;
    assert.equal(headers(carrier).get("X-Emote-State"), "clock");
    assert.equal(headers(carrier).get("X-Emote-Frame"), "clock.png");
    assert.equal(headers(carrier).get("X-Emote-Set"), "idle-clock");
    assert.equal(headers(carrier).get("X-Emote-Status"), "error", "the settled error status is reported truthfully");

    // A worker started from that post-error idle still owns the display after the
    // clock: the red SUBAGENTS/RUNNING state is never replaced by a clock face.
    tracker.setNativeSubagents(1);
    sender.select(frame("idle.png"));
    await flush();
    const count = calls.length;
    await advance(600000);
    assert.ok(calls.slice(count).every(call => headers(call).get("X-Emote-State") !== "clock"), "running work blocks the clock after an error too");
  } finally { sender.dispose(); }
});

test("busy/error during work, active subagents, detailed work and explicit previews reset eligibility", async t => {
  const advance = virtualTime(t);
  for (const blocked of [
    { activity: { ...idle, status: "error" as const, phase: "waiting" as const } },
    { activity: busy }, { activity: { ...idle, phase: "waiting" as const } },
    { activity: { ...idle, activeSubagents: 1 } }, { activity: { ...idle, workPhase: "planning" as const } },
    { activity: idle, state: "bye" },
  ]) {
    const calls: RequestInit[] = [];
    const sender = new ExternalDisplay(options, async (_url, init) => { calls.push(init!); return new Response(); });
    try {
      sender.updateActivity(blocked.activity); sender.select(frame("preview.png", blocked.state ?? "idle")); await flush();
      await advance(301000); assert.ok(calls.every(call => headers(call).get("X-Emote-State") !== "clock"));
      sender.updateActivity(idle); sender.select(frame()); await flush();
      await advance(300000); assert.notEqual(headers(calls.at(-1)!).get("X-Emote-State"), "clock");
      await advance(1000); assert.equal(headers(calls.at(-1)!).get("X-Emote-State"), "clock");
    } finally { sender.dispose(); }
  }
});

test("idle to grandma preserves continuous idle budget and grandma remains untimed", async t => {
  const advance = virtualTime(t), calls: RequestInit[] = [];
  const sender = new ExternalDisplay(options, async (_url, init) => { calls.push(init!); return new Response(); });
  try {
    sender.select(frame()); await advance(200000);
    sender.select(frame("grandma.png", "grandma")); await flush();
    assert.deepEqual(calls.at(-1)!.body, prepareDisplayImage(base64, { ...idle, state: "grandma" }));
    await advance(100000); assert.equal(calls.length, 2);
    await advance(1000); assert.equal(headers(calls.at(-1)!).get("X-Emote-State"), "clock");
    assert.strictEqual(calls[1]!.body, calls[2]!.body);
  } finally { sender.dispose(); }
});

test("capability is explicit, inherited and overridden per target, never inferred from host", async t => {
  const advance = virtualTime(t), calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher: typeof fetch = async (url, init) => { calls.push({ url: String(url), init: init! }); return new Response(); };
  const group = new ExternalDisplays({ ...options, targets: [
    { enabled: true, url: "http://remote.invalid/emote" },
    { enabled: true, url: options.url, idleClock: "silence" },
    { enabled: true, url: "http://127.0.0.1:48001/emote", idleClock: "off" },
  ] }, fetcher);
  const d200 = createD200Display({ port: 48003, fetcher });
  try {
    group.select(frame()); d200.select(frame()); await flush(); await advance(301000);
    assert.deepEqual(calls.filter(call => headers(call.init).get("X-Emote-State") === "clock").map(call => call.url).sort(), ["http://remote.invalid/emote", "http://127.0.0.1:48003/emote"].sort());
    assert.equal(calls.length, 6);
  } finally { group.dispose(); d200.dispose(); }
});

test("pause and resume honor receiver/silence modes and never enable disabled outputs", async t => {
  const advance = virtualTime(t), calls: RequestInit[] = [];
  for (const idleClock of ["receiver", "silence"]) {
    const sender = new ExternalDisplay({ ...options, idleClock }, async (_url, init) => { calls.push(init!); return new Response(); });
    try {
      sender.setPaused(true); sender.select(frame()); const before = calls.length;
      await advance(301000); assert.equal(calls.length, before);
      sender.setPaused(false); await flush(); assert.equal(calls.length, before + (idleClock === "receiver" ? 1 : 0));
      sender.setPaused(true); sender.select(frame("latest.png")); sender.updateActivity(busy);
      sender.setPaused(false); await flush(); assert.equal(headers(calls.at(-1)!).get("X-Emote-Frame"), "latest.png");
      const count = calls.length; sender.setPaused(false); await flush(); assert.equal(calls.length, count);
    } finally { sender.dispose(); }
  }
  const disabled = new ExternalDisplay({ ...options, enabled: false }, async () => { assert.fail("disabled"); });
  disabled.select(frame()); await advance(301000); disabled.setPaused(false); disabled.dispose();
});

test("no source sprite means no carrier or fabricated clock session", async t => {
  const advance = virtualTime(t), calls: RequestInit[] = [];
  const sender = new ExternalDisplay(options, async (_url, init) => { calls.push(init!); return new Response(); }, () => {}, "session-A");
  try { sender.updateActivity(idle); await advance(311000); assert.equal(calls.length, 0); }
  finally { sender.dispose(); }
});

test("off and omitted modes preserve ordinary avatar delivery beyond idle deadline", async t => {
  const advance = virtualTime(t);
  for (const idleClock of [undefined, "off"]) {
    const calls: RequestInit[] = [];
    const sender = new ExternalDisplay({ ...options, idleClock }, async (_url, init) => { calls.push(init!); return new Response(); });
    try {
      sender.select(frame()); await flush(); await advance(301000); assert.equal(calls.length, 1);
      sender.select(frame("next.png")); await flush(); assert.equal(calls.length, 2);
      assert.equal(headers(calls[1]!).get("X-Emote-Frame"), "next.png");
      assert.strictEqual(calls[0]!.body, calls[1]!.body);
    } finally { sender.dispose(); }
  }
});

test("idleClock strictly validates modes and invalid targets consume no requests or sequences", async () => {
  for (const idleClock of ["off", "receiver", "silence"]) assert.equal(normalizeExternalDisplay({ ...options, idleClock })?.idleClock, idleClock);
  for (const idleClock of [null, true, 0, "", "Receiver", "auto", [], {}]) {
    const warnings: string[] = [], calls: RequestInit[] = [];
    const sender = new ExternalDisplay({ ...options, idleClock }, async (_url, init) => { calls.push(init!); return new Response(); }, message => warnings.push(message));
    try { assert.equal(sender.enabled, false); sender.select(frame()); await flush(); assert.equal(calls.length, 0); assert.deepEqual(warnings, ["externalDisplay: invalid configuration; disabled"]); }
    finally { sender.dispose(); }
  }
});

test("remaining() reports the settled deadline without mutating eligibility", () => {
  const clock = new IdleClock(0);
  assert.equal(clock.remaining(0), IDLE_CLOCK_DELAY_MS, "a fresh sender starts with the full budget");
  assert.equal(clock.isActive(0), false);
  clock.update(idle, 0);
  assert.equal(clock.remaining(299999), 1);
  assert.equal(clock.remaining(300000), 0);
  assert.equal(clock.isActive(300000), false, "exactly five minutes is still ordinary");
  assert.equal(clock.remaining(301000), -1000);
  assert.equal(clock.isActive(301000), true);
  clock.update({ ...idle, status: "error" }, 400000);
  assert.equal(clock.remaining(400000), -100000, "a settled error never restarts the continuous budget");
  clock.update(busy, 500000);
  assert.equal(clock.remaining(500000), null, "running work is not settled at all");
  clock.update({ ...idle, status: "error" }, 600000);
  assert.equal(clock.remaining(600000), IDLE_CLOCK_DELAY_MS, "leaving work as a settled error stamps its own moment");
  assert.equal(clock.isActive(900000), false, "exactly five minutes after that stamp is still ordinary");
  assert.equal(clock.isActive(900001), true);
});
