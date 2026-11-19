import { test } from "node:test";
import assert from "node:assert/strict";
import { ExternalDisplay, ExternalDisplays } from "../src/external_display.ts";
import { createHerdrFocusController } from "../src/herdr_focus.ts";
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
const signalHeaders = (id = "click-1", session = "session-A") => ({ "X-Emote-Action": "focus", "X-Emote-Action-Id": id, "X-Emote-Session-Id": session });
const response = (id = "click-1", session = "session-A") => new Response(null, { status: 204, headers: signalHeaders(id, session) });
const env = { HERDR_ENV: "1", HERDR_BIN_PATH: "/test/herdr", HERDR_SOCKET_PATH: "/test/socket", HERDR_PANE_ID: "pane-A" };
const confirmed = (pane = "pane-A") => JSON.stringify({ result: { type: "agent_info", agent: { pane_id: pane, focused: true } } });
function deferred() {
  let resolve!: (success: boolean) => void;
  const promise = new Promise<boolean>(done => { resolve = done; });
  return { promise, resolve };
}

test("204 frame and heartbeat signals ACK confirmed success next request, without parsing bodies", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const calls: Array<{ url: string; init: RequestInit }> = [], ids: string[] = [];
  let canceled = 0;
  const sender = new ExternalDisplay(options, async (url, init) => {
    calls.push({ url: String(url), init: init! });
    return { ok: true, status: 204, headers: new Headers(signalHeaders(`click-${calls.length}`)),
      body: { cancel: async () => { canceled++; } },
      json() { throw Error("must not parse"); }, text() { throw Error("must not parse"); },
    } as unknown as Response;
  }, () => {}, "session-A", null, async id => { ids.push(id); return true; });
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
    assert.ok(calls.every(call => new Headers(call.init.headers).get("X-Emote-Focus-Ack") === null));
    assert.deepEqual(calls.map(call => new Headers(call.init.headers).get("X-Emote-Sequence")), ["1", "2", "3"]);
  } finally { sender.dispose(); }
});

test("pending focus neither blocks HTTP queue nor ACKs; completion sends no extra requests", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  for (const success of [true, false]) {
    const result = deferred(), calls: RequestInit[] = [];
    const sender = new ExternalDisplay(options, async (_url, init) => { calls.push(init!); return response(); }, () => {}, "session-A", null, () => result.promise);
    try {
      sender.select(image); await flush();
      sender.select({ ...image, frame: "pending.png" }); await flush();
      t.mock.timers.tick(5000); await flush();
      assert.equal(calls.length, 3, "HTTP queue drains while subprocess is pending");
      assert.deepEqual(calls.map(ack), [null, null, null]);
      result.resolve(success); await flush();
      assert.equal(calls.length, 3, "completion creates no traffic or polling");
      sender.select({ ...image, frame: "complete.png" }); await flush();
      assert.equal(ack(calls[3]!), success ? "click-1" : null);
    } finally { sender.dispose(); }
  }
});

test("false, thrown and rejected focus preserve image delivery and last successful ACK", async () => {
  for (const failure of [() => Promise.resolve(false), () => Promise.reject(Error("focus failed")), () => { throw Error("spawn failed"); }]) {
    const calls: RequestInit[] = [];
    const sender = new ExternalDisplay(options, async (_url, init) => { calls.push(init!); return response(`click-${calls.length}`); }, () => {}, "session-A", null,
      id => id === "click-1" ? Promise.resolve(true) : failure());
    try {
      for (const frame of ["one.png", "two.png", "three.png"]) { sender.select({ ...image, frame }); await flush(); }
      assert.deepEqual(calls.map(ack), [null, "click-1", "click-1"]);
      assert.ok(calls.every(call => Buffer.isBuffer(call.body)));
    } finally { sender.dispose(); }
  }
});

test("missing/wrong action or session echo, duplicate headers, bad IDs/status/path and excluded senders are inert", async () => {
  const without = (name: string) => { const headers = new Headers(signalHeaders()); headers.delete(name); return { headers }; };
  const cases: Array<{ url?: string; session?: string | null; headers?: unknown; status?: number; capability?: boolean }> = [
    without("X-Emote-Action"), without("X-Emote-Session-Id"), without("X-Emote-Action-Id"),
    ...["exec", "Focus", "focus, focus"].map(action => ({ headers: new Headers({ ...signalHeaders(), "X-Emote-Action": action }) })),
    ...["other-session", "session-a", "session-A, session-A"].map(session => ({ headers: new Headers(signalHeaders("click-1", session)) })),
    ...["", "x".repeat(129), "a b", "a/b", "a\n", "a;cmd", "é", "click-1, click-1"].map(id => ({ headers: { get: (name: string) => name === "X-Emote-Action-Id" ? id : new Headers(signalHeaders()).get(name) } })),
    { headers: new Headers({ "X-Emote-Focus-Request-Id": "click-1", "X-Emote-Focus-Ack": "click-1" }) },
    { headers: new Headers({ "X-Emote-Focus-Request-Id": "click-1", "X-Emote-Action": "focus", "X-Emote-Session-Id": "session-A" }) },
    ...[199, 200, 201, 202, 205, 206, 299, 300, 404, 409, 500].map(status => ({ status })),
    { url: "http://192.168.1.10/emote" }, { url: `${options.url}?x=1` }, { url: `${options.url}/` },
    { url: "http://localhost/custom" }, { session: null }, { session: "bad session" }, { capability: false },
    { headers: undefined }, { headers: {} }, { headers: { get: () => { throw Error("bad mock"); } } }, { headers: new Headers() },
  ];
  for (const entry of cases) {
    const calls: RequestInit[] = [], ids: string[] = [], warnings: string[] = [];
    let canceled = 0;
    const sender = new ExternalDisplay({ ...options, url: entry.url ?? options.url }, async (_url, init) => {
      calls.push(init!);
      return { status: entry.status ?? 204, ok: entry.status === undefined || entry.status < 300,
        headers: "headers" in entry ? entry.headers : new Headers(signalHeaders()), body: { cancel: async () => { canceled++; } } } as Response;
    }, message => warnings.push(message), "session" in entry ? entry.session! : "session-A", null,
    entry.capability === false ? undefined : async id => { ids.push(id); return true; });
    try {
      sender.select(image); await flush(); sender.select({ ...image, frame: "next.png" }); await flush();
      assert.deepEqual(ids, [], JSON.stringify(entry)); assert.deepEqual(calls.map(ack), [null, null]);
      assert.equal(canceled, 2);
      assert.deepEqual(warnings, entry.status === 409 ? ["externalDisplay: receiver reports another session owns the display (409); delivering without exclusivity"] : []);
      assert.deepEqual(calls.map(call => new Headers(call.headers).get("X-Emote-Sequence")), ["1", "2"]);
    } finally { sender.dispose(); }
  }
});

test("all three generic headers with exact session echo accept ID bounds and loopback variants", async () => {
  for (const [url, id] of [["http://localhost:8003/emote", "a"], ["http://[::1]:8123/emote", "x".repeat(128)], ["http://127.8.9.10/emote", "a_.:-9"]]) {
    const calls: RequestInit[] = [], ids: string[] = [];
    const sender = new ExternalDisplays({ ...options, url }, async (_url, init) => {
      calls.push(init!);
      return new Response(null, { status: 204, headers: { ...signalHeaders(id), "X-Emote-Focus-Request-Id": "superseded-id" } });
    }, () => {}, "session-A", null, async id => { ids.push(id); return true; });
    try {
      sender.select(image); await flush(); sender.select({ ...image, frame: "next.png" }); await flush();
      assert.deepEqual(ids, [id, id]); assert.deepEqual(calls.map(ack), [null, id]);
    } finally { sender.dispose(); }
  }
});

test("pause, dispose, timeout and body-cancel races prevent late response signals", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const mode of ["pause", "dispose", "timeout", "cancel-pause"]) {
    const calls: RequestInit[] = [], ids: string[] = [];
    let release!: () => void;
    const sender = new ExternalDisplay(options, async (_url, init) => {
      calls.push(init!);
      if (calls.length > 1) return new Response();
      if (mode === "cancel-pause") return { ok: true, status: 204, headers: new Headers(signalHeaders()), body: { cancel: () => new Promise<void>(resolve => { release = resolve; }) } } as Response;
      return new Promise<Response>(resolve => { release = () => resolve(response()); });
    }, () => {}, "session-A", null, async id => { ids.push(id); return true; });
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

test("pause/resume and disposal invalidate asynchronous focus even after its HTTP request drained", async () => {
  for (const mode of ["pause", "dispose", "rebuild"]) {
    const result = deferred(), calls: RequestInit[] = [];
    let requests = 0, focusCalls = 0;
    const fetcher: typeof fetch = async (_url, init) => { calls.push(init!); return ++requests === 1 ? response() : new Response(); };
    const sender = new ExternalDisplay(options, fetcher, () => {}, "session-A", null, () => { focusCalls++; return result.promise; });
    let replacement: ExternalDisplay | undefined;
    try {
      sender.select(image); await flush();
      assert.equal(focusCalls, 1, "focus started before lifecycle changed");
      assert.equal(calls[0]!.signal!.aborted, false, "HTTP request already drained");
      if (mode === "pause") { sender.setPaused(true); sender.setPaused(false); }
      else {
        sender.dispose();
        replacement = new ExternalDisplay(options, fetcher, () => {}, "session-A", null, () => result.promise);
        replacement.select(image);
      }
      await flush(); result.resolve(true); await flush();
      (replacement ?? sender).select({ ...image, frame: "late.png" }); await flush();
      assert.ok(calls.every(call => ack(call) === null), mode);
      if (replacement) assert.notEqual(new Headers(calls[0]!.headers).get("X-Emote-Stream-Id"), new Headers(calls[1]!.headers).get("X-Emote-Stream-Id"));
    } finally { sender.dispose(); replacement?.dispose(); }
  }
});

test("older asynchronous completion cannot overwrite a newer relevant request, including repeated newer responses", async () => {
  for (const newerSuccess of [true, false]) {
    const old = deferred(), newer = deferred(), calls: RequestInit[] = [];
    const sender = new ExternalDisplay(options, async (_url, init) => { calls.push(init!); return response(calls.length === 1 ? "old" : "new"); }, () => {}, "session-A", null,
      id => id === "old" ? old.promise : newer.promise);
    try {
      sender.select(image); await flush(); sender.select({ ...image, frame: "new.png" }); await flush();
      newer.resolve(newerSuccess); await flush(); old.resolve(true); await flush();
      sender.select({ ...image, frame: "last.png" }); await flush();
      assert.deepEqual(calls.map(ack), [null, null, newerSuccess ? "new" : null]);
    } finally { sender.dispose(); }
  }
});

test("pause clears confirmed ACK and local output gates never enable themselves", async () => {
  const calls: RequestInit[] = [];
  const sender = new ExternalDisplays(options, async (_url, init) => { calls.push(init!); return calls.length === 1 ? response() : new Response(); }, () => {}, "session-A", null, async () => true);
  try {
    sender.setDebugEnabled(false); sender.select(image); await flush(); assert.equal(calls.length, 0);
    sender.setDebugEnabled(true); await flush(); assert.equal(calls.length, 1);
    sender.select({ ...image, frame: "confirmed.png" }); await flush();
    assert.deepEqual(calls.map(ack), [null, "click-1"]);
    sender.setDebugEnabled(false); sender.select({ ...image, frame: "next.png" }); await flush(); assert.equal(calls.length, 2);
    sender.setDebugEnabled(true); await flush(); assert.deepEqual(calls.map(ack), [null, "click-1", null]);
  } finally { sender.dispose(); }
});

test("shared controller deduplicates locals, but ACKs stay per destination and never reach LAN or arbitrary-port D200", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const executions: string[][] = [], calls: Array<{ url: string; init: RequestInit }> = [];
  let complete!: (error: Error | null, stdout: string, stderr: string) => void;
  const controller = createHerdrFocusController({ env, execFile: (_file, args, _options, done) => { executions.push(args); complete = done; return { kill: () => true }; } });
  const fetcher: typeof fetch = async (url, init) => { calls.push({ url: String(url), init: init! }); return String(url).includes(":8002") ? new Response() : response(); };
  const group = new ExternalDisplays({ enabled: true, targets: [options, { ...options, url: "http://localhost:8002/emote" }, { ...options, url: "http://localhost:8004/emote" }, { ...options, url: "http://matrix/emote" }] }, fetcher, () => {}, "session-A", null, id => controller.request(id));
  const d200 = createD200Display({ port: 8001, sessionId: "session-A", fetcher });
  try {
    group.select(image); d200.select(image); await flush();
    assert.equal(executions.length, 1);
    t.mock.timers.tick(5000); await flush();
    assert.ok(calls.every(call => ack(call.init) === null));
    complete(null, confirmed(), ""); await flush();
    t.mock.timers.tick(5000); await flush();
    const heartbeats = calls.filter(call => call.url.endsWith("/heartbeat")).slice(-5);
    assert.deepEqual(heartbeats.map(call => ack(call.init)), ["click-1", null, "click-1", null, null]);
    assert.equal(executions.length, 1, "duplicate success never re-executes");
    assert.ok(heartbeats.every(call => call.init.body === undefined));
  } finally { group.dispose(); d200.dispose(); controller.dispose(); }
});

test("failed and missing-context duplicates never ACK or re-execute", async () => {
  for (const context of [env, {}]) {
    let executions = 0;
    const controller = createHerdrFocusController({ env: context, execFile: (_file, _args, _options, done) => {
      executions++; done(null, confirmed("moved-pane"), ""); return { kill: () => true };
    } });
    const calls: RequestInit[] = [];
    const sender = new ExternalDisplay(options, async (_url, init) => { calls.push(init!); return response(); }, () => {}, "session-A", null, id => controller.request(id));
    try {
      for (const frame of ["one.png", "two.png", "three.png"]) { sender.select({ ...image, frame }); await flush(); }
      assert.deepEqual(calls.map(ack), [null, null, null]);
      assert.equal(executions, context === env ? 1 : 0);
    } finally { sender.dispose(); controller.dispose(); }
  }
});

test("receiver idle heartbeats carry signals; silence and localOff intentionally stop the channel", async t => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  t.mock.timers.enable({ apis: ["setInterval"] });
  for (const idleClock of ["receiver", "silence"]) {
    now = 0;
    const calls: RequestInit[] = [], ids: string[] = [];
    const sender = new ExternalDisplays({ ...options, idleClock }, async (_url, init) => { calls.push(init!); return response(); }, () => {}, "session-A", null, async id => { ids.push(id); return true; });
    try {
      sender.select(image); await flush();
      now = 301000; t.mock.timers.tick(301000); await flush(); await flush();
      const count = calls.length;
      t.mock.timers.tick(5000); await flush();
      assert.equal(calls.length, count + (idleClock === "receiver" ? 1 : 0));
      assert.equal(ids.length, calls.length);
      if (idleClock === "receiver") { assert.equal(calls.at(-1)!.body, undefined); assert.equal(ack(calls.at(-1)!), "click-1"); }
      sender.setDebugEnabled(false); t.mock.timers.tick(10000); await flush();
      assert.equal(ids.length, calls.length);
      assert.equal(calls.length, count + (idleClock === "receiver" ? 1 : 0));
    } finally { sender.dispose(); }
  }
});

test("extension captures context once, retains dedup on board rebuild, and disposes old-session focus", async t => {
  const root = mkdtempSync(join(tmpdir(), "emote-desktop-focus-"));
  const keys = ["PI_CODING_AGENT_DIR", "HOME", "USERPROFILE", "GENTLE_PI_AGENTS_CHILD", ...Object.keys(env)];
  const saved = keys.map(key => process.env[key]);
  const oldFetch = globalThis.fetch;
  const executions: Array<{ args: string[]; done: (error: Error | null, stdout: string, stderr: string) => void; killed: boolean }> = [];
  t.mock.method(childProcess, "execFile", (_file: string, args: string[], _options: unknown, done: (error: Error | null, stdout: string, stderr: string) => void) => {
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
    globalThis.fetch = async (_url, init) => { calls.push(init!); return response(id, session); };
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
    assert.equal(executions.length, 1, "second click waits behind running focus");
    session = "session-B"; id = "click-3";
    await handlers.get("session_start")!({}, ctx); await command.handler("idle", ctx); await flush();
    assert.equal(executions[0]!.killed, true);
    executions[0]!.done(null, confirmed(), ""); await flush();
    assert.equal(executions.length, 2, "old pending click cannot execute after restart");
    assert.deepEqual(executions[1]!.args, ["agent", "focus", "pane-mutated"]);
    await command.handler("think", ctx); await flush();
    assert.ok(calls.every(call => ack(call) === null), "restart cannot inherit late old-session success");
    await handlers.get("session_shutdown")!({}, ctx);
    assert.equal(executions[1]!.killed, true);
    executions[1]!.done(null, confirmed("pane-mutated"), ""); await flush();
    assert.ok(calls.every(call => ack(call) === null));
  } finally {
    await handlers.get("session_shutdown")?.({}, { hasUI: false });
    globalThis.fetch = oldFetch;
    keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
    t.mock.restoreAll(); syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});
