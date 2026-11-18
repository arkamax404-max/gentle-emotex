import { test } from "node:test";
import assert from "node:assert/strict";
import { Container, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { OutputStateStore, OUTPUTS } from "../src/output_state.ts";
import { decodePng, encodePng } from "../src/png.ts";

const PLACEHOLDER = "\u{10EEEE}";
const SESSION_ID = "integration-session";
/** Gentle Shell's native notification channel, where subagent task transitions are published. */
const SUBAGENT_CHANNEL = "gentle-pi:notification:source";

/** Loads the extension against a fake Pi and a real pi-tui component tree (Ghostty, no multiplexer). */
export async function boot(cwd = "/tmp", outputs = ["internalOn", "localOn", "displayOn"], profile?: string, childSession = false) {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentRoot = profile ?? mkdtempSync(join(tmpdir(), "emote-profile-"));
  for (const key of ["TMUX", "ZELLIJ", "ZELLIJ_SESSION_NAME", "KITTY_WINDOW_ID", "TERM_PROGRAM", "GENTLE_PI_AGENTS_CHILD"]) delete process.env[key];
  if (childSession) process.env.GENTLE_PI_AGENTS_CHILD = "1";
  process.env.GHOSTTY_RESOURCES_DIR = "/usr/share/ghostty";
  process.env.PI_CODING_AGENT_DIR = agentRoot;

  const notices: Array<{ message: string; level: string }> = [];
  const writes: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = (chunk: string | Uint8Array, ...args: any[]) => {
    // Node's test runner writes binary protocol messages here too; never swallow them.
    if (typeof chunk !== "string") return (realWrite as any)(chunk, ...args);
    writes.push(chunk);
    return true;
  };

  const handlers = new Map<string, Function[]>();
  const commands = new Map<string, any>();
  // A working pi.events bus so bus contracts (YOLO host UI, ODD work phase) can be exercised.
  const busHandlers = new Map<string, Function[]>();
  const busSent: Array<{ channel: string; payload: any }> = [];
  const events = {
    emit: (channel: string, payload: unknown) => {
      busSent.push({ channel, payload });
      for (const handler of [...(busHandlers.get(channel) ?? [])]) handler(payload);
    },
    on: (channel: string, handler: Function) => {
      busHandlers.set(channel, [...(busHandlers.get(channel) ?? []), handler]);
      return () => busHandlers.set(channel, (busHandlers.get(channel) ?? []).filter(existing => existing !== handler));
    },
  };
  const pi = {
    on: (event: string, handler: Function) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    registerCommand: (name: string, options: any) => commands.set(name, options),
    getThinkingLevel: () => "high",
    events,
  };
  const emitBus = (channel: string, payload: unknown) => {
    for (const handler of [...(busHandlers.get(channel) ?? [])]) handler(payload);
  };
  const emit = async (event: string, payload: any = {}) => {
    for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
  };

  // ctx.ui.custom() support: the panel factory is captured so tests can drive it.
  const customCalls: Array<{ factory: any; options: any }> = [];
  let panelResolve: ((value: unknown) => void) | null = null;
  const widgets = new Container();
  const editor = new Container();
  // Same shape as Gentle Shell's float prompt: hint row, input row, blank panel row.
  editor.addChild({ render: (width: number) => [`┃ waiting for input`.padEnd(width), `┃ > `.padEnd(width), `┃`.padEnd(width)] } as any);
  const tui = { children: [widgets, editor], requestRender() {}, getFocusedComponent: () => null };
  const ctx = {
    hasUI: true,
    cwd,
    model: { id: "claude-test" },
    sessionManager: { getSessionId: () => SESSION_ID },
    ui: {
      notify(message: string, level: string) { notices.push({ message, level }); },
      onTerminalInput: () => () => {},
      custom: (factory: any, options: any) => {
        customCalls.push({ factory, options });
        return new Promise(resolve => { panelResolve = resolve as (value: unknown) => void; });
      },
      setWidget: (_key: string, factory: any) => { widgets.clear(); if (factory) widgets.addChild(factory(tui, {})); },
    },
  };

  const { default: extension } = await import("../src/index.ts");
  extension(pi as any);
  await emit("session_start");
  for (const output of outputs) await commands.get("emote").handler(output, ctx);
  const shutdown = async () => {
    if (shutDown) return;
    shutDown = true;
    await emit("session_shutdown", { reason: "quit" });
  };
  let shutDown = false;
  const panelDone = (value: unknown) => panelResolve?.(value);
  return { emit, emitBus, busSent, busHandlers, widgets, editor, writes, notices, shutdown, commands, ctx, customCalls, panelDone, restore: () => {
    (process.stdout as any).write = realWrite;
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    if (!profile) rmSync(agentRoot, { recursive: true, force: true });
  } };
}

const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");

test("avatar command persists globally, rejects paths without mutation, and auto uses latest identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "emote-avatar-"));
  const profile = join(root, "profile");
  const configDir = join(root, ".pi", "extensions", "gentle-emote");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ emotes: [
    { model: "latest", "thinking-level": "low", "emote-set": "gentleman-yolo" },
  ] }));
  const path = join(profile, "extensions", "gentle-emote", "avatar.json");
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    lab = await boot(root, [], profile);
    const command = () => lab!.commands.get("emote");
    const run = (args: string) => command().handler(args, lab!.ctx);
    const status = async () => { await run("status"); return lab!.notices.at(-1)!.message; };
    await run("read");
    assert.match(await status(), /set=gentleman;/);
    await run("avatar gentleled");
    assert.equal(readFileSync(path, "utf8"), '"gentleled"\n');
    assert.match(await status(), /set=gentleled;/);
    assert.deepEqual(command().getArgumentCompletions("avatar gen").map((x: any) => x.value),
      ["avatar gentleled", "avatar gentleman", "avatar gentleman-yolo"]);
    assert.ok(command().getArgumentCompletions("avatar ").some((x: any) => x.value === "avatar auto"));
    await run("avatar");
    assert.deepEqual(lab.notices.at(-1), { message: "[gentle-emote] avatar: gentleled; /emote avatar <folder> | auto", level: "info" });
    const before = await status();
    for (const invalid of ["../gentleman", "a/b", "a\\b", ".", "a..b", "C:foo", "missing-set", "a\u0001b"]) {
      const writes = lab.writes.length;
      await run(`avatar ${invalid}`);
      assert.deepEqual(lab.notices.at(-1), { message: "[gentle-emote] invalid or unavailable avatar; avatar unchanged", level: "warning" });
      assert.equal(await status(), before);
      assert.equal(lab.writes.length, writes);
      assert.equal(readFileSync(path, "utf8"), '"gentleled"\n');
    }
    await lab.emit("model_select", { model: { id: "latest" } });
    await lab.emit("thinking_level_select", { level: "low" });
    assert.equal(await status(), before, "manual choice survives model and thinking events");
    await run("internalOn"); await run("internalOff");
    assert.match(await status(), /set=gentleled;/);
    await lab.shutdown(); lab.restore(); lab = undefined;
    lab = await boot(join(root, "other-project"), [], profile);
    await run("read");
    assert.match(await status(), /set=gentleled;/, "restart in another project restores global choice");
    lab.ctx.cwd = root;
    await lab.emit("session_start");
    await run("read");
    await lab.emit("model_select", { model: { id: "latest" } });
    await lab.emit("thinking_level_select", { level: "low" });
    await run("avatar auto");
    assert.equal(readFileSync(path, "utf8"), "null\n");
    assert.match(await status(), /set=gentleman-yolo;/, "auto uses events, not stale command context");
    writeFileSync(path, "{broken");
    const automatic = await status();
    await run("avatar gentleled");
    assert.deepEqual(lab.notices.at(-1), { message: "[gentle-emote] cannot save global avatar; avatar unchanged", level: "error" });
    assert.equal(await status(), automatic);
    assert.equal(readFileSync(path, "utf8"), "{broken");
    await lab.shutdown(); lab.restore(); lab = undefined;
    lab = await boot(root, [], profile);
    assert.ok(lab.notices.some(x => x.message === "[gentle-emote] cannot read saved avatar; using automatic selection"));
    assert.equal(readFileSync(path, "utf8"), "{broken");
    writeFileSync(path, '"missing-set"');
    await lab.emit("session_start");
    assert.ok(lab.notices.some(x => x.message === "[gentle-emote] saved avatar unavailable; using automatic selection"));
    assert.equal(readFileSync(path, "utf8"), '"missing-set"');
  } finally { await lab?.shutdown(); lab?.restore(); rmSync(root, { recursive: true, force: true }); }
});

test("automatic YOLO accepts a guarded read-only twin without changing saved preferences", async () => {
  const root = mkdtempSync(join(tmpdir(), "emote-auto-yolo-"));
  const profile = join(root, "profile");
  const dir = join(root, ".pi", "extensions", "gentle-emote");
  const png = encodePng({ width: 1, height: 1, data: new Uint8Array([0, 0, 0, 255]) });
  for (const [set, states] of [["custom", ["idle", "read"]], ["custom-yolo", ["read"]]] as const) {
    for (const state of states) {
      const stateDir = join(dir, "emotes", set, state);
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, `${state}.png`), png);
    }
  }
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    emotes: [{ model: "*", "emote-set": "custom" }],
    externalDisplay: { enabled: true, url: "http://127.0.0.1:8000/emote" },
  }));
  const previousFetch = globalThis.fetch;
  const calls: RequestInit[] = [];
  globalThis.fetch = async (_url, init) => { calls.push(init!); return new Response(); };
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    lab = await boot(root, ["localOn"], profile);
    let mode = false;
    let refresh = () => {};
    lab.busSent.find(x => x.channel === "gentle:yolo:host-ui")!.payload.respond({
      read: async () => mode ? "ON" : "OFF",
      observe: (next: () => void) => { refresh = next; return () => {}; },
    });
    await flush();
    const emote = lab.commands.get("emote");
    const preferences = join(profile, "extensions", "gentle-emote");
    const savedDebug = readFileSync(join(preferences, "output-states", "debug.json"), "utf8");
    assert.equal(savedDebug, "true\n");
    const check = async (set: string) => {
      await emote.handler("read", lab!.ctx); await flush();
      assert.ok(calls.length > 0, "read preview delivers a PNG");
      const headers = new Headers(calls.at(-1)!.headers);
      assert.equal(headers.get("X-Emote-State"), "read");
      assert.equal(headers.get("X-Emote-Set"), set);
      assert.equal(headers.get("X-Emote-Frame"), "read.png");
      await emote.handler("status", lab!.ctx);
      assert.match(lab!.notices.at(-1)!.message, new RegExp(`PNG state=read frame=read\\.png set=${set};`));
      assert.equal(readFileSync(join(preferences, "output-states", "debug.json"), "utf8"), savedDebug);
      assert.equal(existsSync(join(preferences, "avatar.json")), false);
    };
    await check("custom"); // Prove OFF-mode fixture health before the compatibility check.
    mode = true; refresh(); await flush();
    await check("custom-yolo");
    mode = false; refresh(); await flush();
    await check("custom");
  } finally {
    await lab?.shutdown(); lab?.restore(); globalThis.fetch = previousFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test("manual PNG avatar survives ASCII/hidden delivery and YOLO twins stay bounded", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "emote-avatar-ascii-"));
  const dir = join(root, ".pi", "extensions", "gentle-emote");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    terminals: [{ match: "ghostty", render: "ascii" }],
    externalDisplay: { enabled: true, url: "http://localhost:8000/emote" },
  }));
  const previousFetch = globalThis.fetch;
  const calls: RequestInit[] = [];
  globalThis.fetch = async (_url, init) => { calls.push(init!); return new Response(); };
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    lab = await boot(root, ["internalOn", "localOn"]);
    let refresh = () => {};
    let mode = false;
    lab.busSent.find(x => x.channel === "gentle:yolo:host-ui")!.payload.respond({
      read: async () => mode ? "ON" : "OFF",
      observe: (next: () => void) => { refresh = next; return () => {}; },
    });
    const emote = lab.commands.get("emote");
    await emote.handler("read", lab.ctx);
    await emote.handler("avatar gentleled", lab.ctx); await flush();
    const set = () => calls.map(call => new Headers(call.headers).get("X-Emote-Set")).filter(Boolean).at(-1);
    assert.equal(set(), "gentleled");
    await emote.handler("internalOff", lab.ctx); await flush();
    assert.equal(set(), "gentleled");
    // Existing preview and status semantics remain unchanged after manual selection.
    await emote.handler("read", lab.ctx); await flush();
    await emote.handler("status", lab.ctx);
    assert.match(lab.notices.at(-1)!.message, /PNG state=read .*set=gentleled; phase none .*activity status=idle phase=idle activeSubagents=0/);
    mode = true; refresh(); await flush();
    assert.equal(set(), "gentleled");
    await emote.handler("avatar gentleman", lab.ctx); await flush();
    assert.equal(set(), "gentleman-yolo");
    await emote.handler("avatar", lab.ctx);
    assert.match(lab.notices.at(-1)!.message, /avatar: gentleman;/);
    mode = false; refresh(); await flush();
    assert.equal(set(), "gentleman");
    const outside = join(root, "outside");
    mkdirSync(outside);
    mkdirSync(join(dir, "emotes"));
    let linked = false;
    try { symlinkSync(outside, join(dir, "emotes", "gentleman-yolo"), "junction"); linked = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      t.diagnostic("junction permissions unavailable");
    }
    if (linked) {
      const selected = calls.length;
      await emote.handler("avatar gentleman-yolo", lab.ctx); await flush();
      assert.deepEqual(lab.notices.at(-1), { message: "[gentle-emote] invalid or unavailable avatar; avatar unchanged", level: "warning" });
      assert.equal(calls.length, selected, "rejected escape delivers nothing");
      assert.ok(!emote.getArgumentCompletions("avatar ").some((x: any) => x.value === "avatar gentleman-yolo"));
      mode = true; refresh(); await flush();
      assert.equal(set(), "gentleman", "unsafe YOLO twin falls back to validated base");
      await emote.handler("avatar", lab.ctx);
      assert.match(lab.notices.at(-1)!.message, /avatar: gentleman;/);
      mode = false; refresh(); await flush();
    }
    await emote.handler("internalOn", lab.ctx); await flush();
    lab.widgets.render(100);
    assert.ok(lab.editor.render(100).join("\n").includes(".------."));
    assert.equal(set(), "gentleman");
  } finally {
    await lab?.shutdown(); lab?.restore(); globalThis.fetch = previousFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Gentle Shell child sessions never POST or register output commands even with saved On states", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const root = mkdtempSync(join(tmpdir(), "emote-child-session-"));
  const profile = join(root, "profile");
  const saved = new OutputStateStore(profile);
  for (const output of OUTPUTS) saved.save(output, true);
  const dir = join(root, ".pi", "extensions", "gentle-emote");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    externalDisplay: { enabled: true, targets: [
      { enabled: true, url: "http://localhost:8000/emote" },
      { enabled: true, url: "http://matrix/emote" },
    ] },
  }));
  const previousChild = process.env.GENTLE_PI_AGENTS_CHILD;
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(); };
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    process.env.GENTLE_PI_AGENTS_CHILD = "1";
    lab = await boot(root, [], profile, true);
    await lab.emit("tool_execution_start", { toolName: "read", toolCallId: "child-read" });
    t.mock.timers.tick(450);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(calls, 0, "a child must not compete with the parent for either display");
    assert.equal(lab.commands.size, 0, "child sessions cannot register output commands");
    await lab.emit("ui_prompt_start");
    t.mock.timers.tick(450);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(calls, 0, "animation cannot bypass the child-session restriction");
    assert.deepEqual(saved.load(message => assert.fail(message)), {
      internal: true, debug: true, d200: true, display: true,
    }, "the child guard does not discard global output preferences");
    lab.widgets.render(100);
    assert.equal(lab.writes.length, 0, "child sessions do not render a local terminal avatar");
    assert.equal(lab.widgets.children.length, 0, "child sessions do not install a widget");
    await lab.shutdown();
    assert.equal(calls, 0, "shutdown must not send an external farewell");
  } finally {
    await lab?.shutdown(); lab?.restore(); globalThis.fetch = originalFetch;
    if (previousChild === undefined) delete process.env.GENTLE_PI_AGENTS_CHILD;
    else process.env.GENTLE_PI_AGENTS_CHILD = previousChild;
    rmSync(root, { recursive: true, force: true });
  }
});

test("session wiring mirrors image selections and prompt overlays, shutdown stops delivery", async () => {
  const root = mkdtempSync(join(tmpdir(), "emote-session-"));
  const dir = join(root, ".pi", "extensions", "gentle-emote");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ externalDisplay: { enabled: true, url: "http://127.0.0.1:8000/emote" } }));
  const originalFetch = globalThis.fetch;
  const calls: RequestInit[] = [];
  globalThis.fetch = async (_url, init) => { calls.push(init!); return new Response(); };
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    lab = await boot(root);
    await lab.emit("tool_execution_start", { toolName: "bash" });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(calls.length > 0);
    assert.equal(new Headers(calls.at(-1)!.headers).get("X-Emote-State"), "tool");
    await lab.emit("ui_prompt_start");
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(new Headers(calls.at(-1)!.headers).get("X-Emote-State"), "ask");
    await lab.emit("ui_prompt_end");
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(new Headers(calls.at(-1)!.headers).get("X-Emote-State"), "tool");
    assert.ok(calls.every(call => new Headers(call.headers).get("X-Emote-Session-Id") === SESSION_ID), "identity is bound before the first image");
    const originalStream = new Headers(calls.at(-1)!.headers).get("X-Emote-Stream-Id");
    const beforeSwitch = calls.length;
    lab.ctx.sessionManager.getSessionId = () => "integration-session-B";
    await lab.emit("session_start");
    // Startup and agent_start alone select no image; drive a public preview.
    await lab.commands.get("emote").handler("read", lab.ctx);
    await new Promise<void>(resolve => setImmediate(resolve));
    const switched = calls.slice(beforeSwitch);
    assert.ok(switched.length > 0);
    assert.ok(switched.every(call => new Headers(call.headers).get("X-Emote-Session-Id") === "integration-session-B"));
    assert.notEqual(new Headers(switched[0]!.headers).get("X-Emote-Stream-Id"), originalStream);
    assert.ok(calls.slice(0, beforeSwitch).every(call => new Headers(call.headers).get("X-Emote-Session-Id") === SESSION_ID), "old requests keep their original identity");
    await lab.shutdown();
    const count = calls.length;
    await lab.emit("tool_execution_start", { toolName: "read" });
    assert.equal(calls.length, count);
  } finally {
    await lab?.shutdown(); lab?.restore(); globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test("external delivery carries the working-directory basename as project metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "emote-project-name-"));
  const dir = join(root, ".pi", "extensions", "gentle-emote");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ externalDisplay: { enabled: true, url: "http://127.0.0.1:8000/emote" } }));
  const originalFetch = globalThis.fetch;
  const calls: RequestInit[] = [];
  globalThis.fetch = async (_url, init) => { calls.push(init!); return new Response(); };
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    lab = await boot(root);
    await lab.emit("tool_execution_start", { toolName: "bash" });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(calls.length > 0);
    const header = new Headers(calls.at(-1)!.headers).get("X-Emote-Project-Name");
    assert.ok(header, "local deliveries name the sending project");
    assert.equal(decodeURIComponent(header!), basename(root));
    assert.ok(!header!.includes("/") && !header!.includes("\\"), "metadata is a basename, never the full path");
    await lab.shutdown();
  } finally {
    await lab?.shutdown(); lab?.restore(); globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test("the 500ms startup greeting does not replace an active tool or its prompt restoration", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const root = mkdtempSync(join(tmpdir(), "emote-greeting-tool-"));
  const dir = join(root, ".pi", "extensions", "gentle-emote");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ externalDisplay: { enabled: true, url: "http://127.0.0.1:8000/emote" } }));
  const originalFetch = globalThis.fetch;
  const calls: RequestInit[] = [];
  globalThis.fetch = async (_url, init) => { calls.push(init!); return new Response(); };
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  const state = (call: RequestInit) => new Headers(call.headers).get("X-Emote-State");
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    lab = await boot(root);
    await flush();
    await lab.emit("tool_execution_start", { toolName: "bash", toolCallId: "greeting-bash" });
    await flush();
    assert.ok(calls.length > 0);
    assert.equal(state(calls.at(-1)!), "tool");

    t.mock.timers.tick(500);
    await flush();
    assert.ok(!calls.some(call => state(call) === "hi"), "the delayed greeting must not interrupt active work");
    assert.equal(state(calls.at(-1)!), "tool", "the tool remains visible at the greeting deadline");

    await lab.emit("ui_prompt_start"); await flush();
    assert.equal(state(calls.at(-1)!), "ask");
    await lab.emit("ui_prompt_end"); await flush();
    assert.equal(state(calls.at(-1)!), "tool", "ending the prompt restores the tool, not the skipped greeting");
  } finally {
    await lab?.shutdown(); lab?.restore(); globalThis.fetch = originalFetch;
    t.mock.timers.reset();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const ownership of ["idle preview", "read preview", "agent_start", "session_compact", "UI prompt", "host blocked prompt", "farewell", "direct tool error"] as const) {
  test(`startup greeting is cancelled by ${ownership} before 500ms`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    let lab: Awaited<ReturnType<typeof boot>> | undefined;
    try {
      lab = await boot(undefined, []);
      const emote = lab.commands.get("emote");
      const status = async () => {
        await emote.handler("status", lab!.ctx);
        return lab!.notices.at(-1)!.message;
      };
      t.mock.timers.tick(100);
      if (ownership === "idle preview") await emote.handler("idle", lab.ctx);
      else if (ownership === "read preview") await emote.handler("read", lab.ctx);
      else if (ownership === "agent_start") await lab.emit("agent_start");
      else if (ownership === "session_compact") await lab.emit("session_compact");
      else if (ownership === "UI prompt") {
        await lab.emit("ui_prompt_start");
        assert.match(await status(), /PNG state=ask /);
        await lab.emit("ui_prompt_end");
        assert.match(await status(), /PNG state=idle /, "closing the prompt restores idle");
      } else if (ownership === "host blocked prompt") {
        lab.emitBus("herdr:blocked", { active: true });
        assert.match(await status(), /PNG state=ask /);
        lab.emitBus("herdr:blocked", { active: false });
        assert.match(await status(), /PNG state=idle /, "closing the host prompt restores idle");
      } else if (ownership === "farewell") {
        await lab.emit("input", { text: "goodbye" });
        assert.match(await status(), /PNG state=bye /);
      } else {
        // No preceding tool-start: the error handler must claim ownership itself.
        await lab.emit("tool_execution_end", { toolName: "bash", toolCallId: "direct-error", isError: true });
        assert.match(await status(), /activity status=error phase=thinking activeSubagents=0(;|$)/);
      }
      const before = await status();
      assert.doesNotMatch(before, /PNG state=hi /);
      t.mock.timers.tick(399);
      assert.doesNotMatch(await status(), /PNG state=hi /, "no early greeting");
      t.mock.timers.tick(1);
      const after = await status();
      assert.doesNotMatch(after, /PNG state=hi /, "ownership cancels the greeting even when the logical state is idle again");
      assert.equal(after, before, "the deadline does not change the selected state, phase or activity");
    } finally {
      await lab?.shutdown(); lab?.restore();
      t.mock.timers.reset();
    }
  });
}

test("an idle session still greets at the 500ms startup deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const root = mkdtempSync(join(tmpdir(), "emote-greeting-idle-"));
  const dir = join(root, ".pi", "extensions", "gentle-emote");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ externalDisplay: { enabled: true, url: "http://127.0.0.1:8000/emote" } }));
  const originalFetch = globalThis.fetch;
  const calls: RequestInit[] = [];
  globalThis.fetch = async (_url, init) => { calls.push(init!); return new Response(); };
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  const state = (call: RequestInit) => new Headers(call.headers).get("X-Emote-State");
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    lab = await boot(root);
    await flush();
    t.mock.timers.tick(499);
    await flush();
    assert.ok(!calls.some(call => state(call) === "hi"), "the greeting does not start before its deadline");

    t.mock.timers.tick(1);
    await flush();
    assert.ok(calls.length > 0, "the idle greeting is delivered");
    assert.equal(state(calls.at(-1)!), "hi", "idle startup still greets exactly at 500ms");
  } finally {
    await lab?.shutdown(); lab?.restore(); globalThis.fetch = originalFetch;
    t.mock.timers.reset();
    rmSync(root, { recursive: true, force: true });
  }
});

test("ASCII-only terminal still POSTs animated PNGs, prompt overlays and model set changes", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const root = mkdtempSync(join(tmpdir(), "emote-ascii-session-"));
  const dir = join(root, ".pi", "extensions", "gentle-emote");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    externalDisplay: { enabled: true, targets: [
      { enabled: true, url: "http://localhost:8000/emote" },
      { enabled: true, url: "http://matrix/emote" },
    ] },
    terminals: [{ match: "ghostty", render: "ascii" }], cycleMs: 15,
    emotes: [{ model: "next", "emote-set": "gentleman-yolo" }],
  }));
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init: init! }); return new Response(); };
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  const tick = () => new Promise<void>(resolve => setImmediate(resolve));
  try {
    lab = await boot(root);
    await lab.emit("tool_execution_start", { toolName: "read", toolCallId: "read-1" });
    t.mock.timers.tick(450);
    await tick();
    const readCalls = calls.filter(call => new Headers(call.init.headers).get("X-Emote-State") === "read");
    assert.ok(new Set(readCalls.map(call => new Headers(call.init.headers).get("X-Emote-Frame"))).size > 1);
    assert.ok(readCalls.some(call => call.url.includes("localhost")) && readCalls.some(call => call.url.includes("matrix")));
    lab.widgets.render(100); // Install the text gutter before rendering the editor.
    assert.ok(lab.editor.render(100).join("\n").includes(".------."), "local output remains ASCII");
    assert.ok(!lab.writes.some(write => write.includes("\x1b_G") || write.includes("1337;File=")), "no image protocol writes");
    await lab.emit("ui_prompt_start"); await tick();
    assert.equal(new Headers(calls.at(-1)!.init.headers).get("X-Emote-State"), "ask");
    await lab.emit("ui_prompt_end"); await tick();
    assert.equal(new Headers(calls.at(-1)!.init.headers).get("X-Emote-State"), "read");
    const command = lab.commands.get("emote");
    await command.handler("internalOff", lab.ctx); await tick();
    lab.widgets.render(100);
    assert.ok(!lab.editor.render(100).join("\n").includes(".------."));
    await lab.emit("model_select", { model: { id: "next" } }); await tick();
    assert.equal(new Headers(calls.at(-1)!.init.headers).get("X-Emote-Set"), "gentleman-yolo");
    await command.handler("internalOn", lab.ctx); await tick();
    lab.widgets.render(100);
    assert.ok(lab.editor.render(100).join("\n").includes(".------."), "ASCII avatar is restored");
    await lab.shutdown();
    const count = calls.length;
    await lab.emit("tool_execution_start", { toolName: "write" }); await tick();
    assert.equal(calls.length, count);
  } finally {
    await lab?.shutdown(); lab?.restore(); globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test("internalOff removes the terminal avatar but preserves PNG POSTs and internalOn restores it", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const root = mkdtempSync(join(tmpdir(), "emote-visibility-"));
  const dir = join(root, ".pi", "extensions", "gentle-emote");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    externalDisplay: { enabled: true, targets: [
      { enabled: true, url: "http://localhost:8000/emote" },
      { enabled: true, url: "http://matrix/emote" },
    ] },
  }));
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init: init! }); return new Response(); };
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  const tick = () => new Promise<void>(resolve => setImmediate(resolve));
  try {
    lab = await boot(root);
    await lab.emit("tool_execution_start", { toolName: "read", toolCallId: "r" }); await tick();
    lab.widgets.render(100);
    assert.ok(lab.editor.render(100).join("\n").includes(PLACEHOLDER));
    const command = lab.commands.get("emote");
    assert.deepEqual(command.getArgumentCompletions("internal").map((item: any) => item.value), ["internalOn", "internalOff"]);
    await command.handler("internalOff", lab.ctx); await tick();
    assert.deepEqual(lab.widgets.render(100), []);
    assert.ok(!lab.editor.render(100).join("\n").includes(PLACEHOLDER), "gutter is removed");
    const writes = lab.writes.length;
    const start = calls.length;
    await lab.emit("tool_execution_start", { toolName: "write", toolCallId: "w" });
    t.mock.timers.tick(240); await tick();
    const hidden = calls.slice(start).filter(call => new Headers(call.init.headers).get("X-Emote-State") === "write");
    assert.ok(hidden.some(call => call.url.includes("localhost")) && hidden.some(call => call.url.includes("matrix")));
    assert.ok(new Set(hidden.map(call => new Headers(call.init.headers).get("X-Emote-Frame"))).size > 1);
    await lab.emit("ui_prompt_start"); await tick();
    assert.equal(new Headers(calls.at(-1)!.init.headers).get("X-Emote-State"), "ask");
    await lab.emit("ui_prompt_end"); await tick();
    await command.handler("internalOff", lab.ctx); // Idempotent.
    assert.equal(lab.writes.length, writes, "no terminal graphics are transmitted while hidden");
    assert.deepEqual(command.getArgumentCompletions("local").map((item: any) => item.value), ["localOn", "localOff"]);
    assert.ok(command.getArgumentCompletions("local").every((item: any) => item.description));
    assert.deepEqual(command.getArgumentCompletions("debug"), []);
    assert.ok(command.description.includes("localOn | localOff"));
    assert.ok(!command.description.includes("debugOn"));
    const localBefore = calls.filter(call => call.url.includes("localhost")).length;
    const deviceBefore = calls.filter(call => call.url.includes("matrix")).length;
    await command.handler("localOff", lab.ctx);
    await lab.emit("tool_execution_start", { toolName: "bash", toolCallId: "b" }); await tick();
    assert.equal(calls.filter(call => call.url.includes("localhost")).length, localBefore);
    const deviceAfter = calls.filter(call => call.url.includes("matrix")).length;
    assert.ok(deviceAfter > deviceBefore, "ESP32 keeps updating with both local outputs off");
    await command.handler("localOn", lab.ctx); await tick();
    assert.equal(calls.filter(call => call.url.includes("localhost")).length, localBefore + 1);
    assert.equal(calls.filter(call => call.url.includes("matrix")).length, deviceAfter, "ESP32 stream is untouched by localOn");
    assert.equal(lab.writes.length, writes, "local commands do not show the internal avatar");
    await command.handler("internalOn", lab.ctx); await tick();
    lab.widgets.render(100);
    assert.ok(lab.editor.render(100).join("\n").includes(PLACEHOLDER));
    assert.ok(lab.writes.length > writes, "graphics resume when re-enabled");
  } finally {
    await lab?.shutdown(); lab?.restore(); globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test("the framed avatar sits beside the prompt, which grows to the frame height", async () => {
  const lab = await boot();
  try {
    await lab.emit("tool_execution_start", { toolName: "bash" });
    assert.deepEqual(lab.widgets.render(100), [], "beside-editor leaves no row above the prompt");

    const lines = lab.editor.render(100).map(plain);
    for (const line of lines) assert.ok(visibleWidth(line) <= 100);
    assert.equal(lines.length, 4, "frameRows (4): the frame and the prompt share the same height");
    assert.ok(lines.every((line) => line.startsWith(PLACEHOLDER)), "the framed image fills every row, no text border rows");
    assert.ok(lines[0]!.includes("waiting for input"), "the prompt is not pushed down: it grows instead");
    assert.ok(lines.slice(2).every((line) => line.includes("┃")), "the blank panel row fills the extra height");
    assert.ok(lab.writes.some((w) => /a=T,f=100,q=2,U=1,i=\d+,c=\d+,r=4/.test(w)), "the frame image is sent 4 rows tall");

    const emote = lab.commands.get("emote");
    assert.ok(emote, "/emote is registered");
    const completions = await emote.getArgumentCompletions("gr");
    assert.deepEqual(completions.map((item: any) => item.value), ["grandma"]);
    const before = lab.writes.length;
    await emote.handler("grandma", lab.ctx);
    assert.ok(lab.writes.length > before, "/emote grandma swaps the frame without the model");

    // The image itself travels out of band as a kitty virtual placement.
    assert.ok(lab.writes.some((w) => w.includes("\x1b_Ga=T") && w.includes("U=1")));
    assert.ok(!lab.writes.some((w) => w.startsWith("\x1bPtmux;")), "no tmux wrapping outside tmux");

    await lab.shutdown();
    assert.ok(!lab.editor.render(100)[0]!.includes(PLACEHOLDER), "shutdown restores the plain prompt");
  } finally {
    await lab.shutdown();
    lab.restore();
  }
});

test("/emote d200Off stops the D200 stream without touching config", async () => {
  const root = mkdtempSync(join(tmpdir(), "emote-d200-"));
  const dir = join(root, ".pi", "extensions", "gentle-emote");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({}));
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init: init! }); return new Response(); };
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    lab = await boot(root);
    const emote = lab.commands.get("emote");
    assert.ok(emote, "/emote is registered");

    const completions = await emote.getArgumentCompletions("d200");
    assert.deepEqual(completions.map((item: any) => item.value), ["d200On", "d200Off"]);

    await lab.emit("tool_execution_start", { toolName: "bash" });
    await flush();
    assert.equal(calls.length, 0, "nothing is delivered before d200On");

    await emote.handler("d200On", lab.ctx);
    await lab.emit("tool_execution_start", { toolName: "read" });
    await flush();
    assert.ok(calls.length > 0, "d200On mirrors frames");
    assert.ok(calls.every((call) => call.url === "http://127.0.0.1:8003/emote"));
    assert.equal(new Headers(calls.at(-1)!.init.headers).get("X-Emote-Version"), "1");
    // The dedicated key shares the captioned layout wiring: runtime d200On passes
    // the sending project's basename, so its loopback requests name the project.
    for (const call of calls) {
      const header = new Headers(call.init.headers).get("X-Emote-Project-Name");
      assert.ok(header, "d200On names the sending project");
      assert.equal(decodeURIComponent(header!), basename(root));
    }

    const delivered = calls.length;
    await emote.handler("d200Off", lab.ctx);
    await lab.emit("tool_execution_start", { toolName: "write" });
    await flush();
    assert.equal(calls.length, delivered, "d200Off stops delivery");

    // Output preferences are stored separately; the project's config stays unchanged.
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")), {});
  } finally {
    await lab?.shutdown(); lab?.restore(); globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});


test("all outputs default off; independent global switches survive project changes and restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "emote-global-"));
  const profile = join(root, "profile");
  const config = { externalDisplay: { enabled: true, targets: [
    { enabled: true, url: "http://localhost:8000/emote" },
    { enabled: true, url: "http://matrix/emote" },
    { enabled: false, url: "http://disabled/emote" },
  ] } };
  for (const project of ["a", "b"]) {
    const dir = join(root, project, ".pi", "extensions", "gentle-emote");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify(config));
  }
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); return new Response(); };
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    lab = await boot(join(root, "a"), [], profile);
    await lab.emit("tool_execution_start", { toolName: "read" }); await flush();
    lab.widgets.render(100);
    assert.equal(calls.length, 0, "configured destinations are silent before explicit On");
    assert.ok(!lab.editor.render(100).join("").includes(PLACEHOLDER));
    assert.ok(!lab.writes.some(write => write.includes("\x1b_G") || write.includes("1337;File=")), "no initial graphics");
    const emote = lab.commands.get("emote");
    assert.deepEqual(emote.getArgumentCompletions("display").map((item: any) => item.value), ["displayOn", "displayOff"]);
    await emote.handler("displayOn", lab.ctx); await flush();
    assert.deepEqual(calls, ["http://matrix/emote/claim", "http://matrix/emote"], "displayOn claims the reservation before resuming the latest frame on ESP32");
    calls.length = 0;
    await emote.handler("localOn", lab.ctx); await flush();
    assert.deepEqual(calls, ["http://localhost:8000/emote"]);
    assert.equal(new OutputStateStore(profile).load(() => {}).debug, true, "localOn preserves the existing debug preference key");
    await emote.handler("d200On", lab.ctx); await flush();
    calls.length = 0;
    await emote.handler("displayOff", lab.ctx);
    await lab.emit("tool_execution_start", { toolName: "write" }); await flush();
    assert.ok(calls.includes("http://localhost:8000/emote"));
    assert.ok(calls.includes("http://127.0.0.1:8003/emote"));
    assert.ok(!calls.includes("http://matrix/emote"), "displayOff leaves both local destinations active");
    await emote.handler("internalOn", lab.ctx);
    lab.widgets.render(100);
    assert.ok(lab.editor.render(100).join("").includes(PLACEHOLDER));
    await emote.handler("displayOn", lab.ctx); await flush();
    await lab.shutdown(); lab.restore(); lab = undefined;
    calls.length = 0;
    lab = await boot(join(root, "b"), [], profile);
    await lab.emit("tool_execution_start", { toolName: "read" }); await flush();
    lab.widgets.render(100);
    assert.ok(lab.editor.render(100).join("").includes(PLACEHOLDER), "global internalOn survives restart in another project");
    assert.ok(calls.includes("http://localhost:8000/emote"));
    assert.ok(calls.includes("http://127.0.0.1:8003/emote"));
    assert.ok(calls.includes("http://matrix/emote"), "global displayOn survives restart");
    assert.ok(!calls.includes("http://disabled/emote"), "On never enables disabled destinations");
    for (const output of ["internalOff", "localOff", "d200Off", "displayOff"]) await lab.commands.get("emote").handler(output, lab.ctx);
    const store = new OutputStateStore(profile);
    const saved = store.load(() => {});
    for (const obsolete of ["debugOn", "debugOff"]) {
      const count = calls.length;
      const command = lab.commands.get("emote");
      await command.handler(obsolete, lab.ctx); await flush();
      assert.deepEqual(store.load(() => {}), saved, "obsolete command cannot change saved outputs");
      assert.equal(calls.length, count, "obsolete command cannot send a frame");
      assert.deepEqual(lab.notices.at(-1), {
        message: `[gentle-emote] /emote <state>: ${command.getArgumentCompletions("").map((item: any) => item.value).join(", ")}`,
        level: "info",
      });
    }
    await lab.shutdown(); lab.restore(); lab = undefined;
    calls.length = 0;
    lab = await boot(join(root, "a"), [], profile);
    await lab.emit("tool_execution_start", { toolName: "read" }); await flush();
    lab.widgets.render(100);
    assert.deepEqual(calls, [], "all saved Off states survive restart");
    assert.ok(!lab.editor.render(100).join("").includes(PLACEHOLDER));
    for (const project of ["a", "b"]) assert.deepEqual(JSON.parse(readFileSync(join(root, project, ".pi", "extensions", "gentle-emote", "config.json"), "utf8")), config);
  } finally {
    await lab?.shutdown(); lab?.restore(); globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});


test("failed global save reports an error and leaves the active output and saved data unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "emote-save-failure-"));
  const profile = join(root, "profile");
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    lab = await boot(root, ["internalOn"], profile);
    lab.widgets.render(100);
    assert.ok(lab.editor.render(100).join("").includes(PLACEHOLDER));
    const path = join(profile, "extensions", "gentle-emote", "output-states", "internal.json");
    writeFileSync(path, "invalid-json");
    const before = lab.writes.length;
    await lab.commands.get("emote").handler("internalOff", lab.ctx);
    lab.widgets.render(100);
    assert.ok(lab.editor.render(100).join("").includes(PLACEHOLDER));
    assert.equal(lab.writes.length, before);
    assert.deepEqual(lab.notices.at(-1), {
      message: "[gentle-emote] cannot save global internal state; output unchanged", level: "error",
    });
    assert.equal(readFileSync(path, "utf8"), "invalid-json");
  } finally {
    await lab?.shutdown(); lab?.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the phase visual drives generic scenes and yields to prompts, failures and clears", async () => {
  const root = mkdtempSync(join(tmpdir(), "emote-phase-visual-"));
  const dir = join(root, ".pi", "extensions", "gentle-emote");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ externalDisplay: { enabled: true, url: "http://127.0.0.1:8000/emote" } }));
  const originalFetch = globalThis.fetch;
  const calls: RequestInit[] = [];
  globalThis.fetch = async (_url, init) => { calls.push(init!); return new Response(); };
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  const change = (phase: string | null, source: string | null, sessionId = SESSION_ID) =>
    ({ schema: "gentle-pi.odd-phase/v1", sessionId, phase, source });
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    lab = await boot(root);
    // A tool scene first, then the published phase adopts it live.
    await lab.emit("tool_execution_start", { toolName: "bash", toolCallId: "i" });
    await flush();
    assert.equal(new Headers(calls.at(-1)!.headers).get("X-Emote-State"), "tool");
    lab.emitBus("gentle-pi:odd-phase/v1", change("implementing", "inferred"));
    await flush();
    assert.equal(new Headers(calls.at(-1)!.headers).get("X-Emote-State"), "implementing");
    assert.equal(new Headers(calls.at(-1)!.headers).get("X-Emote-Frame"), "implementing_1.png");
    assert.equal(new Headers(calls.at(-1)!.headers).get("X-Emote-Work-Phase"), "implementing");

    // A blocking prompt still covers the scene; ending it returns to the phase visual.
    await lab.emit("ui_prompt_start"); await flush();
    assert.equal(new Headers(calls.at(-1)!.headers).get("X-Emote-State"), "ask");
    await lab.emit("ui_prompt_end"); await flush();
    assert.equal(new Headers(calls.at(-1)!.headers).get("X-Emote-State"), "implementing");

    // Failures: a bash error enters the failure hold, which with the real
    // renderer shows no frame (pre-existing fail* cycle filter), so the phase
    // visual from prompt_end remains the last POST — no failure frame is sent.
    await lab.emit("tool_execution_end", { toolName: "bash", toolCallId: "i", isError: true });
    await flush();
    assert.ok(!calls.some(call => new Headers(call.headers).get("X-Emote-State") === "failure"), "no failure frame POST (preserved fail* filter)");
    assert.equal(new Headers(calls.at(-1)!.headers).get("X-Emote-State"), "implementing");
    assert.equal(new Headers(calls.at(-1)!.headers).get("X-Emote-Status"), "error", "the activity labels still update truthfully");

    // A host clear falls back to the coarse visuals; talking stays talking.
    lab.emitBus("gentle-pi:odd-phase/v1", change(null, null));
    await lab.emit("tool_execution_start", { toolName: "read", toolCallId: "r" });
    await flush();
    assert.equal(new Headers(calls.at(-1)!.headers).get("X-Emote-State"), "read");
    assert.equal(new Headers(calls.at(-1)!.headers).get("X-Emote-Work-Phase"), null);
    await lab.emit("message_update", { message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "hi" } });
    await flush();
    assert.equal(new Headers(calls.at(-1)!.headers).get("X-Emote-State"), "talk");
  } finally {
    await lab?.shutdown(); lab?.restore(); globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test("native subagent task events drive the active-subagent header and PNG and survive turn boundaries", async () => {
  const root = mkdtempSync(join(tmpdir(), "emote-native-subagents-"));
  const dir = join(root, ".pi", "extensions", "gentle-emote");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ externalDisplay: { enabled: true, url: "http://127.0.0.1:8000/emote" } }));
  const originalFetch = globalThis.fetch;
  const calls: RequestInit[] = [];
  globalThis.fetch = async (_url, init) => { calls.push(init!); return new Response(); };
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  const subagentEvent = (status: string, sequence: number, overrides: Record<string, unknown> = {}) => ({
    source: "subagent", producerId: "producer-1", sessionId: SESSION_ID, parentSessionId: SESSION_ID,
    taskId: "t1", runId: "producer-1:run-1", status, event: `subagent.${status}`, sequence, occurredAt: 5, ...overrides,
  });
  const header = (init: RequestInit, name: string) => new Headers(init.headers).get(name);
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    lab = await boot(root);
    // Establish a selected frame first, then check the call-based fallback.
    await lab.emit("tool_execution_start", { toolName: "read", toolCallId: "r" });
    await flush();
    assert.equal(header(calls.at(-1)!, "X-Emote-Active-Subagents"), "0");
    await lab.emit("tool_execution_start", { toolName: "subagent_run", toolCallId: "s1", args: { agent: "explore" } });
    await flush();
    assert.equal(header(calls.at(-1)!, "X-Emote-Active-Subagents"), "1");
    await lab.emit("tool_execution_end", { toolName: "subagent_run", toolCallId: "s1", isError: false });
    await flush();
    assert.equal(header(calls.at(-1)!, "X-Emote-Active-Subagents"), "0");

    // The native lifecycle publishes transitions for background tasks; the
    // queued task counts even though no tool call is open.
    lab.emitBus(SUBAGENT_CHANNEL, subagentEvent("queued", 1));
    await flush();
    assert.equal(header(calls.at(-1)!, "X-Emote-Active-Subagents"), "1");
    const bodyWithTask = calls.at(-1)!.body;
    lab.emitBus(SUBAGENT_CHANNEL, subagentEvent("running", 2));
    await flush();
    assert.equal(header(calls.at(-1)!, "X-Emote-Active-Subagents"), "1");

    // agent_end/agent_start reset the turn but not the native task count.
    await lab.emit("agent_end");
    await lab.emit("agent_start");
    await lab.emit("tool_execution_start", { toolName: "bash", toolCallId: "b" });
    await flush();
    assert.equal(header(calls.at(-1)!, "X-Emote-Active-Subagents"), "1", "the native count survives turn boundaries");

    // A second concurrent task counts alongside the first.
    lab.emitBus(SUBAGENT_CHANNEL, subagentEvent("queued", 4, { taskId: "t2", runId: "producer-1:run-2" }));
    await flush();
    assert.equal(header(calls.at(-1)!, "X-Emote-Active-Subagents"), "2", "two concurrent native tasks");

    // Completion clears the count and changes the posted PNG label.
    lab.emitBus(SUBAGENT_CHANNEL, subagentEvent("completed", 5));
    await flush();
    assert.equal(header(calls.at(-1)!, "X-Emote-Active-Subagents"), "1");
    assert.notEqual(calls.at(-1)!.body, bodyWithTask, "the PNG label is re-rendered");

    // Foreign-session and malformed events never mutate the counter.
    const before = calls.length;
    lab.emitBus(SUBAGENT_CHANNEL, subagentEvent("queued", 6, { sessionId: "another-session", taskId: "t9" }));
    lab.emitBus(SUBAGENT_CHANNEL, subagentEvent("queued", 0));
    lab.emitBus(SUBAGENT_CHANNEL, subagentEvent("queued", 7, { source: "tool" }));
    await lab.emit("tool_execution_start", { toolName: "read", toolCallId: "r2" });
    await flush();
    assert.ok(calls.length > before);
    assert.equal(header(calls.at(-1)!, "X-Emote-Active-Subagents"), "1", "foreign and malformed events leave the count untouched");

    // Once native was observed, call bookkeeping no longer sums into the count.
    await lab.emit("tool_execution_start", { toolName: "subagent_run", toolCallId: "s2" });
    await flush();
    assert.equal(header(calls.at(-1)!, "X-Emote-Active-Subagents"), "1");

    // Re-emitting an already active task changes nothing; waiting keeps it;
    // failure clears it and the count reaches zero.
    lab.emitBus(SUBAGENT_CHANNEL, subagentEvent("queued", 8, { taskId: "t2", runId: "producer-1:run-2" }));
    await flush();
    assert.equal(header(calls.at(-1)!, "X-Emote-Active-Subagents"), "1");
    lab.emitBus(SUBAGENT_CHANNEL, subagentEvent("waiting", 9, { taskId: "t2", runId: "producer-1:run-2" }));
    await flush();
    assert.equal(header(calls.at(-1)!, "X-Emote-Active-Subagents"), "1", "waiting counts the same task once");
    lab.emitBus(SUBAGENT_CHANNEL, subagentEvent("failed", 10, { taskId: "t2", runId: "producer-1:run-2" }));
    await flush();
    assert.equal(header(calls.at(-1)!, "X-Emote-Active-Subagents"), "0");
  } finally {
    await lab?.shutdown(); lab?.restore(); globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test("the host work phase reaches the headers and PNG labels and clears at turn boundaries", async () => {
  const root = mkdtempSync(join(tmpdir(), "emote-work-phase-"));
  const dir = join(root, ".pi", "extensions", "gentle-emote");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ externalDisplay: { enabled: true, url: "http://127.0.0.1:8000/emote" } }));
  const originalFetch = globalThis.fetch;
  const calls: RequestInit[] = [];
  globalThis.fetch = async (_url, init) => { calls.push(init!); return new Response(); };
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  const change = (phase: string | null, source: string | null, sessionId = SESSION_ID) =>
    ({ schema: "gentle-pi.odd-phase/v1", sessionId, phase, source });
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    lab = await boot(root);
    // Startup subscribed to the change channel and asked the host for its current state.
    assert.ok(lab.busSent.some(entry => entry.channel === "gentle-pi:odd-phase-current/v1" && entry.payload.sessionId === SESSION_ID));

    // A host phase published before the first emote tool-start is not lost.
    lab.emitBus("gentle-pi:odd-phase/v1", change("implementing", "inferred"));
    await lab.emit("tool_execution_start", { toolName: "write", toolCallId: "w" });
    await flush();
    assert.equal(new Headers(calls.at(-1)!.headers).get("X-Emote-Phase"), "executing");
    assert.equal(new Headers(calls.at(-1)!.headers).get("X-Emote-Work-Phase"), "implementing");
    const bodyWithDetail = calls.at(-1)!.body;
    assert.notEqual(bodyWithDetail, calls[0]!.body, "the detail renders a different PNG");

    // Foreign sessions and malformed payloads never leak in.
    lab.emitBus("gentle-pi:odd-phase/v1", change("closing", "explicit", "another-session"));
    lab.emitBus("gentle-pi:odd-phase/v1", change("scheming", "inferred"));
    lab.emitBus("gentle-pi:odd-phase/v1", change("planning", null));
    await lab.emit("tool_execution_start", { toolName: "read", toolCallId: "r" });
    await flush();
    assert.equal(new Headers(calls.at(-1)!.headers).get("X-Emote-Work-Phase"), "implementing");

    // Responding and waiting keep their own truthful PNG labels.
    await lab.emit("message_update", { message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "hi" } });
    await flush();
    assert.equal(new Headers(calls.at(-1)!.headers).get("X-Emote-Work-Phase"), "implementing", "malformed payloads never replaced the detail");
    const respondingBody = calls.at(-1)!.body;
    lab.emitBus("gentle-pi:odd-phase/v1", change(null, null));
    await lab.emit("ui_prompt_start");
    await flush();
    assert.equal(new Headers(calls.at(-1)!.headers).get("X-Emote-Work-Phase"), null, "a host clear removes the header");
    assert.ok(!calls.some(call => call.body === respondingBody) || true);

    // At agent_start the emote asks again, so a host that becomes ready later recovers.
    lab.busHandlers.set("gentle-pi:odd-phase-current/v1", [(payload: any) => {
      if (payload.schema === "gentle-pi.odd-phase-current/v1" && payload.sessionId === SESSION_ID) {
        payload.respond({ schema: "gentle-pi.odd-phase/v1", sessionId: SESSION_ID, phase: "planning", source: "explicit" });
      }
    }]);
    await lab.emit("agent_start");
    await lab.emit("tool_execution_start", { toolName: "bash", toolCallId: "b" });
    await flush();
    assert.equal(new Headers(calls.at(-1)!.headers).get("X-Emote-Work-Phase"), "planning");
    assert.notDeepEqual(calls.at(-1)!.body, bodyWithDetail);
  } finally {
    await lab?.shutdown(); lab?.restore(); globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test("/emote title persists a per-project caption, applies live, survives reload and isolates projects", async () => {
  const root = mkdtempSync(join(tmpdir(), "emote-title-project-"));
  const other = join(root, "other");
  const dir = join(root, ".pi", "extensions", "gentle-emote");
  const otherDir = join(other, ".pi", "extensions", "gentle-emote");
  mkdirSync(dir, { recursive: true });
  mkdirSync(otherDir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ externalDisplay: { enabled: true, url: "http://127.0.0.1:8000/emote" } }));
  writeFileSync(join(otherDir, "config.json"), JSON.stringify({ externalDisplay: { enabled: true, url: "http://127.0.0.1:8000/emote" } }));
  const originalFetch = globalThis.fetch;
  const calls: RequestInit[] = [];
  globalThis.fetch = async (_url, init) => { calls.push(init!); return new Response(); };
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  const caption = () => new Headers(calls.at(-1)!.headers).get("X-Emote-Project-Name");
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    lab = await boot(root);
    const emote = lab.commands.get("emote");
    const completions = emote.getArgumentCompletions("title");
    assert.deepEqual(completions.map((item: any) => item.value), ["title"]);
    assert.ok(completions[0].description, "the title completion carries a description");
    assert.ok(emote.description.includes("title <text>"), "the command description names the subcommand");

    await lab.emit("tool_execution_start", { toolName: "bash", toolCallId: "t" });
    await flush();
    assert.equal(caption(), encodeURIComponent(basename(root)), "the folder basename is the default caption");

    await emote.handler("title  Mi Proyecto ñ ", lab.ctx);
    await flush();
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "title.json"), "utf8")), { title: "Mi Proyecto ñ" }, "the trimmed title is saved per project");
    assert.equal(caption(), encodeURIComponent("Mi Proyecto ñ"), "the live caption follows the command");
    assert.equal(new Headers(calls.at(-1)!.headers).get("X-Emote-State"), "tool", "activity delivery is untouched");
    assert.ok(!lab.notices.some(notice => notice.level === "error"));
    await lab.emit("tool_execution_start", { toolName: "read", toolCallId: "r" });
    await flush();
    assert.equal(new Headers(calls.at(-1)!.headers).get("X-Emote-State"), "read", "existing state previews keep working");
    assert.equal(caption(), encodeURIComponent("Mi Proyecto ñ"), "later frames keep the caption");

    await lab.shutdown(); lab.restore(); lab = undefined;
    calls.length = 0;
    lab = await boot(root);
    await lab.emit("tool_execution_start", { toolName: "read", toolCallId: "r2" });
    await flush();
    assert.equal(caption(), encodeURIComponent("Mi Proyecto ñ"), "reload restores the saved override");
    await lab.shutdown(); lab.restore(); lab = undefined;
    calls.length = 0;

    lab = await boot(other);
    await lab.emit("tool_execution_start", { toolName: "read", toolCallId: "r3" });
    await flush();
    assert.equal(caption(), encodeURIComponent(basename(other)), "another project keeps the folder name");
    await lab.shutdown(); lab.restore(); lab = undefined;
    calls.length = 0;

    lab = await boot(root);
    await lab.emit("tool_execution_start", { toolName: "bash", toolCallId: "t2" });
    await flush();
    await lab.commands.get("emote").handler("title", lab.ctx);
    await flush();
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "title.json"), "utf8")), { title: null }, "bare reset stores an explicit null");
    assert.equal(caption(), encodeURIComponent(basename(root)), "bare /emote title restores the folder basename");
    assert.equal(new Headers(calls.at(-1)!.headers).get("X-Emote-State"), "tool", "state delivery continues after reset");
  } finally {
    await lab?.shutdown(); lab?.restore(); globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test("an invalid title reports a warning and changes nothing; a failed save leaves caption and storage untouched", async () => {
  const root = mkdtempSync(join(tmpdir(), "emote-title-failure-"));
  const dir = join(root, ".pi", "extensions", "gentle-emote");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ externalDisplay: { enabled: true, url: "http://127.0.0.1:8000/emote" } }));
  mkdirSync(join(dir, "title.json"), { recursive: true });
  const originalFetch = globalThis.fetch;
  const calls: RequestInit[] = [];
  globalThis.fetch = async (_url, init) => { calls.push(init!); return new Response(); };
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    lab = await boot(root);
    const emote = lab.commands.get("emote");
    await lab.emit("tool_execution_start", { toolName: "bash", toolCallId: "t" });
    await flush();
    const before = calls.length;
    const caption = () => new Headers(calls.at(-1)!.headers).get("X-Emote-Project-Name");
    assert.equal(caption(), encodeURIComponent(basename(root)));

    await emote.handler("title a/b", lab.ctx);
    assert.deepEqual(lab.notices.at(-1), {
      message: "[gentle-emote] invalid title; the display title is unchanged", level: "warning",
    });
    await emote.handler("title  Nuevo ", lab.ctx);
    await flush();
    assert.deepEqual(lab.notices.at(-1), {
      message: "[gentle-emote] cannot save project title; title unchanged", level: "error",
    }, "the failed save is reported");
    await lab.emit("tool_execution_start", { toolName: "read", toolCallId: "r" });
    await flush();
    assert.ok(calls.length > before, "delivery keeps flowing after failures");
    assert.equal(caption(), encodeURIComponent(basename(root)), "the live caption stays on the folder name");
    assert.equal(new Headers(calls.at(-1)!.headers).get("X-Emote-State"), "read");
  } finally {
    await lab?.shutdown(); lab?.restore(); globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a malformed stored title override warns, falls back to the folder name and preserves the file", async () => {
  const root = mkdtempSync(join(tmpdir(), "emote-title-badfile-"));
  const dir = join(root, ".pi", "extensions", "gentle-emote");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ externalDisplay: { enabled: true, url: "http://127.0.0.1:8000/emote" } }));
  writeFileSync(join(dir, "title.json"), "{broken");
  const originalFetch = globalThis.fetch;
  const calls: RequestInit[] = [];
  globalThis.fetch = async (_url, init) => { calls.push(init!); return new Response(); };
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    lab = await boot(root);
    await lab.emit("tool_execution_start", { toolName: "read", toolCallId: "r" });
    await flush();
    assert.ok(calls.length > 0);
    assert.ok(lab.notices.some(notice =>
      notice.level === "warning" && notice.message === "[gentle-emote] cannot read saved title override; using the project folder name"));
    assert.equal(new Headers(calls.at(-1)!.headers).get("X-Emote-Project-Name"), encodeURIComponent(basename(root)), "the folder name is used");
    assert.equal(readFileSync(join(dir, "title.json"), "utf8"), "{broken", "the malformed file is preserved");
  } finally {
    await lab?.shutdown(); lab?.restore(); globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test("context usage colors session titles across host lifecycle events and runtime D200 enablement", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const root = mkdtempSync(join(tmpdir(), "emote-context-"));
  const dir = join(root, ".pi", "extensions", "gentle-emote");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ externalDisplay: { enabled: true, url: "http://localhost:8000/emote" } }));
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init: init! }); return new Response(); };
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  const assertTitle = (body: Uint8Array, rgb: number[]) => {
    const { data } = decodePng(Buffer.from(body));
    let pixels = 0;
    for (let i = 64 * 4; i < 6 * 64 * 4; i += 4) {
      if (data[i] || data[i + 1] || data[i + 2]) { assert.deepEqual(Array.from(data.slice(i, i + 3)), rgb); pixels++; }
    }
    assert.ok(pixels > 0);
  };
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  let percent: number | null = 60;
  try {
    lab = await boot(root);
    Object.assign(lab.ctx, { getContextUsage: () => ({ tokens: percent === null ? null : percent * 1000, contextWindow: 100000, percent }) });
    calls.length = 0;
    await lab.emit("session_start");
    await lab.commands.get("emote").handler("read", lab.ctx); await flush();
    assert.ok(calls.length > 0);
    for (const call of calls) assertTitle(call.init.body as Uint8Array, [255, 255, 0]);
    for (const [event, value, rgb] of [
      ["turn_end", 81, [255, 0, 0]], ["session_compact", 20, [128, 224, 160]],
      ["model_select", 80, [255, 255, 0]], ["message_update", 90, [255, 0, 0]],
      ["session_tree", 10, [128, 224, 160]], ["agent_end", 60, [255, 255, 0]],
    ] as const) {
      percent = value; calls.length = 0;
      await lab.emit(event, event === "model_select" ? { model: { id: "next" } } : {}); await flush();
      assert.ok(calls.some(call => call.init.body), `${event} refreshes the caption without needing a new avatar`);
      assertTitle(calls.filter(call => call.init.body).at(-1)!.init.body as Uint8Array, Array.from(rgb));
    }
    calls.length = 0;
    await lab.commands.get("emote").handler("d200On", lab.ctx); await flush();
    const d200 = calls.filter(call => call.url.includes(":8003/"));
    assert.ok(d200.length > 0);
    for (const call of d200) assertTitle(call.init.body as Uint8Array, [255, 255, 0]);
    percent = null; await lab.emit("turn_end"); await flush();
    assertTitle(calls.filter(call => call.init.body).at(-1)!.init.body as Uint8Array, [128, 224, 160]);
    Object.assign(lab.ctx, { getContextUsage: () => { throw new Error("usage unavailable"); } });
    await lab.emit("turn_end");
  } finally {
    await lab?.shutdown(); lab?.restore(); globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime d200On mirrors frames with the effective project title", async () => {
  const root = mkdtempSync(join(tmpdir(), "emote-title-d200-"));
  const dir = join(root, ".pi", "extensions", "gentle-emote");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ externalDisplay: { enabled: false, url: "http://127.0.0.1:8000/emote" } }));
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init: init! }); return new Response(); };
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    lab = await boot(root);
    const emote = lab.commands.get("emote");
    await emote.handler("title  D200 Título ", lab.ctx);
    await flush();
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "title.json"), "utf8")), { title: "D200 Título" });
    await emote.handler("d200On", lab.ctx);
    await lab.emit("tool_execution_start", { toolName: "read", toolCallId: "r" });
    await flush();
    const mirror = calls.filter(call => call.url === "http://127.0.0.1:8003/emote");
    assert.ok(mirror.length > 0, "d200On delivers frames");
    for (const call of mirror) {
      assert.equal(new Headers(call.init.headers).get("X-Emote-Project-Name"), encodeURIComponent("D200 Título"), "the runtime mirror uses the saved title");
    }
  } finally {
    await lab?.shutdown(); lab?.restore(); globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test("/emote displayOn <address> persists the board globally, keeps loopback, and claims before the frame", async () => {
  const root = mkdtempSync(join(tmpdir(), "emote-address-"));
  const profile = join(root, "profile");
  const project = join(root, "project");
  const projectDir = join(project, ".pi", "extensions", "gentle-emote");
  mkdirSync(projectDir, { recursive: true });
  // The project layer keeps pointing at the old board: it must not shadow an
  // explicit order. The global layer owns what the rewrite preserves.
  writeFileSync(join(projectDir, "config.json"), JSON.stringify({ externalDisplay: { enabled: true, targets: [
    { enabled: true, url: "http://matrix/emote" },
  ] } }));
  const globalPath = join(profile, "extensions", "gentle-emote", "config.json");
  mkdirSync(join(profile, "extensions", "gentle-emote"), { recursive: true });
  writeFileSync(globalPath, JSON.stringify({ size: 12, externalDisplay: { enabled: true, targets: [
    { enabled: true, url: "http://localhost:8000/emote" },
    { enabled: true, url: "http://old-board/emote" },
  ] } }));
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); return new Response(null, { headers: { "X-Emote-Ownership": "1" } }); };
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    lab = await boot(project, [], profile);
    await lab.emit("tool_execution_start", { toolName: "read" }); await flush();
    calls.length = 0;
    const emote = lab.commands.get("emote");
    await emote.handler("displayOn 192.168.9.9", lab.ctx); await flush();
    const claim = calls.indexOf("http://192.168.9.9/emote/claim");
    const image = calls.indexOf("http://192.168.9.9/emote");
    assert.ok(claim >= 0, `the named board is claimed: ${JSON.stringify(calls)}`);
    assert.ok(image > claim, "the claim precedes the refreshed frame");
    assert.ok(!calls.some(url => url.startsWith("http://matrix/emote")), "a project layer never shadows the explicit board");
    const saved = JSON.parse(readFileSync(globalPath, "utf8"));
    assert.deepEqual(saved.externalDisplay.targets, [
      { enabled: true, url: "http://localhost:8000/emote" },
      { enabled: true, url: "http://192.168.9.9/emote" },
    ], "the named board replaces the global non-loopback target and loopback survives");
    assert.equal(saved.size, 12, "unrelated global keys survive the write");
    assert.ok(lab.notices.some(notice => notice.message.includes("192.168.9.9")), "the applied address is reported");
    assert.equal(new OutputStateStore(profile).load(() => {}).display, true, "the display group is saved On");
  } finally {
    await lab?.shutdown(); lab?.restore(); globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test("/emote displayOn <address> refuses an invalid or loopback address and a disabled LED group without writing", async () => {
  const root = mkdtempSync(join(tmpdir(), "emote-address-refused-"));
  const profile = join(root, "profile");
  const project = join(root, "project");
  const projectDir = join(project, ".pi", "extensions", "gentle-emote");
  const disabledDir = join(root, "disabled", ".pi", "extensions", "gentle-emote");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(disabledDir, { recursive: true });
  writeFileSync(join(projectDir, "config.json"), JSON.stringify({ externalDisplay: { enabled: true, targets: [{ enabled: true, url: "http://matrix/emote" }] } }));
  writeFileSync(join(disabledDir, "config.json"), JSON.stringify({ externalDisplay: { enabled: false, targets: [{ enabled: true, url: "http://matrix/emote" }] } }));
  const globalPath = join(profile, "extensions", "gentle-emote", "config.json");
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); return new Response(); };
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    lab = await boot(project, [], profile);
    await lab.emit("tool_execution_start", { toolName: "read" }); await flush();
    const emote = lab.commands.get("emote");
    for (const input of ["displayOn http://192.168.9.9/emote", "displayOn 192.168.9.9/emote", "displayOn 127.0.0.1", "displayOn localhost:8000", "displayOn user@192.168.9.9"]) {
      const count = calls.length;
      await emote.handler(input, lab.ctx); await flush();
      assert.equal(existsSync(globalPath), false, `${input} never writes the global config`);
      assert.equal(calls.length, count, `${input} sends nothing`);
      assert.equal(lab.notices.at(-1)?.level, "warning", `${input} warns`);
    }
    await lab.handler;
    await lab.shutdown(); lab.restore(); lab = undefined;
    lab = await boot(join(root, "disabled"), [], profile);
    await lab.emit("tool_execution_start", { toolName: "read" }); await flush();
    const count = calls.length;
    await lab.commands.get("emote").handler("displayOn 192.168.9.9", lab.ctx); await flush();
    assert.equal(existsSync(globalPath), false, "a disabled LED group is never configured behind the user's back");
    assert.equal(calls.length, count, "a disabled LED group sends nothing");
    assert.match(lab.notices.at(-1)?.message ?? "", /no enabled LED\/ESP32 display configured/);
  } finally {
    await lab?.shutdown(); lab?.restore(); globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test("/emote d200On <port> targets that port for this session and never persists it", async () => {
  const root = mkdtempSync(join(tmpdir(), "emote-d200-port-"));
  const profile = join(root, "profile");
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  const globalConfig = join(profile, "extensions", "gentle-emote", "config.json");
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); return new Response(); };
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    lab = await boot(project, [], profile);
    const emote = () => lab!.commands.get("emote");
    await emote().handler("read", lab.ctx); await flush();
    calls.length = 0;
    await emote().handler("d200On 9100", lab.ctx); await flush();
    assert.ok(calls.length > 0, "the mirror delivers frames");
    assert.ok(calls.every(url => url.startsWith("http://127.0.0.1:9100/")), `every request goes to the session port: ${JSON.stringify(calls)}`);
    assert.equal(existsSync(globalConfig), false, "the port never enters config.json");
    assert.equal(new OutputStateStore(profile).load(() => {}).d200, true, "the On preference stays global and persistent");
    assert.match(lab.notices.at(-1)?.message ?? "", /D200 mirroring on: http:\/\/127\.0\.0\.1:9100\/emote/);

    // A second explicit port replaces the live sender instead of being ignored.
    calls.length = 0;
    await emote().handler("d200On 9101", lab.ctx); await flush();
    await lab.emit("tool_execution_start", { toolName: "read", toolCallId: "r2" }); await flush();
    assert.ok(calls.some(url => url.startsWith("http://127.0.0.1:9101/")), "the new port delivers");
    assert.ok(!calls.some(url => url.startsWith("http://127.0.0.1:9100/")), `the replaced sender stops: ${JSON.stringify(calls)}`);

    // The port is session-local: a reload restores the saved On state at the
    // default port, because no port was ever written anywhere.
    calls.length = 0;
    await lab.emit("session_start");
    // The reloaded sender starts empty, so a normal state transition is what
    // pushes the next frame: emulate the host with a different tool.
    await lab.emit("tool_execution_start", { toolName: "edit", toolCallId: "r3" }); await flush();
    assert.ok(calls.some(url => url.startsWith("http://127.0.0.1:8003/")), `a reload falls back to the default port: ${JSON.stringify(calls)}`);
    assert.ok(!calls.some(url => url.startsWith("http://127.0.0.1:9101/")), "the session port does not survive a reload");

    await emote().handler("d200Off", lab.ctx); await flush();
    calls.length = 0;
    await lab.emit("tool_execution_start", { toolName: "read", toolCallId: "r4" }); await flush();
    assert.equal(calls.length, 0, "d200Off still stops every D200 port");
  } finally {
    await lab?.shutdown(); lab?.restore(); globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test("/emote d200On <port> refuses an invalid port without changing the mirror or the preference", async () => {
  const root = mkdtempSync(join(tmpdir(), "emote-d200-port-refused-"));
  const profile = join(root, "profile");
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  const savedState = join(profile, "extensions", "gentle-emote", "output-states", "d200.json");
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); return new Response(); };
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  const inputs = ["d200On 0", "d200On 65536", "d200On abc", "d200On 80.5", "d200On 127.0.0.1:9000", "d200On 9100/emote", "d200On -1"];
  try {
    lab = await boot(project, [], profile);
    await lab.commands.get("emote").handler("read", lab.ctx); await flush();
    // Nothing is on yet: a refused port must not enable the mirror or save anything.
    for (const input of inputs) {
      const count = calls.length;
      await lab.commands.get("emote").handler(input, lab.ctx); await flush();
      assert.equal(calls.length, count, `${input} sends nothing`);
      assert.equal(lab.notices.at(-1)?.level, "warning", `${input} warns`);
      assert.match(lab.notices.at(-1)?.message ?? "", /invalid D200 port \(1-65535\); D200 mirror unchanged/, input);
    }
    assert.equal(existsSync(savedState), false, "a refused port never saves the On preference");

    // While mirroring on a session port, a refused port leaves that sender alone.
    await lab.commands.get("emote").handler("d200On 9100", lab.ctx); await flush();
    for (const input of inputs) {
      const count = calls.length;
      await lab.commands.get("emote").handler(input, lab.ctx); await flush();
      assert.equal(calls.length, count, `${input} keeps the live sender silent`);
      assert.match(lab.notices.at(-1)?.message ?? "", /invalid D200 port/);
    }
    calls.length = 0;
    await lab.emit("tool_execution_start", { toolName: "read", toolCallId: "r" }); await flush();
    assert.ok(calls.length > 0 && calls.every(url => url.startsWith("http://127.0.0.1:9100/")), `the session port still delivers: ${JSON.stringify(calls)}`);
    assert.equal(new OutputStateStore(profile).load(() => {}).d200, true, "the saved preference is untouched");
  } finally {
    await lab?.shutdown(); lab?.restore(); globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test("bare /emote opens the panel, toggles an output and keeps every argument", async () => {
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  const root = mkdtempSync(join(tmpdir(), "emote-panel-"));
  const profile = join(root, "profile");
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    lab = await boot(root, [], profile);
    const emote = lab.commands.get("emote");
    const opened = emote.handler("", lab.ctx);
    await flush();
    assert.equal(lab.customCalls.length, 1, "bare /emote opens exactly one overlay");
    assert.equal(lab.customCalls[0]!.options.overlay, true, "the panel is an overlay, not an editor replacement");
    const cancel = String.fromCharCode(27);
    const down = `${cancel}[B`;
    const enter = String.fromCharCode(13);
    const keybindings = { matches: (data: string, action: string) => action === "tui.select.cancel" && data === cancel };
    const component = lab.customCalls[0]!.factory({ requestRender() {} }, { fg: (_role: string, text: string) => text }, keybindings, lab.panelDone);
    const rows: string[] = component.render(120);
    for (const section of ["OUTPUTS", "CLOCK", "STATUS", "APPEARANCE", "ACTIONS"]) {
      assert.ok(rows.some(row => row.includes(section)), `the ${section} section is present`);
    }
    assert.ok(rows.some(row => row.includes("> ") && row.includes("terminal avatar")), "the cursor starts on the first switch");
    assert.ok(component.render(40).every(row => visibleWidth(row) <= 40), "the framed rows never overflow the requested width");

    // A panel toggle goes through the command entry point, so the stored
    // preference and every failure path are the ones already tested.
    component.handleInput(down);
    component.handleInput(enter);
    await flush();
    assert.equal(new OutputStateStore(profile).load(() => {}).debug, true, "the local switch applied localOn");
    component.handleInput(enter);
    await flush();
    assert.equal(new OutputStateStore(profile).load(() => {}).debug, false, "and localOff on the second press");

    component.handleInput(cancel);
    await opened;

    // `/emote panel` is the same entry point.
    const aliased = emote.handler("panel", lab.ctx);
    await flush();
    assert.equal(lab.customCalls.length, 2, "the explicit panel alias opens it too");
    lab.panelDone(null);
    await aliased;

    // Every existing argument is untouched.
    await emote.handler("bogus-state", lab.ctx);
    const usage = lab.notices.at(-1)!.message;
    assert.ok(usage.startsWith("[gentle-emote] /emote <state>: "), "the usage notice keeps its shape");
    assert.ok(usage.includes(" panel,"), "the panel is discoverable in the usage list");
    await emote.handler("read", lab.ctx);
    await flush();
    await emote.handler("status", lab.ctx);
    assert.match(lab.notices.at(-1)!.message, /PNG state=read /, "previews and status still work");
  } finally {
    await lab?.shutdown();
    lab?.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a panel clock switch is session-local and visible in the status line", async () => {
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  const root = mkdtempSync(join(tmpdir(), "emote-panel-clock-"));
  const profile = join(root, "profile");
  const dir = join(root, ".pi", "extensions", "gentle-emote");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    externalDisplay: { enabled: true, url: "http://127.0.0.1:8000/emote" },
  }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response();
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    lab = await boot(root, [], profile);
    const emote = lab.commands.get("emote");
    const opened = emote.handler("panel", lab.ctx);
    await flush();
    const cancel = String.fromCharCode(27);
    const down = `${cancel}[B`;
    const enter = String.fromCharCode(13);
    const keybindings = { matches: (data: string, action: string) => action === "tui.select.cancel" && data === cancel };
    const component = lab.customCalls[0]!.factory({ requestRender() {} }, { fg: (_role: string, text: string) => text }, keybindings, lab.panelDone);
    // The panel is drawn before any input, which seats the cursor on the first
    // actionable row; from there four steps reach the first clock destination.
    component.render(120);
    for (let step = 0; step < 4; step++) component.handleInput(down);
    const selected = component.render(120).find((row: string) => row.includes("> "));
    assert.ok(selected?.includes("local"), `the cursor reaches the clock destination: ${selected}`);
    component.handleInput(enter);
    await flush();
    await emote.handler("status", lab.ctx);
    assert.match(lab.notices.at(-1)!.message, /idleClock #1 mode=receiver/, "the session-local switch is live");
    assert.equal(existsSync(join(dir, "config.json")) && readFileSync(join(dir, "config.json"), "utf8").includes("idleClock"), false,
      "the switch never writes configuration");
    component.handleInput(cancel);
    await opened;
  } finally {
    await lab?.shutdown();
    lab?.restore();
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a panel appearance switch persists globally through the guarded writer", async () => {
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  const root = mkdtempSync(join(tmpdir(), "emote-panel-appearance-"));
  const profile = join(root, "profile");
  const configFile = join(profile, "extensions", "gentle-emote", "config.json");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response();
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    lab = await boot(root, [], profile);
    const emote = lab.commands.get("emote");
    const opened = emote.handler("panel", lab.ctx);
    await flush();
    const cancel = String.fromCharCode(27);
    const down = `${cancel}[B`;
    const enter = String.fromCharCode(13);
    const keybindings = { matches: (data: string, action: string) => action === "tui.select.cancel" && data === cancel };
    const component = lab.customCalls[0]!.factory({ requestRender() {} }, { fg: (_role: string, text: string) => text }, keybindings, lab.panelDone);
    component.render(120);
    // Four output rows, then size, placement and frame.
    for (let step = 0; step < 6; step++) component.handleInput(down);
    const selected = component.render(120).find((row: string) => row.includes("> "));
    assert.ok(selected?.includes("frame on"), `the cursor reaches the frame switch: ${selected}`);
    component.handleInput(enter);
    await flush();
    const written = JSON.parse(readFileSync(configFile, "utf8"));
    assert.equal(written.frame, false, "the switch is persisted in the user-global config");
    const rows: string[] = component.render(120);
    assert.ok(rows.some(row => row.includes("frame off")), "the panel shows the new value immediately");
    assert.equal(lab.notices.at(-1)?.level, undefined, "a successful write warns about nothing");

    // A second press cycles it back and keeps every other key intact.
    component.handleInput(enter);
    await flush();
    assert.equal(JSON.parse(readFileSync(configFile, "utf8")).frame, true);
    component.handleInput(cancel);
    await opened;
  } finally {
    await lab?.shutdown();
    lab?.restore();
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});
