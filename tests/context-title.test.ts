import { test } from "node:test";
import assert from "node:assert/strict";
import { ExternalDisplay, ExternalDisplays } from "../src/external_display.ts";
import { decodePng, encodePng } from "../src/png.ts";

const options = { enabled: true, url: "http://localhost:48000/emote" };
const base64 = encodePng({ width: 1, height: 1, data: new Uint8Array([200, 80, 40, 255]) }).toString("base64");
const frame = { base64, state: "idle", frame: "idle.png", set: "gentleman" };
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function titleColors(body: Uint8Array): number[][] {
  const { data } = decodePng(Buffer.from(body));
  const colors = new Map<string, number[]>();
  for (let i = 64 * 4; i < 6 * 64 * 4; i += 4) {
    const rgb = Array.from(data.slice(i, i + 3));
    if (rgb.some(Boolean)) colors.set(String(rgb), rgb);
  }
  return [...colors.values()];
}

for (const [percent, expected] of [
  [0, [128, 224, 160]], [59.999, [128, 224, 160]],
  [60, [255, 255, 0]], [80, [255, 255, 0]],
  [80.001, [255, 0, 0]], [100, [255, 0, 0]],
] as const) {
  test(`context ${percent}% colors only the session title ${expected}`, async () => {
    const calls: RequestInit[] = [];
    const sender = new ExternalDisplay(options, async (_url, init) => { calls.push(init!); return new Response(); }, () => {}, null, "session");
    try {
      sender.select(frame); await flush();
      const original = decodePng(Buffer.from(calls[0]!.body as Uint8Array));
      sender.setContextUsage(percent); await flush();
      const latest = calls.at(-1)!;
      assert.deepEqual(titleColors(latest.body as Uint8Array), [Array.from(expected)]);
      const image = decodePng(Buffer.from(latest.body as Uint8Array));
      assert.deepEqual(image.data.slice(6 * 64 * 4), original.data.slice(6 * 64 * 4), "avatar, status, phase and padding stay unchanged");
      assert.deepEqual(Array.from(new Headers(latest.headers).entries()).filter(([name]) => name !== "x-emote-sequence"),
        Array.from(new Headers(calls[0]!.headers).entries()).filter(([name]) => name !== "x-emote-sequence"), "no context metadata is transmitted");
    } finally { sender.dispose(); }
  });
}

test("context bands deduplicate, revisit cached colors and preserve output pause states", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const group = new ExternalDisplays({ enabled: true, targets: [options, { ...options, url: "http://matrix/emote" }] },
    async (url, init) => { calls.push({ url: String(url), init: init! }); return new Response(); }, () => {}, null, "session");
  try {
    group.select(frame); await flush();
    const green = calls.map(call => call.init.body);
    group.setContextUsage(60); await flush(); assert.equal(calls.length, 4);
    assert.deepEqual(calls.slice(-2).map(call => titleColors(call.init.body as Uint8Array)), [[[255, 255, 0]], [[255, 255, 0]]]);
    group.setContextUsage(75); await flush(); assert.equal(calls.length, 4, "same band is a no-op");
    group.setDebugEnabled(false); group.setDisplayEnabled(false);
    group.setContextUsage(90); await flush(); assert.equal(calls.length, 4, "context cannot enable outputs");
    group.setDebugEnabled(true); group.setDisplayEnabled(true); await flush();
    assert.equal(calls.length, 6);
    assert.deepEqual(calls.slice(-2).map(call => titleColors(call.init.body as Uint8Array)), [[[255, 0, 0]], [[255, 0, 0]]]);
    group.setContextUsage(40); await flush(); assert.equal(calls.length, 8);
    assert.strictEqual(calls[6]!.init.body, green[0]); assert.strictEqual(calls[7]!.init.body, green[1]);
    group.setContextUsage(null); await flush(); assert.equal(calls.length, 8, "unknown context keeps the existing green fallback");
  } finally { group.dispose(); }
});

test("context changes keep one receiver clock carrier and use the latest color on activity", async t => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  t.mock.timers.enable({ apis: ["setInterval"] });
  const calls: RequestInit[] = [];
  const sender = new ExternalDisplay({ ...options, idleClock: "receiver" }, async (_url, init) => { calls.push(init!); return new Response(); }, () => {}, null, "session");
  try {
    sender.select(frame); await flush();
    now = 301000; t.mock.timers.tick(301000); await flush();
    assert.equal(calls.length, 2);
    assert.equal(new Headers(calls[1]!.headers).get("X-Emote-State"), "clock");
    sender.setContextUsage(60); sender.setContextUsage(90); await flush();
    t.mock.timers.tick(2000); await flush(); assert.equal(calls.length, 2, "no new carrier uploads");
    sender.updateActivity({ status: "busy", phase: "thinking", activeSubagents: 0 }); await flush();
    assert.equal(calls.length, 3);
    assert.deepEqual(titleColors(calls.at(-1)!.body as Uint8Array), [[255, 0, 0]]);
  } finally { sender.dispose(); }
});
