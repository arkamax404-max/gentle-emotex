import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot } from "./integration.test.ts";
import { decodePng } from "../src/png.ts";
import { drawDisplayText } from "../src/display_text.ts";

const SESSION_ID = "integration-session";
const PHASE_CHANGE = "gentle-pi:odd-phase/v1";
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const header = (call: RequestInit, name: string) => new Headers(call.headers).get(name);
const change = (phase: string | null, source: string | null, sessionId = SESSION_ID) =>
  ({ schema: "gentle-pi.odd-phase/v1", sessionId, phase, source });

interface Lab extends Awaited<ReturnType<typeof boot>> { calls: RequestInit[] }

/** Boots the extension with one captured localhost destination and hands it to `fn`. */
async function withLab(fn: (lab: Lab) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "emote-phase-bridge-"));
  const dir = join(root, ".pi", "extensions", "gentle-emote");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ externalDisplay: { enabled: true, url: "http://127.0.0.1:8000/emote" } }));
  const originalFetch = globalThis.fetch;
  const calls: RequestInit[] = [];
  globalThis.fetch = async (_url, init) => { calls.push(init!); return new Response(); };
  let lab: Lab | undefined;
  try {
    lab = { ...(await boot(root)), calls };
    await fn(lab);
  } finally {
    await lab?.shutdown();
    lab?.restore();
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
}

const end = (phase: unknown, extra: Record<string, unknown> = {}) => ({
  toolName: "gentle_odd_phase", toolCallId: "p", args: { phase }, ...extra,
});

test("a successful gentle_odd_phase end adopts the phase PNG without any bus event", async () => {
  await withLab(async (lab) => {
    // No speculative adoption on start: the phase is only real once the call succeeded.
    await lab.emit("tool_execution_start", { toolName: "gentle_odd_phase", toolCallId: "p", args: { phase: "planning" } });
    await flush();
    assert.equal(header(lab.calls.at(-1)!, "X-Emote-Work-Phase"), null);
    assert.equal(header(lab.calls.at(-1)!, "X-Emote-State"), "tool");

    const before = lab.calls.length;
    await lab.emit("tool_execution_end", end("planning", { isError: false }));
    await flush();
    assert.ok(lab.calls.length > before, "the adopted phase reaches the frame sink");
    const last = lab.calls.at(-1)!;
    assert.equal(header(last, "X-Emote-Work-Phase"), "planning");
    assert.equal(header(last, "X-Emote-State"), "planning", "the generic scene wears the phase visual");
    assert.ok(header(last, "X-Emote-Frame")!.startsWith("planning_"), "the planning PNG folder is selected");
  });
});

test("all eight phases are accepted in sequence via successful ends", async () => {
  await withLab(async (lab) => {
    await lab.emit("tool_execution_start", { toolName: "gentle_odd_phase", toolCallId: "p", args: { phase: "authorizing" } });
    await lab.emit("tool_execution_end", end("authorizing"));
    await flush();
    for (const phase of ["exploring", "researching", "deciding", "planning", "implementing", "checking", "closing"]) {
      await lab.emit("tool_execution_end", end(phase));
      await flush();
      assert.equal(header(lab.calls.at(-1)!, "X-Emote-Work-Phase"), phase);
      assert.equal(header(lab.calls.at(-1)!, "X-Emote-State"), phase);
    }
  });
});

test("a clear argument removes only the direct fallback", async () => {
  await withLab(async (lab) => {
    await lab.emit("tool_execution_start", { toolName: "gentle_odd_phase", toolCallId: "p" });
    await lab.emit("tool_execution_end", end("planning"));
    await flush();
    assert.equal(header(lab.calls.at(-1)!, "X-Emote-Work-Phase"), "planning");
    await lab.emit("tool_execution_end", end("clear"));
    await flush();
    assert.equal(header(lab.calls.at(-1)!, "X-Emote-Work-Phase"), null);
    assert.equal(header(lab.calls.at(-1)!, "X-Emote-State"), "read", "the coarse scene returns");
  });
});

test("malformed args are no-ops", async () => {
  await withLab(async (lab) => {
    await lab.emit("tool_execution_start", { toolName: "gentle_odd_phase", toolCallId: "p" });
    for (const args of [undefined, "planning", 42, {}, { phase: "scheming" }, { phase: null }, { other: true }]) {
      const before = lab.calls.length;
      await lab.emit("tool_execution_end", { toolName: "gentle_odd_phase", toolCallId: "p", args });
      await flush();
      const recent = lab.calls.slice(before);
      assert.ok(recent.every(call => header(call, "X-Emote-Work-Phase") === null), `args ${JSON.stringify(args)} never adopts a phase`);
    }
  });
});

test("a failed gentle_odd_phase call never changes the phase", async () => {
  await withLab(async (lab) => {
    await lab.emit("tool_execution_start", { toolName: "gentle_odd_phase", toolCallId: "p" });
    await lab.emit("tool_execution_end", end("planning", { isError: true }));
    await flush();
    assert.ok(lab.calls.every(call => header(call, "X-Emote-Work-Phase") === null));
  });
});

test("the native bus phase wins, a direct clear keeps it, and a host null reveals the direct fallback", async () => {
  await withLab(async (lab) => {
    lab.emitBus(PHASE_CHANGE, change("implementing", "inferred"));
    await flush();
    await lab.emit("tool_execution_start", { toolName: "gentle_odd_phase", toolCallId: "p" });
    await lab.emit("tool_execution_end", end("planning"));
    await flush();
    assert.equal(header(lab.calls.at(-1)!, "X-Emote-Work-Phase"), "implementing", "native priority");
    await lab.emit("tool_execution_end", end("clear"));
    await flush();
    assert.equal(header(lab.calls.at(-1)!, "X-Emote-Work-Phase"), "implementing", "a direct clear never erases the native phase");
    // The tool names the phase again (still shadowed by the native bus), then the host clears.
    await lab.emit("tool_execution_end", end("planning"));
    await flush();
    lab.emitBus(PHASE_CHANGE, change(null, null));
    await flush();
    assert.equal(header(lab.calls.at(-1)!, "X-Emote-Work-Phase"), "planning", "the host null reveals this turn's direct fallback");
  });
});

test("turn and session boundaries clear the direct phase; no stale phase next turn", async () => {
  await withLab(async (lab) => {
    await lab.emit("tool_execution_start", { toolName: "gentle_odd_phase", toolCallId: "p" });
    await lab.emit("tool_execution_end", end("planning"));
    await flush();
    await lab.emit("agent_end");
    await lab.emit("agent_start");
    await lab.emit("tool_execution_start", { toolName: "read", toolCallId: "r" });
    await lab.emit("tool_execution_end", { toolName: "read", toolCallId: "r", args: {} });
    await flush();
    assert.equal(header(lab.calls.at(-1)!, "X-Emote-Work-Phase"), null, "no stale phase on the next turn");
  });
});

// Pi's public event contract supplies args on start, never on end.
const realEnd = (toolCallId: string, isError = false, toolName = "gentle_odd_phase") => ({
  toolName, toolCallId, result: { content: [] }, isError,
});
const realStart = (toolCallId: string, phase: unknown) => ({
  toolName: "gentle_odd_phase", toolCallId, args: { phase },
});

test("real Pi events recover all explicit phases into the PNG status only after success", async () => {
  await withLab(async (lab) => {
    await lab.emit("agent_start");
    let previous: string | null = null;
    for (const phase of ["authorizing", "exploring", "researching", "deciding", "planning", "implementing", "checking", "closing"]) {
      await lab.emit("tool_execution_start", realStart(phase, phase));
      await flush();
      assert.equal(header(lab.calls.at(-1)!, "X-Emote-Work-Phase"), previous, "start alone never adopts");
      await lab.emit("tool_execution_end", realEnd(phase));
      await flush();
      const last = lab.calls.at(-1)!;
      assert.equal(header(last, "X-Emote-Work-Phase"), phase);
      assert.equal(header(last, "X-Emote-Status"), "busy", "coarse status remains truthful");
      const image = decodePng(Buffer.from(last.body as Uint8Array));
      const expected = new Uint8Array(64 * 64 * 4);
      for (let i = 3; i < expected.length; i += 4) expected[i] = 255;
      drawDisplayText(expected, phase, 51, [255, 208, 96]);
      assert.deepEqual(image.data.slice(51 * 64 * 4, 56 * 64 * 4), expected.slice(51 * 64 * 4, 56 * 64 * 4), "actual outgoing PNG spells the ODD status");
      await lab.commands.get("emote").handler("status", lab.ctx);
      assert.match(lab.notices.at(-1)!.message, new RegExp(`phase ${phase} \\(source: direct\\)`));
      previous = phase;
    }
    await lab.emit("tool_execution_start", realStart("clear", "clear"));
    await lab.emit("tool_execution_end", realEnd("clear"));
    await flush();
    assert.equal(header(lab.calls.at(-1)!, "X-Emote-Work-Phase"), null, "successful real clear removes detail");
  });
});

test("real Pi calls correlate by id, finish out of order, and consume each captured phase once", async () => {
  await withLab(async (lab) => {
    await lab.emit("tool_execution_start", realStart("a", "exploring"));
    await lab.emit("tool_execution_start", realStart("b", "planning"));
    await lab.emit("tool_execution_end", realEnd("a", false, "read"));
    await flush();
    assert.equal(header(lab.calls.at(-1)!, "X-Emote-Work-Phase"), null, "another tool cannot adopt a captured phase");
    await lab.emit("tool_execution_end", realEnd("b"));
    await flush();
    assert.equal(header(lab.calls.at(-1)!, "X-Emote-Work-Phase"), "planning");
    await lab.emit("tool_execution_end", realEnd("a"));
    await flush();
    assert.equal(header(lab.calls.at(-1)!, "X-Emote-Work-Phase"), "exploring");
    await lab.emit("tool_execution_end", realEnd("b"));
    await flush();
    assert.equal(header(lab.calls.at(-1)!, "X-Emote-Work-Phase"), "exploring", "duplicate end cannot replay planning");
  });
});

test("failed real Pi calls discard captured phases and never clear a successful phase", async () => {
  await withLab(async (lab) => {
    await lab.emit("tool_execution_start", realStart("failed", "exploring"));
    await lab.emit("tool_execution_end", realEnd("failed", true));
    await flush();
    assert.equal(header(lab.calls.at(-1)!, "X-Emote-Work-Phase"), null);
    await lab.emit("tool_execution_end", realEnd("failed"));
    await flush();
    assert.equal(header(lab.calls.at(-1)!, "X-Emote-Work-Phase"), null, "failure consumes the pending phase too");
    await lab.emit("tool_execution_start", realStart("good", "planning"));
    await lab.emit("tool_execution_end", realEnd("good"));
    await lab.emit("tool_execution_start", realStart("failed-clear", "clear"));
    await lab.emit("tool_execution_end", realEnd("failed-clear", true));
    await flush();
    assert.equal(header(lab.calls.at(-1)!, "X-Emote-Work-Phase"), "planning");
  });
});

for (const boundary of ["agent_start", "agent_end", "session_start", "session_shutdown"]) {
  test(`real Pi pending phases cannot cross ${boundary}`, async () => {
    await withLab(async (lab) => {
      await lab.emit("tool_execution_start", realStart("stale", "exploring"));
      await lab.emit(boundary);
      if (boundary === "session_shutdown") await lab.emit("session_start");
      if (boundary === "agent_end") await lab.emit("agent_start");
      await lab.emit("tool_execution_end", realEnd("stale"));
      await flush();
      assert.equal(header(lab.calls.at(-1)!, "X-Emote-Work-Phase"), null);
      await lab.emit("tool_execution_start", realStart("fresh", "planning"));
      await lab.emit("tool_execution_end", realEnd("fresh"));
      await flush();
      assert.equal(header(lab.calls.at(-1)!, "X-Emote-Work-Phase"), "planning", "the boundary does not disable later calls");
    });
  });
}

test("ordinary tools keep their behavior even with phase-shaped args", async () => {
  await withLab(async (lab) => {
    await lab.emit("tool_execution_start", { toolName: "bash", toolCallId: "b", args: { phase: "planning" } });
    await flush();
    assert.equal(header(lab.calls.at(-1)!, "X-Emote-State"), "tool");
    assert.equal(header(lab.calls.at(-1)!, "X-Emote-Work-Phase"), null);
    await lab.emit("tool_execution_end", { toolName: "bash", toolCallId: "b", args: { phase: "planning" } });
    await flush();
    assert.equal(header(lab.calls.at(-1)!, "X-Emote-State"), "read");
    assert.equal(header(lab.calls.at(-1)!, "X-Emote-Work-Phase"), null);
  });
});
