import { test } from "node:test";
import assert from "node:assert/strict";
import { ExternalDisplay, ExternalDisplays } from "../src/external_display.ts";
import { createHerdrFocusController, type HerdrFocusResult } from "../src/herdr_focus.ts";
import { createD200Display } from "../src/d200_display.ts";
import { encodePng } from "../src/png.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const options = { enabled: true, url: "http://127.0.0.1:8001/emote", timeoutMs: 1000 };
const image = { base64: encodePng({ width: 1, height: 1, data: new Uint8Array([255, 0, 0, 255]) }).toString("base64"), state: "idle", frame: "idle.png", set: "gentleman" };
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const ack = (init: RequestInit) => new Headers(init.headers).get("X-Emote-Action-Ack");
const signalHeaders = (id = "click-1", session = "session-A", action = "focus") => ({ "X-Emote-Action": action, "X-Emote-Action-Id": id, "X-Emote-Session-Id": session });
const response = (id = "click-1") => new Response(null, { headers: signalHeaders(id) });
const env = { HERDR_ENV: "1", HERDR_BIN_PATH: "/test/herdr", HERDR_SOCKET_PATH: "/test/socket", HERDR_PANE_ID: "pane-A" };

test("frame and bodyless heartbeat actions ACK receipts on the next request, without parsing bodies", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const calls: Array<{ url: string; init: RequestInit }> = [], ids: string[] = [];
  let canceled = 0;
  const sender = new ExternalDisplay(options, async (url, init) => {
    calls.push({ url: String(url), init: init! });
    return { ok: true, status: 200, headers: new Headers(signalHeaders(`click-${calls.length}`)),
      body: { cancel: async () => { canceled++; } },
      json() { throw Error("must not parse"); }, text() { throw Error("must not parse"); },
    } as unknown as Response;
  }, () => {}, "session-A", null, id => { ids.push(id); return "accepted"; });
  try {
    sender.select(image); await flush();
    assert.deepEqual(ids, ["click-1"]); assert.equal(ack(calls[0]!.init), null);
    t.mock.timers.tick(5000); await flush();
    assert.equal(calls[1]!.url, `${options.url}/heartbeat`);
    assert.equal(calls[1]!.init.body, undefined); assert.equal(calls[1]!.init.method, "POST");
    assert.equal(ack(calls[1]!.init), "click-1"); assert.deepEqual(ids, ["click-1", "click-2"]);
    sender.select({ ...image, frame: "next.png" }); await flush();
    assert.equal(ack(calls[2]!.init), "click-2"); assert.equal(canceled, 3);
    assert.ok(calls.every(call => call.init.redirect === "error"));
    assert.deepEqual(calls.map(call => new Headers(call.init.headers).get("X-Emote-Sequence")), ["1", "2", "3"]);
  } finally { sender.dispose(); }
});

test("only accepted and duplicate results ACK, ignored results do not replace the last receipt", async () => {
  for (const result of ["accepted", "duplicate", "ignored"] as HerdrFocusResult[]) {
    const calls: RequestInit[] = [];
    const sender = new ExternalDisplay(options, async (_url, init) => { calls.push(init!); return response(); }, () => {}, "session-A", null, () => result);
    try {
      sender.select(image); await flush(); sender.select({ ...image, frame: "next.png" }); await flush();
      assert.deepEqual(calls.map(ack), [null, result === "ignored" ? null : "click-1"]);
    } finally { sender.dispose(); }
  }
  const calls: RequestInit[] = [];
  const sender = new ExternalDisplay(options, async (_url, init) => { calls.push(init!); return response(`click-${calls.length}`); }, () => {}, "session-A", null,
    id => id === "click-1" ? "accepted" : "ignored");
  try {
    for (const frame of ["one.png", "two.png", "three.png"]) { sender.select({ ...image, frame }); await flush(); }
    assert.deepEqual(calls.map(ack), [null, "click-1", "click-1"]);
  } finally { sender.dispose(); }
});

test("wrong session/action/ID/status/path, LAN, missing identity/capability and minimal legacy mocks are inert", async () => {
  const cases: Array<{ url?: string; session?: string | null; headers?: unknown; status?: number; capability?: boolean; id?: string }> = [
    { headers: signalHeaders("click", "other-session") }, { headers: signalHeaders("click", "session-A", "exec") },
    ...["", "x".repeat(129), "a b", "a/b", "a\n", "a;cmd"].map(id => ({ headers: { get: (name: string) => signalHeaders(id)[name] ?? null } })),
    ...[199, 300, 404, 409, 500].map(status => ({ status })),
    { url: "http://192.168.1.10/emote" }, { url: `${options.url}?x=1` }, { url: `${options.url}/` },
    { url: "http://localhost/custom" }, { session: null }, { session: "bad session" }, { capability: false },
    { headers: undefined }, { headers: {} }, { headers: { get: () => { throw Error("bad mock"); } } }, { headers: new Headers() },
  ];
  for (const entry of cases) {
    const calls: RequestInit[] = [], ids: string[] = [], warnings: string[] = [];
    let canceled = 0;
    const sender = new ExternalDisplay({ ...options, url: entry.url ?? options.url }, async (_url, init) => {
      calls.push(init!);
      return { status: entry.status ?? 200, ok: entry.status === undefined || entry.status < 300,
        headers: "headers" in entry ? entry.headers : new Headers(signalHeaders()), body: { cancel: async () => { canceled++; } } } as Response;
    }, message => warnings.push(message), "session" in entry ? entry.session! : "session-A", null,
    entry.capability === false ? undefined : id => { ids.push(id); return "accepted"; });
    try {
      sender.select(image); await flush(); sender.select({ ...image, frame: "next.png" }); await flush();
      assert.deepEqual(ids, [], JSON.stringify(entry)); assert.deepEqual(calls.map(ack), [null, null]);
      assert.equal(canceled, 2);
      assert.deepEqual(warnings, entry.status === 409 ? ["externalDisplay: receiver reports another session owns the display (409); delivering without exclusivity"] : []);
      assert.deepEqual(calls.map(call => new Headers(call.headers).get("X-Emote-Sequence")), ["1", "2"]);
    } finally { sender.dispose(); }
  }
});

test("IDs at both bounds and loopback variants work without port heuristics", async () => {
  for (const [url, id] of [["http://localhost:8003/emote", "a"], ["http://[::1]:8123/emote", "x".repeat(128)], ["http://127.8.9.10/emote", "a_.:-9"]]) {
    const ids: string[] = [];
    const sender = new ExternalDisplays({ ...options, url }, async () => response(id), () => {}, "session-A", null, id => { ids.push(id); return "accepted"; });
    try { sender.select(image); await flush(); assert.deepEqual(ids, [id]); }
    finally { sender.dispose(); }
  }
});

test("pause, dispose, timeout and body-cancel races prevent late actions and receipt leakage", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const mode of ["pause", "dispose", "timeout", "cancel-pause"]) {
    const calls: RequestInit[] = [], ids: string[] = [];
    let release!: () => void;
    const sender = new ExternalDisplay(options, async (_url, init) => {
      calls.push(init!);
      if (calls.length > 1) return new Response();
      if (mode === "cancel-pause") return { ok: true, status: 200, headers: new Headers(signalHeaders()), body: { cancel: () => new Promise<void>(resolve => { release = resolve; }) } } as Response;
      return new Promise<Response>(resolve => { release = () => resolve(response()); });
    }, () => {}, "session-A", null, id => { ids.push(id); return "accepted"; });
    try {
      sender.select(image); await flush();
      if (mode === "dispose") sender.dispose();
      else if (mode === "timeout") t.mock.timers.tick(1000);
      else { sender.setPaused(true); sender.setPaused(false); }
      assert.equal(calls[0]!.signal!.aborted, true);
      release(); await flush(); await flush();
      assert.deepEqual(ids, []); assert.ok(calls.every(call => ack(call) === null));
    } finally { sender.dispose(); }
  }
});

test("pause clears an existing receipt and output gates never enable themselves", async () => {
  const calls: RequestInit[] = [];
  const sender = new ExternalDisplays(options, async (_url, init) => { calls.push(init!); return calls.length === 1 ? response() : new Response(); }, () => {}, "session-A", null, () => "accepted");
  try {
    sender.setDebugEnabled(false); sender.select(image); await flush(); assert.equal(calls.length, 0);
    sender.setDebugEnabled(true); await flush(); assert.equal(calls.length, 1);
    sender.setDebugEnabled(false); sender.select({ ...image, frame: "next.png" }); await flush(); assert.equal(calls.length, 1);
    sender.setDebugEnabled(true); await flush(); assert.deepEqual(calls.map(ack), [null, null]);
  } finally { sender.dispose(); }
});

test("one controller deduplicates local destinations but receipts stay per destination and never reach LAN or D200", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const executions: string[][] = [], calls: Array<{ url: string; init: RequestInit }> = [];
  const controller = createHerdrFocusController({ env, execFile: (_file, args) => { executions.push(args); return { kill: () => true }; } });
  const fetcher: typeof fetch = async (url, init) => { calls.push({ url: String(url), init: init! }); return String(url).includes(":8002") ? new Response() : response(); };
  const group = new ExternalDisplays({ enabled: true, targets: [options, { ...options, url: "http://localhost:8002/emote" }, { ...options, url: "http://localhost:8004/emote" }, { ...options, url: "http://matrix/emote" }] }, fetcher, () => {}, "session-A", null, id => controller.request(id));
  const d200 = createD200Display({ port: 8001, sessionId: "session-A", fetcher });
  try {
    group.select(image); d200.select(image); await flush();
    assert.equal(executions.length, 1);
    t.mock.timers.tick(5000); await flush();
    const heartbeats = calls.filter(call => call.url.endsWith("/heartbeat"));
    assert.deepEqual(heartbeats.map(call => ack(call.init)), ["click-1", null, "click-1", null, null]);
    assert.equal(executions.length, 1, "duplicate signals never re-execute");
    assert.ok(heartbeats.every(call => call.init.body === undefined));
  } finally { group.dispose(); d200.dispose(); controller.dispose(); }
});

test("receiver idle heartbeats carry signals; silence and localOff intentionally stop the channel", async t => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  t.mock.timers.enable({ apis: ["setInterval"] });
  for (const idleClock of ["receiver", "silence"]) {
    now = 0;
    const calls: RequestInit[] = [], ids: string[] = [];
    const sender = new ExternalDisplays({ ...options, idleClock }, async (_url, init) => { calls.push(init!); return response(); }, () => {}, "session-A", null, id => { ids.push(id); return "duplicate"; });
    try {
      sender.select(image); await flush();
      now = 301000; t.mock.timers.tick(301000); await flush(); await flush();
      const count = calls.length;
      t.mock.timers.tick(5000); await flush();
      assert.equal(calls.length, count + (idleClock === "receiver" ? 1 : 0));
      assert.equal(ids.length, calls.length);
      if (idleClock === "receiver") { assert.equal(calls.at(-1)!.body, undefined); assert.equal(ack(calls.at(-1)!), "click-1"); }
      sender.setDebugEnabled(false); t.mock.timers.tick(10000); await flush();
      assert.equal(ids.length, calls.length, "no requests or focus while localOff");
      assert.equal(calls.length, count + (idleClock === "receiver" ? 1 : 0));
    } finally { sender.dispose(); }
  }
});

test("missing Herdr context ignores actions without ACK", async () => {
  const controller = createHerdrFocusController({ env: {} });
  const calls: RequestInit[] = [];
  const sender = new ExternalDisplay(options, async (_url, init) => { calls.push(init!); return response(); }, () => {}, "session-A", null, id => controller.request(id));
  try { sender.select(image); await flush(); sender.select({ ...image, frame: "next.png" }); await flush(); assert.deepEqual(calls.map(ack), [null, null]); }
  finally { sender.dispose(); controller.dispose(); }
});

test("extension captures context once, shares dedup through board rebuild, and disposes queued old-session work", async t => {
  const root = mkdtempSync(join(tmpdir(), "emote-desktop-focus-"));
  const keys = ["PI_CODING_AGENT_DIR", "HOME", "USERPROFILE", "GENTLE_PI_AGENTS_CHILD", ...Object.keys(env)];
  const saved = keys.map(key => process.env[key]);
  const oldFetch = globalThis.fetch;
  const executions: Array<{ args: string[]; done: (error: Error | null) => void; killed: boolean }> = [];
  t.mock.method(childProcess, "execFile", (_file: string, args: string[], _options: unknown, done: (error: Error | null) => void) => {
    const execution = { args, done, killed: false }; executions.push(execution);
    return { kill: () => { execution.killed = true; return true; } };
  });
  syncBuiltinESMExports();
  const handlers = new Map<string, Function>(); let command: any;
  let id = "click-1", session = "session-A";
  const calls: RequestInit[] = [];
  try {
    Object.assign(process.env, env, { PI_CODING_AGENT_DIR: join(root, "agent"), HOME: root, USERPROFILE: root });
    delete process.env.GENTLE_PI_AGENTS_CHILD;
    const configDir = join(root, "agent", "extensions", "gentle-emote");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), JSON.stringify({ enabled: true, accent: "pink", externalDisplay: { enabled: true, targets: [options, { ...options, url: "http://localhost:8002/emote" }] } }));
    globalThis.fetch = async (_url, init) => { calls.push(init!); return new Response(null, { headers: signalHeaders(id, session) }); };
    const ctx = { hasUI: true, cwd: root, model: { id: "test" }, sessionManager: { getSessionId: () => session }, ui: { notify() {}, setWidget() {} } };
    const { default: extension } = await import("../src/index.ts");
    extension({ on: (name: string, handler: Function) => handlers.set(name, handler), registerCommand: (_name: string, value: any) => { command = value; }, getThinkingLevel: () => "high" } as any);
    await handlers.get("session_start")!({}, ctx);
    await command.handler("localOn", ctx); await command.handler("idle", ctx); await flush();
    assert.equal(executions.length, 1, "local destinations share a controller");
    assert.deepEqual(executions[0]!.args, ["agent", "focus", "pane-A"]);
    process.env.HERDR_PANE_ID = "pane-mutated";
    await command.handler("displayOn 192.168.1.10", ctx); await flush();
    assert.equal(executions[0]!.killed, false, "same-session sender rebuild keeps controller");
    assert.equal(executions.length, 1, "rebuild keeps dedup history");
    id = "click-2"; await command.handler("think", ctx); await flush();
    assert.equal(executions.length, 1, "second click is queued behind running focus");
    session = "session-B"; id = "click-3";
    await handlers.get("session_start")!({}, ctx); await command.handler("idle", ctx); await flush();
    assert.equal(executions[0]!.killed, true);
    executions[0]!.done(null); await flush();
    assert.equal(executions.length, 2, "old pending click cannot execute after restart");
    assert.deepEqual(executions[1]!.args, ["agent", "focus", "pane-mutated"]);
    await handlers.get("session_shutdown")!({}, ctx);
    assert.equal(executions[1]!.killed, true);
    assert.ok(calls.length > 0);
  } finally {
    await handlers.get("session_shutdown")?.({}, { hasUI: false });
    globalThis.fetch = oldFetch;
    keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
    t.mock.restoreAll(); syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});
