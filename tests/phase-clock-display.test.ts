import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { ExternalDisplay, ExternalDisplays, type DisplayActivity } from "../src/external_display.ts";
import { createD200Display } from "../src/d200_display.ts";
import { prepareDisplayImage } from "../src/display_image.ts";
import { drawDisplayText } from "../src/display_text.ts";
import { encodePng, decodePng } from "../src/png.ts";

const options = { enabled: true, url: "http://127.0.0.1:48000/emote" };
const base64 = encodePng({ width: 1, height: 1, data: new Uint8Array([255, 0, 0, 255]) }).toString("base64");
const frame = (state: string, name = "frame.png") => ({ base64, state, frame: name, set: "gentleman" });
const busy: DisplayActivity = { status: "busy", phase: "thinking", activeSubagents: 0 };
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function virtualTime(t: TestContext) {
  let elapsed = 0;
  t.mock.method(performance, "now", () => elapsed);
  t.mock.timers.enable({ apis: ["setInterval"] });
  return async (ms: number) => { elapsed += ms; t.mock.timers.tick(ms); await flush(); };
}
function assertPhase(body: Uint8Array, label: string, top = 54) {
  const image = decodePng(Buffer.from(body));
  const expected = new Uint8Array(64 * 64 * 4);
  for (let i = 3; i < expected.length; i += 4) expected[i] = 255;
  // Draw letters/digits normally, but pin colon pixels independently.
  const clockStart = label.includes(":") ? label.lastIndexOf(" ") + 1 : label.length;
  drawDisplayText(expected, label.replace(":", " "), top, index => index >= clockStart ? [241, 189, 101] : [238, 238, 238]);
  const colon = label.indexOf(":");
  if (colon >= 0) {
    const x = Math.floor((64 - (label.length * 4 - 1)) / 2) + colon * 4 + 1;
    for (const y of [top + 1, top + 3]) expected.set([241, 189, 101, 255], (y * 64 + x) * 4);
  }
  assert.deepEqual(image.data.slice(top * 64 * 4, (top + 5) * 64 * 4), expected.slice(top * 64 * 4, (top + 5) * 64 * 4), label);
}

test("phase clock appears strictly after five seconds, ticks, preserves artwork and resets only on visible phase changes", async t => {
  const advance = virtualTime(t), calls: RequestInit[] = [];
  const sender = new ExternalDisplay(options, async (_url, init) => { calls.push(init!); return new Response(); });
  const last = () => calls.at(-1)!.body as Uint8Array;
  try {
    sender.updateActivity(busy); sender.select(frame("implementing")); await flush();
    const original = decodePng(Buffer.from(last()));
    await advance(5000); assert.equal(calls.length, 1); assertPhase(last(), "IMPLEMENTING");
    await advance(1000); assertPhase(last(), "IMPLEMENTI 00:06");
    const timed = decodePng(Buffer.from(last()));
    assert.deepEqual(timed.data.slice(0, 54 * 64 * 4), original.data.slice(0, 54 * 64 * 4));
    assert.deepEqual(timed.data.slice(59 * 64 * 4), original.data.slice(59 * 64 * 4));
    sender.select(frame("implementing", "next.png")); sender.updateActivity({ ...busy, phase: "executing" }); await flush();
    assertPhase(last(), "IMPLEMENTI 00:06");
    await advance(1000); assertPhase(last(), "IMPLEMENTI 00:07");
    const steady = calls.length;
    sender.updateActivity({ ...busy, phase: "executing" }); sender.select(frame("implementing", "next.png")); await flush();
    assert.equal(calls.length, steady, "same frame, activity and phase second dedupe");
    assertPhase(last(), "IMPLEMENTI 00:07");
    await advance(53000); assertPhase(last(), "IMPLEMENTI 01:00");
    sender.select(frame("read")); await flush(); assertPhase(last(), "READING");
    await advance(5000); assertPhase(last(), "READING");
    await advance(1000); assertPhase(last(), "READING 00:06");
    sender.select(frame("idle")); await flush(); const count = calls.length;
    await advance(60000); assert.equal(calls.length, count); assertPhase(last(), "IDLE");
    assert.deepEqual(Buffer.from(last()), prepareDisplayImage(base64, { ...busy, phase: "executing", state: "idle" }));
  } finally { sender.dispose(); }
});

test("phase clock reaches simulator, LED and D200 without enabling paused/disabled outputs; resume starts fresh", async t => {
  const advance = virtualTime(t), calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher: typeof fetch = async (url, init) => { calls.push({ url: String(url), init: init! }); return new Response(); };
  const group = new ExternalDisplays({ enabled: true, targets: [options, { ...options, url: "http://matrix.invalid/emote" }] }, fetcher);
  const d200 = createD200Display({ port: 48003, fetcher });
  const disabled = new ExternalDisplay({ ...options, enabled: false }, fetcher);
  try {
    for (const sender of [group, d200, disabled]) { sender.updateActivity(busy); sender.select(frame("write")); }
    await flush(); await advance(6000);
    assert.equal(calls.length, 6);
    assert.equal(new Set(calls.slice(-3).map(call => call.url)).size, 3);
    for (const call of calls.slice(-3)) assertPhase(call.init.body as Uint8Array, "WRITING 00:06");
    group.setDebugEnabled(false); group.setDisplayEnabled(false); d200.setPaused(true);
    const count = calls.length; await advance(10000); assert.equal(calls.length, count);
    group.setDebugEnabled(true); group.setDisplayEnabled(true); d200.setPaused(false); await flush();
    for (const call of calls.slice(-3)) assertPhase(call.init.body as Uint8Array, "WRITING");
    await advance(6000);
    for (const call of calls.slice(-3)) assertPhase(call.init.body as Uint8Array, "WRITING 00:06");
  } finally { group.dispose(); d200.dispose(); disabled.dispose(); }
  const count = calls.length; await advance(10000); assert.equal(calls.length, count);
});

test("the captioned layout keeps the timed phase row at 58..62 with the amber clock", async t => {
  const advance = virtualTime(t), calls: RequestInit[] = [];
  const sender = new ExternalDisplay(options, async (_url, init) => { calls.push(init!); return new Response(); }, () => {}, "session-A", "my_repo");
  try {
    sender.updateActivity(busy); sender.select(frame("write")); await flush();
    await advance(6000);
    const lastImage = () => calls.map(call => call.body).filter(Boolean).at(-1)! as Uint8Array;
    assertPhase(lastImage(), "WRITING 00:06", 58);
  } finally { sender.dispose(); }
});

test("RUNNING is timed while idle without subagents never gains an elapsed label", async t => {
  const advance = virtualTime(t), calls: RequestInit[] = [];
  const sender = new ExternalDisplay(options, async (_url, init) => { calls.push(init!); return new Response(); });
  try {
    sender.updateActivity({ status: "idle", phase: "idle", activeSubagents: 1 }); sender.select(frame("idle")); await flush();
    await advance(6000); assertPhase(calls.at(-1)!.body as Uint8Array, "RUNNING 00:06");
    sender.updateActivity({ status: "idle", phase: "idle", activeSubagents: 0 }); await flush();
    const count = calls.length; await advance(6000); assert.equal(calls.length, count);
    assertPhase(calls.at(-1)!.body as Uint8Array, "IDLE");
  } finally { sender.dispose(); }
});

test("an errored idle parent with running subagents times the RUNNING phase clock", async t => {
  const advance = virtualTime(t), calls: RequestInit[] = [];
  const sender = new ExternalDisplay(options, async (_url, init) => { calls.push(init!); return new Response(); });
  try {
    sender.updateActivity({ status: "error", phase: "idle", activeSubagents: 1 }); sender.select(frame("idle")); await flush();
    await advance(6000); assertPhase(calls.at(-1)!.body as Uint8Array, "RUNNING 00:06");
    sender.updateActivity({ status: "error", phase: "idle", activeSubagents: 0 }); await flush();
    const count = calls.length; await advance(6000); assert.equal(calls.length, count);
    assertPhase(calls.at(-1)!.body as Uint8Array, "IDLE");
  } finally { sender.dispose(); }
});


test("GRANDMA stays untimed and returning to work starts a fresh phase clock", async t => {
  const advance = virtualTime(t), calls: RequestInit[] = [];
  const sender = new ExternalDisplay(options, async (_url, init) => { calls.push(init!); return new Response(); });
  const last = () => calls.at(-1)!.body as Uint8Array;
  try {
    sender.updateActivity(busy); sender.select(frame("write")); await flush();
    await advance(6000); assertPhase(last(), "WRITING 00:06");
    sender.select(frame("grandma")); await flush(); assertPhase(last(), "GRANDMA");
    const count = calls.length;
    await advance(600000); assertPhase(last(), "GRANDMA");
    assert.equal(calls.length, count, "grandma has no elapsed-driven deliveries");
    assertPhase(prepareDisplayImage(base64, { ...busy, state: "grandma", phaseElapsedSeconds: 600 }), "GRANDMA");
    sender.select(frame("write")); await flush(); assertPhase(last(), "WRITING");
    await advance(5000); assertPhase(last(), "WRITING");
    await advance(1000); assertPhase(last(), "WRITING 00:06");
  } finally { sender.dispose(); }
});

test("a visible IDLE phase gains an elapsed clock while subagents run and clears immediately when they finish", async t => {
  const advance = virtualTime(t), calls: RequestInit[] = [];
  const sender = new ExternalDisplay(options, async (_url, init) => { calls.push(init!); return new Response(); });
  const last = () => calls.at(-1)!.body as Uint8Array;
  const running: DisplayActivity = { status: "busy", phase: "thinking", activeSubagents: 1 };
  try {
    sender.updateActivity(running); sender.select(frame("idle")); await flush();
    await advance(5000); assertPhase(last(), "IDLE");
    await advance(1000); assertPhase(last(), "IDLE 00:06");
    // Count changes 1 -> 2 preserve the running timer under the same label.
    sender.updateActivity({ ...running, activeSubagents: 2 }); await flush();
    assertPhase(last(), "IDLE 00:06");
    // Unchanged state and activity keep the elapsed time.
    const steady = calls.length;
    sender.updateActivity({ ...running, activeSubagents: 2 }); sender.select(frame("idle")); await flush();
    assert.equal(calls.length, steady, "unchanged state and activity dedupe");
    await advance(1000); assertPhase(last(), "IDLE 00:07");
    // Workers finishing clear the timer immediately while the label stays IDLE.
    sender.updateActivity({ status: "busy", phase: "thinking", activeSubagents: 0 }); await flush();
    assertPhase(last(), "IDLE");
    const quiet = calls.length;
    await advance(60000); assert.equal(calls.length, quiet, "no elapsed-driven deliveries without workers");
    assertPhase(last(), "IDLE");
    // Workers starting later on the same visible label begin a fresh budget.
    sender.updateActivity(running); await flush();
    assertPhase(last(), "IDLE");
    await advance(5000); assertPhase(last(), "IDLE");
    await advance(1000); assertPhase(last(), "IDLE 00:06");
  } finally { sender.dispose(); }
});

test("both ambient phases time only while subagents run: table", async t => {
  const advance = virtualTime(t);
  for (const state of ["idle", "grandma"] as const) {
    const label = state === "idle" ? "IDLE" : "GRANDMA";
    const calls: RequestInit[] = [];
    const sender = new ExternalDisplay(options, async (_url, init) => { calls.push(init!); return new Response(); });
    const last = () => calls.at(-1)!.body as Uint8Array;
    try {
      // Without workers the ambient phases never carry a clock.
      sender.updateActivity(busy); sender.select(frame(state)); await flush();
      await advance(60000); assertPhase(last(), label);
      // With workers the same visible label gains the usual elapsed budget.
      sender.updateActivity({ status: "busy", phase: "thinking", activeSubagents: 1 }); await flush();
      await advance(5000); assertPhase(last(), label);
      await advance(1000); assertPhase(last(), `${label} 00:06`);
      sender.updateActivity({ status: "busy", phase: "thinking", activeSubagents: 0 }); await flush();
      assertPhase(last(), label);
    } finally { sender.dispose(); }
  }
});
