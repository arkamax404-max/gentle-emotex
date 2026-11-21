import { test } from "node:test";
import assert from "node:assert/strict";
import { Container, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { OutputStateStore, OUTPUTS } from "../src/output_state.ts";
import { decodePng, encodePng } from "../src/png.ts";
import { prepareDisplayImage } from "../src/display_image.ts";
import { useSerialSystemDeps, type SerialPortLike } from "../src/serial_display.ts";
import { SERIAL_ENTER, SERIAL_ENTER_ACK, SERIAL_EXIT, SERIAL_EXIT_ACK, MAX_PNG_BYTES } from "../src/serial_protocol.ts";
import { crc32 } from "node:zlib";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { installNetworkGuard } from "./helpers/network.ts";

import { boot, PLACEHOLDER, SESSION_ID, SUBAGENT_CHANNEL } from "./helpers/boot.ts";

export { boot } from "./helpers/boot.ts";

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
      ["avatar gentleemotex", "avatar gentleled", "avatar gentleman", "avatar gentleman-yolo"]);
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
  for (const output of ["internal", "debug", "display", "usb"]) saved.save(output, true);
  // A legacy D200 preference left by an older version: session-local now, ignored.
  const legacyD200 = join(profile, "extensions", "gentle-emote", "output-states", "d200.json");
  writeFileSync(legacyD200, "true\n");
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
      internal: true, debug: true, d200: false, display: true, usb: true,
    }, "the child guard does not discard persistent output preferences; the session-local d200 is never loaded");
    assert.equal(readFileSync(legacyD200, "utf8"), "true\n", "the legacy d200 bytes survive untouched");
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
    assert.deepEqual(command.getArgumentCompletions("debug").map((item: any) => item.value), ["debugOn", "debugOff"]);
    assert.ok(command.getArgumentCompletions("debug").every((item: any) => item.description));
    assert.ok(command.description.includes("localOn | localOff"));
    assert.ok(command.description.includes("debugOn"), "the diagnostic commands are documented apart from the local output");
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

test("the D200 output is session-local: a saved On preference is ignored at start and no D200 command ever writes state", async () => {
  const root = mkdtempSync(join(tmpdir(), "emote-d200-session-local-"));
  const profile = join(root, "profile");
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  const stateDir = join(profile, "extensions", "gentle-emote", "output-states");
  mkdirSync(stateDir, { recursive: true });
  // A legacy preference left behind by an older version.
  const legacyState = join(stateDir, "d200.json");
  writeFileSync(legacyState, "true\n");
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); return new Response(); };
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    lab = await boot(project, [], profile);
    const emote = lab.commands.get("emote");
    await emote.handler("localOff", lab.ctx); await flush();
    await lab.emit("tool_execution_start", { toolName: "read", toolCallId: "r0" }); await flush();
    assert.equal(calls.filter(url => url.includes(":8003/")).length, 0, "a saved d200.json true never creates a sender at session start");
    assert.equal(readFileSync(legacyState, "utf8"), "true\n", "the legacy bytes stay untouched during the session");

    // On and Off change only the live session; nothing is written anywhere.
    await emote.handler("d200On", lab.ctx); await flush();
    await lab.emit("tool_execution_start", { toolName: "read", toolCallId: "r1" }); await flush();
    assert.ok(calls.some(url => url.startsWith("http://127.0.0.1:8003/")), "an explicit d200On mirrors frames");
    assert.equal(readFileSync(legacyState, "utf8"), "true\n", "d200On never rewrites the legacy preference");
    await emote.handler("d200Off", lab.ctx); await flush();
    assert.equal(readFileSync(legacyState, "utf8"), "true\n", "d200Off never rewrites the legacy preference");
    calls.length = 0;
    await lab.emit("tool_execution_start", { toolName: "write", toolCallId: "r2" }); await flush();
    assert.equal(calls.length, 0, "d200Off stops delivery");

    // A corrupt legacy file is ignored without warnings and without any rewrite.
    await lab.shutdown(); lab.restore(); lab = undefined;
    writeFileSync(legacyState, "{broken");
    calls.length = 0;
    lab = await boot(project, [], profile);
    assert.ok(!lab.notices.some(notice => notice.message.includes("d200")), "the obsolete d200 preference never warns");
    assert.equal(readFileSync(legacyState, "utf8"), "{broken", "a corrupt legacy preference is never rewritten");
    await lab.emit("tool_execution_start", { toolName: "read", toolCallId: "r3" }); await flush();
    assert.equal(calls.filter(url => url.includes(":8003/")).length, 0, "a corrupt legacy preference stays off");
  } finally {
    await lab?.shutdown(); lab?.restore(); globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test("the D200 mirror is isolated per session: another session never inherits it and session_start resets the port choice", async () => {
  const root = mkdtempSync(join(tmpdir(), "emote-d200-isolation-"));
  const profile = join(root, "profile");
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  const savedState = join(profile, "extensions", "gentle-emote", "output-states", "d200.json");
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); return new Response(); };
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    // Session A turns the mirror on at a chosen port.
    lab = await boot(project, [], profile);
    await lab.commands.get("emote").handler("localOff", lab.ctx); await flush();
    await lab.emit("tool_execution_start", { toolName: "read", toolCallId: "a0" }); await flush();
    calls.length = 0;
    await lab.commands.get("emote").handler("d200On 9100", lab.ctx); await flush();
    await lab.emit("tool_execution_start", { toolName: "read", toolCallId: "a1" }); await flush();
    assert.ok(calls.length > 0 && calls.every(url => url.startsWith("http://127.0.0.1:9100/")), "session A mirrors to its chosen port");
    await lab.shutdown(); lab.restore(); lab = undefined;

    // Session B starts later in the same profile: it inherits nothing.
    calls.length = 0;
    lab = await boot(project, [], profile);
    await lab.commands.get("emote").handler("localOff", lab.ctx); await flush();
    await lab.emit("tool_execution_start", { toolName: "read", toolCallId: "b0" }); await flush();
    assert.deepEqual(calls.filter(url => url.includes(":9100/") || url.includes(":8003/")).length, 0, `a separate session never inherits the mirror: ${JSON.stringify(calls)}`);
    assert.equal(existsSync(savedState), false, "no d200 state file is ever written by any session");
    await lab.shutdown(); lab.restore(); lab = undefined;

    // A fresh start also resets the port choice: bare d200On returns to the default.
    calls.length = 0;
    lab = await boot(project, [], profile);
    await lab.commands.get("emote").handler("localOff", lab.ctx); await flush();
    await lab.emit("tool_execution_start", { toolName: "read", toolCallId: "c0" }); await flush();
    assert.equal(calls.filter(url => url.includes(":8003/") || url.includes(":9100/")).length, 0, "a fresh session starts the mirror off");
    await lab.commands.get("emote").handler("d200On", lab.ctx); await flush();
    await lab.emit("tool_execution_start", { toolName: "read", toolCallId: "c1" }); await flush();
    assert.ok(calls.length > 0 && calls.every(url => url.startsWith("http://127.0.0.1:8003/")), "a bare d200On after a fresh start uses the process default port");
  } finally {
    await lab?.shutdown(); lab?.restore(); globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
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
    await emote.handler("localOff", lab.ctx); await flush();
    calls.length = 0;

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


test("local defaults on; independent global switches survive project changes and restart", async () => {
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
    assert.ok(calls.length > 0 && calls.every(url => url === "http://localhost:8000/emote"), "only configured loopback destinations start on");
    await lab.commands.get("emote").handler("localOff", lab.ctx); await flush();
    calls.length = 0;
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
    assert.ok(!calls.includes("http://127.0.0.1:8003/emote"), "the D200 mirror is session-local: a restart starts off even after d200On");
    assert.ok(calls.includes("http://matrix/emote"), "global displayOn survives restart");
    assert.ok(!calls.includes("http://disabled/emote"), "On never enables disabled destinations");
    for (const output of ["internalOff", "localOff", "d200Off", "displayOff"]) await lab.commands.get("emote").handler(output, lab.ctx);
    const store = new OutputStateStore(profile);
    const saved = store.load(() => {});
    const command = lab.commands.get("emote");
    // The diagnostic commands are recognized again, but they are session-local
    // toggles: they change no saved output, send no frame and never fall through
    // to the unknown-command help. Off is the default state of every session.
    for (const diagnostic of ["debugOff", "debugOn"]) {
      const count = calls.length;
      await command.handler(diagnostic, lab.ctx); await flush();
      assert.deepEqual(store.load(() => {}), saved, "a diagnostic command cannot change saved outputs");
      assert.equal(calls.length, count, "a diagnostic command cannot send a frame");
      assert.deepEqual(lab.notices.at(-1), {
        message: `[gentle-emote] unsupported-frame warnings ${diagnostic === "debugOn" ? "on" : "off"} (session-local)`,
        level: "info",
      });
    }
    await command.handler("debugOff", lab.ctx); await flush();
    assert.equal(new OutputStateStore(profile).load(() => {}).debug, false, "the diagnostic shares no preference key with the local output");
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
    await emote().handler("localOff", lab.ctx); await flush();
    await emote().handler("read", lab.ctx); await flush();
    calls.length = 0;
    await emote().handler("d200On 9100", lab.ctx); await flush();
    assert.ok(calls.length > 0, "the mirror delivers frames");
    assert.ok(calls.every(url => url.startsWith("http://127.0.0.1:9100/")), `every request goes to the session port: ${JSON.stringify(calls)}`);
    assert.equal(existsSync(globalConfig), false, "the port never enters config.json");
    assert.equal(existsSync(join(profile, "extensions", "gentle-emote", "output-states", "d200.json")), false, "the whole output is session-local: no d200.json is ever written");
    assert.match(lab.notices.at(-1)?.message ?? "", /D200 mirroring on: http:\/\/127\.0\.0\.1:9100\/emote/);

    // A second explicit port replaces the live sender instead of being ignored.
    calls.length = 0;
    await emote().handler("d200On 9101", lab.ctx); await flush();
    await lab.emit("tool_execution_start", { toolName: "read", toolCallId: "r2" }); await flush();
    assert.ok(calls.some(url => url.startsWith("http://127.0.0.1:9101/")), "the new port delivers");
    assert.ok(!calls.some(url => url.startsWith("http://127.0.0.1:9100/")), `the replaced sender stops: ${JSON.stringify(calls)}`);

    // d200Off then bare d200On keeps the session's remembered port choice.
    await emote().handler("d200Off", lab.ctx); await flush();
    calls.length = 0;
    await emote().handler("d200On", lab.ctx); await flush();
    await lab.emit("tool_execution_start", { toolName: "write", toolCallId: "r2b" }); await flush();
    assert.ok(calls.length > 0 && calls.every(url => url.startsWith("http://127.0.0.1:9101/")), `d200Off→d200On retains the session port choice: ${JSON.stringify(calls)}`);

    // The whole output is session-local: a reload starts off, and neither the
    // saved state nor the port choice survives it.
    await emote().handler("d200Off", lab.ctx); await flush();
    calls.length = 0;
    await lab.emit("session_start");
    await lab.emit("tool_execution_start", { toolName: "edit", toolCallId: "r3" }); await flush();
    assert.deepEqual(calls.filter(url => url.includes(":8003/") || url.includes(":9101/")).length, 0, `a reload starts the D200 mirror off: ${JSON.stringify(calls)}`);
    assert.equal(existsSync(join(profile, "extensions", "gentle-emote", "output-states", "d200.json")), false, "a reload still writes no d200.json");

    calls.length = 0;
    await lab.emit("tool_execution_start", { toolName: "read", toolCallId: "r4" }); await flush();
    assert.equal(calls.filter(url => url.includes(":8003/") || url.includes(":9101/")).length, 0, "d200Off still stops every D200 port");
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
    await lab.commands.get("emote").handler("localOff", lab.ctx); await flush();
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
    assert.equal(existsSync(savedState), false, "the session-local D200 never writes a preference file");
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
    await emote.handler("localOff", lab.ctx);
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
    // actionable row. Navigation is by target row, never by counting, so adding
    // an output cannot silently retarget this test.
    component.render(120);
    const selectRow = (needle: string) => {
      for (let step = 0; step < 24; step++) {
        component.handleInput(down);
        const row = component.render(120).find((line: string) => line.includes("> "));
        if (row?.includes(needle)) return row;
      }
      return undefined;
    };
    // The needle comes from the panel itself: the row right after the CLOCK
    // header is the destination the section reports.
    const header = component.render(120);
    const clockAt = header.findIndex((line: string) => line.includes("CLOCK"));
    assert.ok(clockAt >= 0 && header[clockAt + 1] !== undefined, `the panel lists a clock destination: ${JSON.stringify(header)}`);
    const clockRow = header[clockAt + 1]!;
    const needle = clockRow.includes("not-settled") ? "not-settled" : clockRow.includes("active") ? "active" : "remaining";
    const selected = selectRow(needle);
    assert.ok(selected, `the cursor reaches the clock destination (${needle})`);
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
    component.render(120);
    // Navigation is by target row, not by counting: adding an output must never
    // silently retarget these tests.
    const selectRow = (needle: string) => {
      for (let step = 0; step < 24; step++) {
        component.handleInput(down);
        const row = component.render(120).find((line: string) => line.includes("> "));
        if (row?.includes(needle)) return row;
      }
      return undefined;
    };
    const selected = selectRow("frame on");
    assert.ok(selected, "the cursor reaches the frame switch");
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

test("usbOn fails closed without a serial module or a valid port, and never saves On", async () => {
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  const root = mkdtempSync(join(tmpdir(), "emote-usb-"));
  const profile = join(root, "profile");
  const savedState = join(profile, "extensions", "gentle-emote", "output-states", "usb.json");
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    lab = await boot(root, [], profile);
    const emote = lab.commands.get("emote");

    await emote.handler("usbOn", lab.ctx);
    await flush();
    assert.equal(lab.notices.at(-1)?.level, "warning", "a missing display is a warning, never a crash");
    assert.match(lab.notices.at(-1)?.message ?? "", /no usb serial display found/);
    assert.equal(existsSync(savedState), false, "a failed open never persists On");

    for (const invalid of ["usbOn C:\COM5", "usbOn /dev/sda1", "usbOn COM5/extra"]) {
      await emote.handler(invalid, lab.ctx);
      await flush();
      assert.equal(lab.notices.at(-1)?.level, "warning", invalid);
      assert.match(lab.notices.at(-1)?.message ?? "", /invalid serial port/, invalid);
    }
    assert.equal(existsSync(savedState), false, "a refused port never persists anything");

    await emote.handler("usbOff", lab.ctx);
    await flush();
    assert.equal(new OutputStateStore(profile).load(() => {}).usb, false, "usbOff saves the off preference");
  } finally {
    await lab?.shutdown();
    lab?.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

function serialReply(requestId: number, result: number): Buffer {
  const head = Buffer.alloc(8);
  head.write("EMTR", 0, "latin1");
  head[4] = 1;
  head[5] = result;
  head.writeUInt16LE(requestId, 6);
  const crc = Buffer.alloc(4);
  crc.writeUInt32LE(crc32(head), 0);
  return Buffer.concat([head, crc]);
}

/** A fake CDC peer speaking protocol v1, mirroring the serial_display unit fake. */
function fakeCdcPort(options: { answers?: Array<number | "silent">; failWrite?: (data: Buffer) => boolean } = {}) {
  const listeners: Array<(chunk: Buffer) => void> = [];
  const written: Buffer[] = [];
  const answers = [...(options.answers ?? [])];
  const frames: Buffer[] = [];
  const emit = (chunk: Buffer) => {
    for (const listener of listeners) listener(chunk);
  };
  const port: SerialPortLike = {
    write(data: Buffer, callback?: (error?: Error | null) => void) {
      const copy = Buffer.from(data);
      written.push(copy);
      const failed = options.failWrite?.(copy) ?? false;
      const text = copy.toString("latin1");
      if (text === SERIAL_ENTER) {
        queueMicrotask(() => emit(Buffer.from(SERIAL_ENTER_ACK.replace(String.fromCharCode(10), String.fromCharCode(10)))));
      } else if (text === SERIAL_EXIT) {
        queueMicrotask(() => emit(Buffer.from(SERIAL_EXIT_ACK.replace(String.fromCharCode(10), String.fromCharCode(10)))));
      } else if (copy.subarray(0, 4).toString("latin1") === "EMTS") {
        frames.push(copy);
        const id = copy.readUInt16LE(8);
        const answer = answers.length > 0 ? answers.shift()! : 0;
        // A write that failed at the port never reached the device, so it is
        // not answered: the sender observes the rejection, not a reply.
        if (!failed && answer !== "silent") queueMicrotask(() => emit(serialReply(id, answer as number)));
      }
      callback?.(failed ? new Error("fake write failure") : null);
    },
    close(callback?: (error?: Error | null) => void) { callback?.(null); },
    on(_event: string, handler: (chunk: Buffer) => void) { listeners.push(handler); },
    off() {},
  };
  return { port, written, frames, answers };
}

/** Lets queued microtask replies and promise chains settle. */
const drain = async () => {
  for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve));
};

const countNotice = (notices: Array<{ message: string; level: string }>, pattern: RegExp) =>
  notices.filter(notice => pattern.test(notice.message));

test("usbOn reports the first accepted frame and repeats a firmware rejection once per cause", async () => {
  const root = mkdtempSync(join(tmpdir(), "emote-usb-frames-"));
  const profile = join(root, "profile");
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    lab = await boot(root, [], profile);
    const peer = fakeCdcPort();
    useSerialSystemDeps({ list: async () => [{ path: "COM5" }], open: async () => peer.port });
    const emote = lab.commands.get("emote");

    await emote.handler("usbOn", lab.ctx);
    await drain();
    assert.ok(lab.notices.some(n => /usb serial display: COM5/.test(n.message)), "the display starts");
    const accepted = countNotice(lab.notices, /usb frame accepted \(\d+ b64 chars\)/);
    assert.equal(accepted.length, 1, "the first accepted frame is reported once");
    assert.equal(accepted[0]?.level, "info", "an accepted frame is informational");

    // A firmware NACK (repeated across the one resend) must be visible, and the
    // same cause must not flood the notice channel on every later frame.
    peer.answers.push(2, 2, 2, 2);
    await emote.handler("tool", lab.ctx);
    await drain();
    assert.equal(countNotice(lab.notices, /usb frame rejected: rejected by the display: result 2/).length, 1,
      "the rejected frame is reported once");
    assert.equal(countNotice(lab.notices, /usb frame rejected/).at(-1)?.level, "warning");
    // A different state guarantees a fresh frame selection, so the same cause
    // is proven suppressed rather than merely never re-sent.
    await emote.handler("read", lab.ctx);
    await drain();
    assert.equal(countNotice(lab.notices, /usb frame rejected: rejected by the display: result 2/).length, 1,
      "the same rejection cause is not repeated");
  } finally {
    await lab?.shutdown();
    lab?.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("usbOn reports image composition failures once per cause", async () => {
  const root = mkdtempSync(join(tmpdir(), "emote-usb-compose-"));
  const profile = join(root, "profile");
  const project = join(root, "project");
  mkdirSync(join(project, ".pi", "extensions", "gentle-emote"), { recursive: true });
  writeFileSync(join(project, ".pi", "extensions", "gentle-emote", "config.json"),
    JSON.stringify({ externalDisplay: { background: "gray", transparentBackground: true } }));
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    lab = await boot(project, [], profile);
    const peer = fakeCdcPort();
    useSerialSystemDeps({ list: async () => [{ path: "COM5" }], open: async () => peer.port });
    const emote = lab.commands.get("emote");

    await emote.handler("usbOn", lab.ctx);
    await drain();
    assert.ok(lab.notices.some(n => /usb serial display: COM5/.test(n.message)), "the display still starts");
    assert.equal(countNotice(lab.notices, /usb image composition failed/).length, 1,
      "the composition failure is reported once");
    assert.equal(countNotice(lab.notices, /usb image composition failed/)[0]?.level, "warning");
    assert.equal(countNotice(lab.notices, /usb frame accepted/).length, 0,
      "a composition failure queues nothing for delivery");
    await emote.handler("tool", lab.ctx);
    await drain();
    assert.equal(countNotice(lab.notices, /usb image composition failed/).length, 1,
      "the same composition failure is not repeated");
  } finally {
    await lab?.shutdown();
    lab?.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("usbOn reports a failed frame write once per cause", async () => {
  const root = mkdtempSync(join(tmpdir(), "emote-usb-sendfail-"));
  const profile = join(root, "profile");
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    lab = await boot(root, [], profile);
    const peer = fakeCdcPort({ failWrite: data => data.subarray(0, 4).toString("latin1") === "EMTS" && peer.frames.length > 0 });
    useSerialSystemDeps({ list: async () => [{ path: "COM5" }], open: async () => peer.port });
    const emote = lab.commands.get("emote");

    await emote.handler("usbOn", lab.ctx);
    await drain();
    assert.ok(lab.notices.some(n => /usb serial display: COM5/.test(n.message)), "the claim write still succeeds");
    await emote.handler("tool", lab.ctx);
    await drain();
    assert.equal(countNotice(lab.notices, /usb frame send failed: fake write failure/).length, 1,
      "a rejected send promise is reported once");
    assert.equal(countNotice(lab.notices, /usb frame send failed/)[0]?.level, "warning");
    await emote.handler("tool", lab.ctx);
    await drain();
    assert.equal(countNotice(lab.notices, /usb frame send failed: fake write failure/).length, 1,
      "the same send failure is not repeated");
  } finally {
    await lab?.shutdown();
    lab?.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("usbOn reports a claim rejection and a failed claim write", async () => {
  const root = mkdtempSync(join(tmpdir(), "emote-usb-claim-"));
  const profile = join(root, "profile");
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    lab = await boot(root, [], profile);
    // The claim is the first EMTS frame; two NACKs exhaust the single resend.
    const nackPeer = fakeCdcPort({ answers: [3, 3] });
    useSerialSystemDeps({ list: async () => [{ path: "COM5" }], open: async () => nackPeer.port });
    let emote = lab.commands.get("emote");
    await emote.handler("usbOn", lab.ctx);
    await drain();
    assert.ok(lab.notices.some(n => /usb serial display: COM5/.test(n.message)), "the display starts even when the claim is refused");
    const rejected = countNotice(lab.notices, /usb claim rejected: rejected by the display: result 3/);
    assert.equal(rejected.length, 1, "a claim NACK is reported");
    assert.equal(rejected[0]?.level, "warning");

    await lab.shutdown();
    lab.restore();
    lab = undefined;

    // A claim whose write fails must surface too, not vanish into a void promise.
    lab = await boot(root, [], profile);
    const failPeer = fakeCdcPort({ failWrite: data => data.subarray(0, 4).toString("latin1") === "EMTS" });
    useSerialSystemDeps({ list: async () => [{ path: "COM5" }], open: async () => failPeer.port });
    emote = lab.commands.get("emote");
    await emote.handler("usbOn", lab.ctx);
    await drain();
    const failed = countNotice(lab.notices, /usb claim send failed: fake write failure/);
    assert.equal(failed.length, 1, "a rejected claim promise is reported");
    assert.equal(failed[0]?.level, "warning");
  } finally {
    await lab?.shutdown();
    lab?.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("bare usbOn offers a metadata selector for several ports and opens the exact chosen path", async () => {
  const root = mkdtempSync(join(tmpdir(), "emote-usb-select-"));
  const profile = join(root, "profile");
  const savedState = join(profile, "extensions", "gentle-emote", "output-states", "usb.json");
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    lab = await boot(root, [], profile);
    const opened: string[] = [];
    let listCalls = 0;
    const peer = fakeCdcPort();
    useSerialSystemDeps({
      list: async () => { listCalls += 1; return [
        // A macOS-style device name the CLI validator would reject: OS-discovered
        // paths must be opened as enumerated, never re-validated.
        { path: "/dev/cu.usbmodem14201", friendlyName: "Gentle LED Panel", manufacturer: "Arduino\u0007 (fake\u001b[31m)", serialNumber: "SN123", vendorId: "2341", productId: "0043" },
        { path: "COM7" },
      ]; },
      open: async (path: string) => { opened.push(path); return peer.port; },
    });
    const emote = lab.commands.get("emote");
    // Default answer is cancel, so run once without a choice first: cancel
    // leaves every piece of live truth untouched.
    await emote.handler("usbOn", lab.ctx);
    await drain();
    assert.equal(lab.selectCalls.length, 1, "several ports ask the interactive user");
    assert.equal(lab.selectCalls[0]!.title, "USB serial display");
    assert.equal(lab.selectCalls[0]!.options.length, 2);
    const labelled = lab.selectCalls[0]!.options[0]!;
    assert.ok(labelled.includes("/dev/cu.usbmodem14201"), "the label names the OS path");
    assert.ok(labelled.includes("Gentle LED Panel") && labelled.includes("SN123"), "optional metadata is offered");
    assert.ok(labelled.includes("Arduino (fake)"), "the manufacturer is readable");
    assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(labelled), "control sequences are sanitized before TUI render");
    assert.ok(labelled.includes("2341:0043"), "vendor and product ids are offered");
    assert.equal(lab.selectCalls[0]!.options[1], "COM7", "a bare port shows its path alone");
    assert.deepEqual(opened, [], "cancelling opens nothing");
    assert.equal(lab.notices.at(-1)?.level, "warning");
    assert.match(lab.notices.at(-1)?.message ?? "", /usb serial display unchanged/);
    assert.equal(existsSync(savedState), false, "cancelling never persists On");

    // Choosing the first entry opens exactly the enumerated path.
    lab.selectControl.choice = lab.selectCalls[0]!.options[0]!;
    await emote.handler("usbOn", lab.ctx);
    await drain();
    assert.equal(lab.selectCalls.length, 2, "the cancelled attempt is not remembered as a choice");
    assert.deepEqual(opened, ["/dev/cu.usbmodem14201"], "the selected original path is opened directly");
    assert.ok(lab.notices.some(n => /usb serial display: \/dev\/cu.usbmodem14201/.test(n.message)), "the chosen path is confirmed");
    assert.equal(JSON.parse(readFileSync(savedState, "utf8")), true, "a successful selection persists On");
    // Every rule keeps its scope: only the two bare commands enumerated.
    assert.equal(listCalls, 2, "each bare command enumerates once, without duplicate listing");
  } finally {
    await lab?.shutdown();
    lab?.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed selected open keeps the session port unremembered; a successful one is reused after usbOff", async () => {
  const root = mkdtempSync(join(tmpdir(), "emote-usb-remember-"));
  const profile = join(root, "profile");
  const savedState = join(profile, "extensions", "gentle-emote", "output-states", "usb.json");
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    lab = await boot(root, [], profile);
    let failOpen = true;
    const opened: string[] = [];
    const peer = fakeCdcPort();
    useSerialSystemDeps({
      list: async () => [{ path: "/dev/cu.usbmodem14201" }, { path: "COM7" }],
      open: async (path: string) => {
        opened.push(path);
        if (failOpen) throw new Error("device busy");
        return peer.port;
      },
    });
    const emote = lab.commands.get("emote");
    failOpen = true;

    // A selection whose open fails must not become the session's remembered port.
    lab.selectControl.choice = "/dev/cu.usbmodem14201";
    await emote.handler("usbOn", lab.ctx);
    await drain();
    assert.match(lab.notices.at(-1)?.message ?? "", /cannot open \/dev\/cu.usbmodem14201.*unchanged/);
    assert.equal(existsSync(savedState), false, "a failed open never persists On");
    // The failed port is not remembered: the selector is offered again.
    await emote.handler("usbOn", lab.ctx);
    await drain();
    assert.equal(lab.selectCalls.length, 2, "a failed selected open is not remembered");
    failOpen = false;
    lab.selectControl.choice = "COM7";
    await emote.handler("usbOn", lab.ctx);
    await drain();
    assert.equal(lab.selectCalls.length, 3, "the third command is the first successful choice");
    assert.equal(opened.at(-1), "COM7", "the chosen port is the one that opens");
    const remembered = lab.selectCalls.length;
    // usbOff keeps the session choice: bare usbOn reuses it without prompting.
    await emote.handler("usbOff", lab.ctx);
    await drain();
    await emote.handler("usbOn", lab.ctx);
    await drain();
    assert.equal(lab.selectCalls.length, remembered, "the remembered session port is reused after usbOff");
    assert.equal(opened.at(-1), "COM7");
    // An explicit port bypasses the selector and replaces the remembered one.
    const before = lab.selectCalls.length;
    await emote.handler("usbOff", lab.ctx);
    await drain();
    await emote.handler("usbOn COM9", lab.ctx);
    await drain();
    assert.equal(lab.selectCalls.length, before, "an explicit port never shows the selector");
    assert.equal(opened.at(-1), "COM9");
  } finally {
    await lab?.shutdown();
    lab?.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("one visible port connects without a selector and headless multi keeps the refusal", async () => {
  const root = mkdtempSync(join(tmpdir(), "emote-usb-one-"));
  const profile = join(root, "profile");
  const savedState = join(profile, "extensions", "gentle-emote", "output-states", "usb.json");
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    lab = await boot(root, [], profile);
    const opened: string[] = [];
    const peer = fakeCdcPort();
    useSerialSystemDeps({
      list: async () => [{ path: "COM5" }],
      open: async (path: string) => { opened.push(path); return peer.port; },
    });
    const emote = lab.commands.get("emote");
    await emote.handler("usbOn", lab.ctx);
    await drain();
    assert.equal(lab.selectCalls.length, 0, "a single candidate never prompts");
    assert.deepEqual(opened, ["COM5"], "the single display connects directly");
    await lab.shutdown();
    lab.restore();
    lab = undefined;

    // Without a selector UI, several ports keep the transport refusal and open
    // nothing: the warning the CLI always gave.
    const profile2 = join(root, "profile2");
    lab = await boot(root, [], profile2);
    const headless = { ...lab.ctx, ui: { ...lab.ctx.ui, select: undefined } } as any;
    const headlessOpen: string[] = [];
    useSerialSystemDeps({
      list: async () => [{ path: "COM5" }, { path: "COM7" }],
      open: async (path: string) => { headlessOpen.push(path); return peer.port; },
    });
    const refuse = lab.commands.get("emote");
    await refuse.handler("usbOn", headless);
    await drain();
    assert.deepEqual(lab.selectCalls, [], "no modal without a selector UI");
    assert.deepEqual(headlessOpen, [], "refused ambiguity opens nothing");
    assert.match(lab.notices.at(-1)?.message ?? "", /more than one serial port is visible/);
    assert.equal(lab.notices.at(-1)?.level, "warning");
    const savedState2 = join(profile2, "extensions", "gentle-emote", "output-states", "usb.json");
    assert.equal(existsSync(savedState2), false, "the refusal persists nothing");
  } finally {
    await lab?.shutdown();
    lab?.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the session_start usb auto-restore never opens a selector modal", async () => {
  const root = mkdtempSync(join(tmpdir(), "emote-usb-restore-"));
  const profile = join(root, "profile");
  const stateDir = join(profile, "extensions", "gentle-emote", "output-states");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "usb.json"), "true\n");
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    lab = await boot(root, [], profile);
    const opened: string[] = [];
    const peer = fakeCdcPort();
    useSerialSystemDeps({
      list: async () => [{ path: "COM5" }, { path: "COM7" }],
      open: async (path: string) => { opened.push(path); return peer.port; },
    });
    // The choice is pre-set: if the restore ever prompted, it would open.
    lab.selectControl.choice = "COM5";
    await lab.emit("session_start");
    await drain();
    assert.deepEqual(lab.selectCalls, [], "an automatic restore never prompts");
    assert.deepEqual(opened, [], "ambiguity during restore opens nothing");
    assert.match(lab.notices.at(-1)?.message ?? "", /more than one serial port is visible/);
    assert.equal(lab.notices.at(-1)?.level, "warning");
  } finally {
    await lab?.shutdown();
    lab?.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

// --- USB layout parity with the HTTP LED composition (outline + title) ---

/** Solid opaque sprite with no accent-key pixels, so the frame base64 stays byte-identical. */
const LED_SPRITE = (() => {
  const width = 12, height = 8;
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = 180; data[i + 1] = 60; data[i + 2] = 40; data[i + 3] = 255; }
  return encodePng({ width, height, data });
})();
const LED_SPRITE_BASE64 = LED_SPRITE.toString("base64");
/** The LED caption ink the HTTP composition uses by default (green context band). */
const USB_LED_INK: [number, number, number] = [0, 255, 0];

/** The exact bytes the USB composition must carry for the given LED layout inputs. */
function expectedUsbLedImage(title: string | null, outline: string): Buffer {
  return prepareDisplayImage(
    LED_SPRITE_BASE64,
    { status: "idle", phase: "idle", activeSubagents: 0, state: "think" },
    "#000000", 1, outline, false, title, USB_LED_INK,
  );
}

/** Extracts the raw PNG payload of a captured EMTS frame (op 0 = image). */
function usbImagePayload(frame: Buffer): Buffer {
  const sessionIdLength = frame.readUInt16LE(10);
  const nameLength = frame.readUInt16LE(12);
  const payloadLength = frame.readUInt32LE(14);
  return frame.subarray(18 + sessionIdLength + nameLength, 18 + sessionIdLength + nameLength + payloadLength);
}

/** Boots a project with a single-frame sprite set and a fake CDC peer for usbOn. */
async function bootUsbLayoutLab(root: string, outline?: string) {
  const dir = join(root, ".pi", "extensions", "gentle-emote");
  mkdirSync(join(dir, "emotes", "ledsprite", "think"), { recursive: true });
  writeFileSync(join(dir, "emotes", "ledsprite", "think", "think.png"), LED_SPRITE);
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    emotes: [{ model: "*", "emote-set": "ledsprite" }],
    ...(outline === undefined ? {} : { externalDisplay: { outline } }),
  }));
  const peer = fakeCdcPort();
  const lab = await boot(root, [], join(root, "profile"));
  // boot() installs its own empty serial deps, so the fake peer is bound after it.
  useSerialSystemDeps({ list: async () => [{ path: "COM5" }], open: async () => peer.port });
  return { lab, peer, emote: lab.commands.get("emote") };
}

test("usbOn forces opaque physical frames despite transparentBackground true", async () => {
  const root = mkdtempSync(join(tmpdir(), "emote-usb-opaque-"));
  const dir = join(root, ".pi", "extensions", "gentle-emote");
  const sprite = encodePng({ width: 4, height: 1, data: new Uint8Array([
    80, 40, 20, 0, 200, 100, 50, 128, 20, 60, 100, 255, 0, 0, 0, 255,
  ]) });
  mkdirSync(join(dir, "emotes", "ledsprite", "think"), { recursive: true });
  writeFileSync(join(dir, "emotes", "ledsprite", "think", "think.png"), sprite);
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    emotes: [{ model: "*", "emote-set": "ledsprite" }],
    externalDisplay: { transparentBackground: true, background: "#404040" },
  }));
  const peer = fakeCdcPort();
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    lab = await boot(root, [], join(root, "profile"));
    useSerialSystemDeps({ list: async () => [{ path: "COM5" }], open: async () => peer.port });
    const emote = lab.commands.get("emote");
    await emote.handler("usbOn", lab.ctx); await drain();
    await emote.handler("think", lab.ctx); await drain();
    const frames = peer.frames.filter(frame => frame[5] === 0);
    assert.ok(frames.length > 0, "the public command delivers an actual serial image frame");
    const payload = usbImagePayload(frames.at(-1)!);
    const image = decodePng(payload);
    assert.deepEqual([image.width, image.height], [64, 64]);
    let blended = false;
    for (let i = 0; i < image.data.length; i += 4) {
      assert.equal(image.data[i + 3], 255, "all physical pixels, including padding, must be opaque");
      if (image.data[i] === 132 && image.data[i + 1] === 82 && image.data[i + 2] === 57) blended = true;
    }
    assert.ok(blended, "partial-alpha artwork is composited against the configured RGB background");
    assert.ok(payload.equals(prepareDisplayImage(sprite.toString("base64"),
      { status: "idle", phase: "idle", activeSubagents: 0, state: "think" },
      "#404040", 1, "#ffffff", false, basename(root), USB_LED_INK)),
    "USB keeps its outline, title, labels and exact opaque composition");
    assert.equal(new OutputStateStore(join(root, "profile")).load(message => assert.fail(message)).usb, true);
  } finally {
    await lab?.shutdown(); lab?.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("usbOn composes the same LED outline as displayOn: white by default, configured color overrides", async () => {
  const root = mkdtempSync(join(tmpdir(), "emote-usb-outline-"));
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  const imageFrames = (peer: { frames: Buffer[] }) => peer.frames.filter(frame => frame[5] === 0);
  try {
    // No outline configured: the USB composition must behave like a non-loopback
    // LED destination and still receive the white silhouette.
    let boot1 = await bootUsbLayoutLab(root);
    lab = boot1.lab;
    await boot1.emote.handler("usbOn", lab.ctx);
    await drain();
    await boot1.emote.handler("think", lab.ctx);
    await drain();
    assert.ok(imageFrames(boot1.peer).length > 0, "usbOn delivers the preview frame");
    assert.ok(usbImagePayload(imageFrames(boot1.peer).at(-1)!).equals(expectedUsbLedImage(basename(root), "#ffffff")),
      "the USB composition carries the default white LED outline");
    await lab.shutdown(); lab.restore(); lab = undefined;

    // A configured group outline overrides the default on USB, like on the LAN.
    const outlined = join(root, "outlined");
    const boot2 = await bootUsbLayoutLab(outlined, "#2a7fff");
    lab = boot2.lab;
    await boot2.emote.handler("usbOn", lab.ctx);
    await drain();
    await boot2.emote.handler("think", lab.ctx);
    await drain();
    assert.ok(imageFrames(boot2.peer).length > 0, "usbOn delivers the preview frame again");
    assert.ok(usbImagePayload(imageFrames(boot2.peer).at(-1)!).equals(expectedUsbLedImage(basename(outlined), "#2a7fff")),
      "the USB composition carries the configured outline color");
  } finally {
    await lab?.shutdown();
    lab?.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("usbOn captions the effective project title and /emote title recomposes the live USB frame", async () => {
  const root = mkdtempSync(join(tmpdir(), "emote-usb-title-"));
  const dir = join(root, ".pi", "extensions", "gentle-emote");
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    const boot1 = await bootUsbLayoutLab(root);
    lab = boot1.lab;
    const imageFrames = () => boot1.peer.frames.filter(frame => frame[5] === 0);
    await boot1.emote.handler("usbOn", lab.ctx);
    await drain();
    await boot1.emote.handler("think", lab.ctx);
    await drain();
    const folder = basename(root);
    assert.ok(imageFrames().length > 0, "usbOn delivers the preview frame");
    assert.ok(usbImagePayload(imageFrames().at(-1)!).equals(expectedUsbLedImage(folder, "#ffffff")),
      "the fallback caption is the validated project folder basename");
    assert.ok(usbImagePayload(imageFrames().at(-1)!).length <= MAX_PNG_BYTES,
      "the captioned payload fits the serial cap");

    // A live title set recomposes the current USB frame immediately, without
    // waiting for another animation selection.
    const before = imageFrames().length;
    await boot1.emote.handler("title  USB Título ", lab.ctx);
    await drain();
    assert.ok(imageFrames().length > before, "/emote title requeues the current USB frame immediately");
    assert.ok(usbImagePayload(imageFrames().at(-1)!).equals(expectedUsbLedImage("USB Título", "#ffffff")),
      "the live caption uses the saved title");
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "title.json"), "utf8")), { title: "USB Título" });

    // A rejected title mutates nothing and sends no frame.
    const rejected = imageFrames().length;
    await boot1.emote.handler("title a/b", lab.ctx);
    await drain();
    assert.equal(imageFrames().length, rejected, "an invalid title sends no USB frame");
    assert.equal(lab.notices.at(-1)?.level, "warning");
    assert.match(lab.notices.at(-1)?.message ?? "", /invalid title/);

    // The bare reset recomposes with the folder basename again.
    await boot1.emote.handler("title", lab.ctx);
    await drain();
    assert.ok(imageFrames().length > rejected, "the bare reset recomposes the USB frame");
    assert.ok(usbImagePayload(imageFrames().at(-1)!).equals(expectedUsbLedImage(folder, "#ffffff")),
      "the bare reset restores the folder basename caption");
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "title.json"), "utf8")), { title: null });
  } finally {
    await lab?.shutdown();
    lab?.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

// --- USB receiver idle-clock handoff ---

/** The exact bytes the USB clock carrier must carry: the settled avatar composed like an ordinary frame. */
function expectedUsbClockCarrier(title: string | null, outline: string): Buffer {
  return prepareDisplayImage(
    LED_SPRITE_BASE64,
    { status: "idle", phase: "idle", activeSubagents: 0, state: "idle" },
    "#000000", 1, outline, false, title, USB_LED_INK,
  );
}

/** Boots a project with idle and think sprite frames, a fake CDC peer and an optional group clock mode. */
async function bootUsbClockLab(root: string, idleClock?: "off" | "receiver" | "silence") {
  const dir = join(root, ".pi", "extensions", "gentle-emote");
  mkdirSync(join(dir, "emotes", "ledsprite", "idle"), { recursive: true });
  mkdirSync(join(dir, "emotes", "ledsprite", "think"), { recursive: true });
  writeFileSync(join(dir, "emotes", "ledsprite", "idle", "idle.png"), LED_SPRITE);
  writeFileSync(join(dir, "emotes", "ledsprite", "idle", "idle_blink.png"), LED_SPRITE);
  writeFileSync(join(dir, "emotes", "ledsprite", "think", "think.png"), LED_SPRITE);
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    emotes: [{ model: "*", "emote-set": "ledsprite" }],
    ...(idleClock === undefined ? {} : { externalDisplay: { idleClock } }),
  }));
  const peer = fakeCdcPort();
  const lab = await boot(root, [], join(root, "profile"));
  useSerialSystemDeps({ list: async () => [{ path: "COM5" }], open: async () => peer.port });
  return { lab, peer, emote: lab.commands.get("emote") };
}

test("usbOn defaults to the receiver clock handoff: one carrier past five idle minutes, resumed on activity", async t => {
  const root = mkdtempSync(join(tmpdir(), "emote-usb-clock-"));
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    // Deterministic monotonic clock: no five-minute wait, no real timer reliance.
    let elapsed = 1_000;
    t.mock.method(performance, "now", () => elapsed);
    const booted = await bootUsbClockLab(root);
    lab = booted.lab;
    const imageFrames = () => booted.peer.frames.filter(frame => frame[5] === 0);
    const clockFrames = () => imageFrames().filter(frame => (frame[6] & 4) === 4);
    const ordinaryFrames = () => imageFrames().filter(frame => (frame[6] & 4) === 0);

    await booted.emote.handler("usbOn", lab.ctx);
    await drain();
    assert.ok(ordinaryFrames().length > 0, "the link starts with the settled idle frame");

    // The carrier caption is the same live validated project title the ordinary
    // frames use; set it before the deadline so both compositions carry it.
    await booted.emote.handler("title USB Clock", lab.ctx);
    await drain();
    const afterTitle = ordinaryFrames().length;
    assert.ok(afterTitle > 1, "the title recomposition requeues the settled frame");

    // Settled but exactly at the strict deadline: nothing is handed off yet.
    elapsed = 1_000 + 300_000;
    await lab.emit("agent_end");
    await drain();
    assert.equal(clockFrames().length, 0, "exactly 300000 ms of settled idleness is not enough");

    // Past the strict deadline the receiver gets exactly one clock-tagged carrier
    // composed from the current avatar and its live validated title.
    elapsed = 1_000 + 300_001;
    await lab.emit("agent_end");
    await drain();
    assert.equal(clockFrames().length, 1, "the timeout queues exactly one clock carrier");
    assert.ok(usbImagePayload(clockFrames()[0]!).equals(expectedUsbClockCarrier("USB Clock", "#ffffff")),
      "the carrier is the current avatar composed with the live title and the LED layout");

    // The ambient period owns the panel: further settled activity and ordinary
    // idle selections send nothing more.
    elapsed = 1_000 + 300_500;
    await lab.emit("agent_end");
    await drain();
    await booted.emote.handler("idle", lab.ctx);
    await drain();
    assert.equal(clockFrames().length, 1, "the carrier is never repeated");
    assert.equal(ordinaryFrames().length, afterTitle, "ordinary frames stay suppressed while ambient");

    // Real activity ends the ambient period immediately with an ordinary frame.
    await booted.emote.handler("think", lab.ctx);
    await drain();
    assert.equal(clockFrames().length, 1, "resuming never touches the carrier");
    assert.equal(ordinaryFrames().length, afterTitle + 1, "the latest ordinary frame resumes delivery at once");
    assert.equal(ordinaryFrames().at(-1)![6] & 4, 0, "the resumed frame is an ordinary avatar frame");
    assert.ok(usbImagePayload(ordinaryFrames().at(-1)!).equals(expectedUsbLedImage("USB Clock", "#ffffff")),
      "the resumed frame is the latest avatar with its caption");
  } finally {
    await lab?.shutdown();
    lab?.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an explicit externalDisplay.idleClock off keeps ordinary USB delivery past the deadline", async t => {
  const root = mkdtempSync(join(tmpdir(), "emote-usb-clock-off-"));
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    let elapsed = 1_000;
    t.mock.method(performance, "now", () => elapsed);
    const booted = await bootUsbClockLab(root, "off");
    lab = booted.lab;
    const imageFrames = () => booted.peer.frames.filter(frame => frame[5] === 0);
    const clockFrames = () => imageFrames().filter(frame => (frame[6] & 4) === 4);
    const ordinaryFrames = () => imageFrames().filter(frame => (frame[6] & 4) === 0);

    await booted.emote.handler("usbOn", lab.ctx);
    await drain();
    const started = ordinaryFrames().length;
    assert.ok(started > 0, "the link starts with the settled idle frame");

    elapsed = 1_000 + 300_001;
    await lab.emit("agent_end");
    await drain();
    await booted.emote.handler("idle", lab.ctx);
    await drain();
    assert.equal(clockFrames().length, 0, "an explicit off never hands the panel to the clock");
    assert.ok(ordinaryFrames().length > started, "ordinary delivery continues past the deadline");
  } finally {
    await lab?.shutdown();
    lab?.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an explicit externalDisplay.idleClock silence stops USB image traffic while ambient and resumes on activity", async t => {
  const root = mkdtempSync(join(tmpdir(), "emote-usb-clock-silence-"));
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    let elapsed = 1_000;
    t.mock.method(performance, "now", () => elapsed);
    const booted = await bootUsbClockLab(root, "silence");
    lab = booted.lab;
    const imageFrames = () => booted.peer.frames.filter(frame => frame[5] === 0);
    const clockFrames = () => imageFrames().filter(frame => (frame[6] & 4) === 4);
    const ordinaryFrames = () => imageFrames().filter(frame => (frame[6] & 4) === 0);

    await booted.emote.handler("usbOn", lab.ctx);
    await drain();
    const started = ordinaryFrames().length;
    assert.ok(started > 0, "the link starts with the settled idle frame");

    elapsed = 1_000 + 300_001;
    await lab.emit("agent_end");
    await drain();
    assert.equal(clockFrames().length, 0, "silence never composes a clock carrier");
    await booted.emote.handler("idle", lab.ctx);
    await drain();
    assert.equal(ordinaryFrames().length, started, "image traffic is suppressed while silenced");

    await booted.emote.handler("think", lab.ctx);
    await drain();
    assert.ok(ordinaryFrames().length > started, "ordinary delivery resumes immediately on activity");
  } finally {
    await lab?.shutdown();
    lab?.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("usbOff clears the clock truth and a restarted link starts its five minutes over", async t => {
  const root = mkdtempSync(join(tmpdir(), "emote-usb-clock-reset-"));
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    let elapsed = 1_000;
    t.mock.method(performance, "now", () => elapsed);
    const booted = await bootUsbClockLab(root);
    lab = booted.lab;
    const clockFrames = () => booted.peer.frames.filter(frame => frame[5] === 0 && (frame[6] & 4) === 4);
    const ordinaryFrames = () => booted.peer.frames.filter(frame => frame[5] === 0 && (frame[6] & 4) === 0);

    // The idle time already accumulated before the link starts owns nothing:
    // the clock truth begins with the link itself.
    elapsed = 1_000 + 300_001;
    await booted.emote.handler("usbOn", lab.ctx);
    await drain();
    await lab.emit("agent_end");
    await drain();
    assert.equal(clockFrames().length, 0, "a fresh link starts its idle deadline at zero");

    await booted.emote.handler("usbOff", lab.ctx);
    await drain();
    await booted.emote.handler("usbOn", lab.ctx);
    await drain();
    await lab.emit("agent_end");
    await drain();
    assert.equal(clockFrames().length, 0, "a restarted link starts its idle deadline at zero again");
    assert.ok(ordinaryFrames().length > 0, "ordinary delivery continues across the restart");

    elapsed += 300_001;
    await lab.emit("agent_end");
    await drain();
    assert.equal(clockFrames().length, 1, "the restarted link hands off once its own deadline elapses");
  } finally {
    await lab?.shutdown();
    lab?.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a boot without a test-owned fetch mock records every delivery in the session guard instead of the network", async () => {
  const root = mkdtempSync(join(tmpdir(), "emote-boot-guard-"));
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    // No global fetch mock: the harness guard itself must own the network.
    lab = await boot(root);
    await lab.emit("tool_execution_start", { toolName: "bash" });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(lab.network.requests.length > 0, "the harness guard captures the outgoing frames");
    for (const request of lab.network.requests) {
      assert.equal(new URL(request.url).host, "127.0.0.1:8001", `only the shipped loopback destination is reached, not ${request.url}`);
    }
  } finally {
    await lab?.shutdown(); lab?.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a YOLO rest pose hands the receiver clock the panel after five settled minutes", async t => {
  let elapsed = 1_000;
  t.mock.method(performance, "now", () => elapsed);
  const root = mkdtempSync(join(tmpdir(), "emote-yolo-clock-"));
  const dir = join(root, ".pi", "extensions", "gentle-emote");
  const png = encodePng({ width: 1, height: 1, data: new Uint8Array([0, 0, 0, 255]) });
  for (const [set, state] of [["custom", "idle"], ["custom-yolo", "yolo"]] as const) {
    const stateDir = join(dir, "emotes", set, state);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, `${state}.png`), png);
  }
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    emotes: [{ model: "*", "emote-set": "custom" }],
    externalDisplay: { enabled: true, url: "http://127.0.0.1:8000/emote", idleClock: "receiver" },
  }));
  const originalFetch = globalThis.fetch;
  const calls: RequestInit[] = [];
  globalThis.fetch = async (_url, init) => { calls.push(init!); return new Response(); };
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    lab = await boot(root, ["localOn"]);
    lab.busSent.find(x => x.channel === "gentle:yolo:host-ui")!.payload.respond({
      read: async () => "ON",
      readMode: async () => "yolo",
      observe: () => () => {},
    });
    await flush();
    await flush();
    assert.ok(calls.some(call => new Headers(call.headers).get("X-Emote-State") === "yolo"),
      "the YOLO rest pose is the delivered idle selection");
    elapsed = 1_000 + 300_001;
    await lab.emit("agent_end");
    await flush();
    const carrier = calls.find(call => new Headers(call.headers).get("X-Emote-State") === "clock");
    assert.ok(carrier, "the receiver clock takes over from the YOLO rest after five minutes");
    assert.equal(new Headers(carrier!.headers).get("X-Emote-Frame"), "clock.png");
    assert.equal(new Headers(carrier!.headers).get("X-Emote-Set"), "idle-clock");
  } finally {
    await lab?.shutdown(); lab?.restore(); globalThis.fetch = originalFetch;
    t.mock.restoreAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("d200On wires Herdr focus only with valid context: one execution, ACK on the next frame, inert without Herdr", async t => {
  const root = mkdtempSync(join(tmpdir(), "emote-d200-focus-"));
  const profile = join(root, "profile");
  const configDir = join(profile, "extensions", "gentle-emote");
  mkdirSync(configDir, { recursive: true });
  // Isolate the D200 mirror: no configured desktop receiver competes for focus.
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ enabled: true, externalDisplay: { enabled: false } }));
  const herdrEnv = { HERDR_ENV: "1", HERDR_BIN_PATH: "/test/herdr", HERDR_SOCKET_PATH: "/test/socket", HERDR_PANE_ID: "pane-A" };
  const confirmed = JSON.stringify({ result: { type: "agent_info", agent: { pane_id: "pane-A", focused: true } } });
  const oldFetch = globalThis.fetch;
  const savedEnv = Object.entries(herdrEnv).map(([key]) => [key, process.env[key]] as const);
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const streams = new Set<string>();
  globalThis.fetch = (async (url, init) => {
    calls.push({ url: String(url), init });
    const stream = new Headers(init?.headers).get("X-Emote-Stream-Id");
    if (stream !== null && !streams.has(stream)) {
      streams.add(stream);
      return new Response(null, { status: 204, headers: { "X-Emote-Focus-Request-Id": `click-${streams.size}` } });
    }
    return new Response();
  }) as typeof fetch;
  const executions: Array<{ args: string[]; done: (error: Error | null, stdout: string, stderr: string) => void }> = [];
  t.mock.method(childProcess, "execFile", (_file: string, args: string[], _options: unknown, done: (error: Error | null, stdout: string, stderr: string) => void) => {
    const execution = { args, done }; executions.push(execution);
    return { kill: () => true };
  });
  syncBuiltinESMExports();
  const d200Acks = () => calls.filter(call => call.url.includes(":8003/")).map(call => new Headers(call.init!.headers).get("X-Emote-Focus-Ack"));
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    // Valid context: the explicit d200On sender requests focus and ACKs the confirmed click.
    Object.assign(process.env, herdrEnv);
    lab = await boot(root, [], profile);
    const emote = lab.commands.get("emote");
    await emote.handler("d200On", lab.ctx);
    await lab.emit("tool_execution_start", { toolName: "bash" });
    await flush();
    assert.ok(calls.some(call => call.url === "http://127.0.0.1:8003/emote"), "d200On mirrors frames");
    assert.equal(executions.length, 1, "the wired sender launched exactly one focus process");
    assert.deepEqual(executions[0]!.args, ["agent", "focus", "pane-A"]);
    executions[0]!.done(null, confirmed, ""); await flush();
    await lab.emit("tool_execution_start", { toolName: "read" });
    await flush();
    const validAcks = d200Acks();
    assert.equal(validAcks.at(-1), "click-1", "ACK rides an ordinary D200 frame after confirmation");
    assert.ok(validAcks.slice(0, -1).every(value => value === null), "no ACK precedes the confirmed focus");
    await lab.shutdown();
    lab = undefined;

    // Invalid context: the same wiring stays completely inert.
    calls.length = 0;
    for (const [key] of savedEnv) delete process.env[key];
    lab = await boot(root, [], profile);
    const emote2 = lab.commands.get("emote");
    await emote2.handler("d200On", lab.ctx);
    await lab.emit("tool_execution_start", { toolName: "bash" });
    await flush();
    await lab.emit("tool_execution_start", { toolName: "read" });
    await flush();
    assert.ok(calls.some(call => call.url === "http://127.0.0.1:8003/emote"), "the mirror still delivers ordinary frames");
    assert.equal(executions.length, 1, "missing Herdr context never launches a focus process");
    assert.ok(d200Acks().every(value => value === null), "no ACK is ever emitted without the controller");
  } finally {
    await lab?.shutdown(); lab?.restore(); globalThis.fetch = oldFetch;
    savedEnv.forEach(([key, value]) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; });
    t.mock.restoreAll(); syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test("debugOn/debugOff: session-local diagnostic for the unsupported-frame warning, default off", async () => {
  const root = mkdtempSync(join(tmpdir(), "emote-frame-warnings-"));
  const profile = join(root, "profile");
  const dir = join(root, "project", ".pi", "extensions", "gentle-emote");
  mkdirSync(join(dir, "emotes", "warny", "idle"), { recursive: true });
  mkdirSync(join(dir, "emotes", "warny", "tool"), { recursive: true });
  mkdirSync(join(dir, "emotes", "warny", "write"), { recursive: true });
  const png = encodePng({ width: 1, height: 1, data: new Uint8Array([0, 0, 0, 255]) });
  writeFileSync(join(dir, "emotes", "warny", "idle", "o k.png"), png); // unsupported identifier
  writeFileSync(join(dir, "emotes", "warny", "tool", "y o.png"), png); // unsupported identifier
  writeFileSync(join(dir, "emotes", "warny", "write", "w.png"), png); // valid frame for state changes
  writeFileSync(join(dir, "config.json"), JSON.stringify({ externalDisplay: { enabled: true, targets: [
    { enabled: true, url: "http://localhost:8000/emote" },
    { enabled: true, url: "http://matrix/emote" },
  ] } }));
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init: init! }); return new Response(); };
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  let lab: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    lab = await boot(join(root, "project"), ["internalOn", "localOn", "displayOn"], profile);
    const emote = lab.commands.get("emote");
    // Consecutive same-state tool events do not reselect frames: alternate
    // write/bash so every bash transition selects the unsupported frame again.
    const bash = async () => { await lab!.emit("tool_execution_start", { toolName: "bash" }); await flush(); };
    const cycle = async () => { await lab!.emit("tool_execution_start", { toolName: "write" }); await flush(); await bash(); };
    await lab.emit("tool_execution_start", { toolName: "write" }); await flush();
    const warnings = () => lab.notices.filter(n => n.level === "warning" && n.message.includes("externalDisplay: unsupported frame identifier"));
    await emote.handler("avatar warny", lab.ctx); await flush();
    await cycle();
    assert.equal(warnings().length, 0, "default off: the routine unsupported-frame report is silent");
    assert.ok(calls.every(call => new Headers(call.init.headers).get("X-Emote-Frame") !== "y o.png"), "an unsupported identifier is still sent on no destination");

    await emote.handler("debugOn", lab.ctx);
    assert.deepEqual(lab.notices.at(-1), { message: "[gentle-emote] unsupported-frame warnings on (session-local)", level: "info" });
    await cycle();
    const shown = warnings().map(n => n.message);
    assert.ok(shown.length > 0, "debugOn shows the routine report");
    assert.ok(shown.every(m => m.endsWith(": externalDisplay: unsupported frame identifier; skipped")), "only the routine report appears");
    assert.ok(shown.includes("[gentle-emote] destination 1: externalDisplay: unsupported frame identifier; skipped"));
    assert.ok(shown.includes("[gentle-emote] destination 2: externalDisplay: unsupported frame identifier; skipped"));

    // A sender created while the diagnostic is on observes the toggle too.
    await emote.handler("d200On", lab.ctx); await flush();
    await cycle();
    assert.ok(warnings().map(n => n.message).includes("[gentle-emote] externalDisplay: unsupported frame identifier; skipped"), "a fresh D200 sender observes the session toggle");

    // A recreated destination group keeps observing the session toggle.
    const dest1 = "[gentle-emote] destination 1: externalDisplay: unsupported frame identifier; skipped";
    const dest1Before = warnings().filter(n => n.message === dest1).length;
    await emote.handler("displayOn 10.1.2.3", lab.ctx); await flush();
    assert.ok(warnings().filter(n => n.message === dest1).length >= dest1Before + 1, "a rebuilt sender reports the routine warning again");
    await cycle();
    assert.ok(warnings().filter(n => n.message === dest1).length >= dest1Before + 2, "a rebuilt sender keeps reporting the routine warning again");

    await emote.handler("debugOff", lab.ctx);
    assert.deepEqual(lab.notices.at(-1), { message: "[gentle-emote] unsupported-frame warnings off (session-local)", level: "info" });
    const beforeOff = warnings().length;
    await cycle();
    assert.equal(warnings().length, beforeOff, "debugOff hides the routine report again");
    assert.ok(calls.every(call => new Headers(call.init.headers).get("X-Emote-Frame") !== "y o.png"));
    assert.ok(calls.some(call => new Headers(call.init.headers).get("X-Emote-Frame") === "w.png"), "valid delivery continues untouched");

    const saved = new OutputStateStore(profile).load(() => {});
    await lab.shutdown(); lab.restore(); lab = undefined;
    calls.length = 0;
    lab = await boot(join(root, "project"), ["internalOn", "localOn", "displayOn"], profile);
    await lab.emit("tool_execution_start", { toolName: "write" }); await flush();
    await lab.emit("tool_execution_start", { toolName: "bash" }); await flush();
    const restarted = lab.notices.filter(n => n.level === "warning" && n.message.includes("externalDisplay: unsupported frame identifier"));
    assert.equal(restarted.length, 0, "every session and restart starts with the diagnostic off");
    assert.deepEqual(new OutputStateStore(profile).load(() => {}), saved, "debug commands saved no output preference");
    assert.equal(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).externalDisplay.targets.length, 2, "debug commands rewrite no configuration");
  } finally {
    await lab?.shutdown(); lab?.restore(); globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});
