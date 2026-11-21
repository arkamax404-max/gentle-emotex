import { Container } from "@earendil-works/pi-tui";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useSerialSystemDeps } from "../../src/serial_display.ts";
import { installNetworkGuard } from "./network.ts";

export const PLACEHOLDER = "\u{10EEEE}";
export const SESSION_ID = "integration-session";
/** Gentle Shell's native notification channel, where subagent task transitions are published. */
export const SUBAGENT_CHANNEL = "gentle-pi:notification:source";

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

  // The usb output must never read or open this machine's real serial ports.
  useSerialSystemDeps({ list: async () => [], open: async () => { throw new Error("no serial port in tests"); } });
  // Likewise the network: a boot without a test-owned fetch mock records every
  // request in the guard instead of reaching the shipped loopback receiver.
  const network = installNetworkGuard();
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
  // ctx.ui.select() support with a recording stub: the default answer is
  // cancel (undefined), so a modal answered by mistake can never mutate state.
  const selectCalls: Array<{ title: string; options: string[] }> = [];
  const selectControl = { choice: undefined as string | undefined };
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
      select: async (title: string, options: string[]) => {
        selectCalls.push({ title, options });
        return selectControl.choice;
      },
      setWidget: (_key: string, factory: any) => { widgets.clear(); if (factory) widgets.addChild(factory(tui, {})); },
    },
  };

  const { default: extension } = await import("../../src/index.ts");
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
  return { emit, emitBus, busSent, busHandlers, widgets, editor, writes, notices, shutdown, commands, ctx, customCalls, panelDone, selectCalls, selectControl, network, restore: () => {
    network.restore();
    useSerialSystemDeps(null);
    (process.stdout as any).write = realWrite;
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    if (!profile) rmSync(agentRoot, { recursive: true, force: true });
  } };
}
