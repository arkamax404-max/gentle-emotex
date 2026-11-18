import {
  SERIAL_BAUD_RATE,
  SERIAL_ENTER_ACK,
  SERIAL_EXIT,
  SERIAL_EXIT_ACK,
  buildSerialFrame,
  parseSerialReplies,
  type SerialOp,
} from "./serial_protocol.ts";

/**
 * USB CDC transport for the LED panel, protocol v1. It owns one port (the owner
 * confirmed a single USB display at most), speaks stop-and-wait, and never
 * streams ahead of a reply: the firmware's parser discards a frame that stops
 * mid-way, so a sender that pipelines would corrupt every frame after the first.
 *
 * `serialport` is an optional dependency: it is imported only when a caller
 * actually starts the link, so a machine without it keeps every other output.
 */

export interface SerialPortLike {
  write(data: Buffer, callback?: (error?: Error | null) => void): void;
  close(callback?: (error?: Error | null) => void): void;
  on(event: "data", handler: (chunk: Buffer) => void): void;
  off?(event: "data", handler: (chunk: Buffer) => void): void;
}

export interface SerialPortInfo {
  path: string;
}

export interface SerialDisplayDeps {
  /** Injected port opener; the real one loads `serialport` lazily. */
  open: (path: string, baudRate: number) => Promise<SerialPortLike>;
  /** Injected port lister, used only when no explicit port is given. */
  list: () => Promise<SerialPortInfo[]>;
  sessionId: string | null;
  /** Percent-encoded project name; rides image frames only. */
  projectName?: string | null;
  report?: (message: string) => void;
  replyTimeoutMs?: number;
  resendAttempts?: number;
  heartbeatMs?: number;
}

export interface SerialImage {
  base64: string;
  state: string;
}

export type SerialSendResult = { ok: true; result: string } | { ok: false; result?: string; error: string };
export type SerialStartResult = { ok: true; path: string } | { ok: false; error: string };

export const SERIAL_REPLY_TIMEOUT_MS = 2_000;
export const SERIAL_RESEND_ATTEMPTS = 1;
export const SERIAL_HEARTBEAT_MS = 5_000;

export interface SerialDisplay {
  start(path?: string): Promise<SerialStartResult>;
  sendImage(image: SerialImage): Promise<SerialSendResult>;
  sendControl(op: Exclude<SerialOp, "image">): Promise<SerialSendResult>;
  stop(): Promise<void>;
  readonly path: string | null;
}

type Waiter = { requestId: number; settle: (outcome: { ok: true } | { result: number }) => void };

export function createSerialDisplay(deps: SerialDisplayDeps): SerialDisplay {
  const replyTimeoutMs = deps.replyTimeoutMs ?? SERIAL_REPLY_TIMEOUT_MS;
  const resendAttempts = deps.resendAttempts ?? SERIAL_RESEND_ATTEMPTS;
  const heartbeatMs = deps.heartbeatMs ?? SERIAL_HEARTBEAT_MS;
  let port: SerialPortLike | null = null;
  let openPath: string | null = null;
  let buffer: Buffer = Buffer.alloc(0);
  let waiter: Waiter | null = null;
  let requestId = 0;
  let chain: Promise<unknown> = Promise.resolve();
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let stopping = false;

  const onData = (chunk: Buffer): void => {
    buffer = Buffer.concat([buffer, chunk]);
    const parsed = parseSerialReplies(buffer);
    buffer = parsed.rest;
    for (const reply of parsed.replies) {
      const current = waiter;
      if (!current || current.requestId !== reply.requestId) continue;
      waiter = null;
      current.settle(reply.result === 0 ? { ok: true } : { result: reply.result });
    }
  };

  function write(chunk: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!port) { reject(new Error("serial port is not open")); return; }
      port.write(chunk, error => (error ? reject(error) : resolve()));
    });
  }

  /** One frame in flight: the reply (or the timeout) settles this exchange. */
  function exchange(frame: Buffer, id: number): Promise<{ ok: true } | { result: number } | { timeout: true }> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        waiter = null;
        resolve({ timeout: true });
      }, replyTimeoutMs);
      timer.unref?.();
      waiter = {
        requestId: id,
        settle: outcome => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(outcome);
        },
      };
      write(frame).catch(error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        waiter = null;
        reject(error);
      });
    });
  }

  async function transmit(build: (id: number) => Buffer): Promise<SerialSendResult> {
    if (!port) return { ok: false, error: "serial port is not open" };
    const id = (requestId = (requestId + 1) & 0xffff);
    const frame = build(id);
    let sawNack: number | null = null;
    for (let attempt = 0; attempt <= resendAttempts; attempt++) {
      const outcome = await exchange(frame, id);
      if ("ok" in outcome) return { ok: true, result: "ok" };
      if ("result" in outcome) sawNack = outcome.result;
    }
    return sawNack === null
      ? { ok: false, error: "timeout: the display did not answer" }
      : { ok: false, result: String(sawNack), error: `rejected by the display: result ${sawNack}` };
  }

  /** Serializes sends so a second frame can never overtake the one in flight. */
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = chain.then(task, task);
    chain = next.then(() => undefined, () => undefined);
    return next;
  }

  /**
   * Consumes one acknowledgement line. The firmware answers with Arduino's
   * `println`, which ends in CRLF, while the transport document writes `
`: the
   * token is matched without its ending and the rest of the line is consumed when
   * present, so both endings (and console noise after them) are accepted.
   */
  function consumeAckLine(token: string): boolean {
    const at = buffer.indexOf(token, 0, "latin1");
    if (at < 0) return false;
    const newline = buffer.indexOf(String.fromCharCode(10), at + token.length);
    buffer = newline < 0 ? buffer.subarray(at + token.length) : buffer.subarray(newline + 1);
    return true;
  }

  async function waitForHandshake(): Promise<boolean> {
    const deadline = Date.now() + replyTimeoutMs;
    while (Date.now() < deadline) {
      if (consumeAckLine(SERIAL_ENTER_ACK.replace(String.fromCharCode(10), ""))) return true;
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    return false;
  }

  return {
    get path() { return openPath; },

    async start(path?: string): Promise<SerialStartResult> {
      if (port) return openPath ? { ok: true, path: openPath } : { ok: false, error: "serial port is not open" };
      if (deps.sessionId === null) return { ok: false, error: "no session identity; the display requires one" };
      let target = path;
      if (target === undefined) {
        let candidates: SerialPortInfo[] = [];
        try { candidates = await deps.list(); } catch { candidates = []; }
        if (candidates.length === 0) return { ok: false, error: "no usb serial display found" };
        if (candidates.length > 1) {
          return { ok: false, error: `more than one serial port is visible (${candidates.length}); name the display port explicitly` };
        }
        target = candidates[0]!.path;
      }
      try {
        port = await deps.open(target, SERIAL_BAUD_RATE);
      } catch {
        port = null;
        return { ok: false, error: `cannot open ${target}` };
      }
      openPath = target;
      port.on("data", onData);
      buffer = Buffer.alloc(0);
      try {
        await write(Buffer.from("EMOTE\n", "latin1"));
      } catch {
        await closeQuietly();
        return { ok: false, error: `cannot open ${target}` };
      }
      if (!(await waitForHandshake())) {
        await closeQuietly();
        return { ok: false, error: `${target} did not answer the serial handshake` };
      }
      heartbeat = setInterval(() => {
        if (!port || waiter || stopping) return;
        void enqueue(() => transmit(id => buildSerialFrame({ op: "heartbeat", requestId: id, sessionId: deps.sessionId! })));
      }, heartbeatMs);
      heartbeat.unref?.();
      return { ok: true, path: target };
    },

    sendImage(image: SerialImage): Promise<SerialSendResult> {
      return enqueue(() => transmit(id => buildSerialFrame({
        op: "image",
        requestId: id,
        sessionId: deps.sessionId ?? undefined,
        ...(deps.projectName ? { name: deps.projectName } : {}),
        ...(image.state === "clock" ? { clockState: true } : {}),
        payload: Buffer.from(image.base64, "base64"),
      })));
    },

    sendControl(op: Exclude<SerialOp, "image">): Promise<SerialSendResult> {
      return enqueue(() => transmit(id => buildSerialFrame({ op, requestId: id, sessionId: deps.sessionId ?? undefined })));
    },

    async stop(): Promise<void> {
      stopping = true;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      if (port) {
        try { await write(Buffer.from(SERIAL_EXIT, "latin1")); } catch { /* the exit is best effort */ }
        await waitForExitAck();
      }
      await closeQuietly();
    },
  };

  async function waitForExitAck(): Promise<void> {
    const deadline = Date.now() + Math.min(replyTimeoutMs, 200);
    while (Date.now() < deadline) {
      if (consumeAckLine(SERIAL_EXIT_ACK.replace(String.fromCharCode(10), ""))) return;
      await new Promise(resolve => setTimeout(resolve, 2));
    }
  }

  async function closeQuietly(): Promise<void> {
    const current = port;
    port = null;
    openPath = null;
    waiter = null;
    buffer = Buffer.alloc(0);
    if (!current) return;
    try { current.off?.("data", onData); } catch { /* optional API */ }
    try { current.close(() => undefined); } catch { /* already closed */ }
  }
}

/**
 * The real opener: `serialport` is optional and imported only here, so this
 * package installs and runs everywhere without a native module.
 */
export async function openSystemSerialPort(path: string, baudRate: number): Promise<SerialPortLike> {
  let SerialPortCtor: new (options: { path: string; baudRate: number }) => SerialPortLike;
  try {
    const module = await import("serialport" as string);
    SerialPortCtor = (module as { SerialPort: new (options: { path: string; baudRate: number }) => SerialPortLike }).SerialPort;
  } catch {
    throw new Error("the optional serialport package is not installed");
  }
  return new Promise((resolve, reject) => {
    const created = new SerialPortCtor({ path, baudRate }) as SerialPortLike & {
      once?: (event: string, handler: (value?: unknown) => void) => void;
    };
    // The port is only usable after its own open event; writing earlier is lost.
    if (created.once) {
      created.once("open", () => resolve(created));
      created.once("error", error => reject(error instanceof Error ? error : new Error(String(error))));
      return;
    }
    resolve(created);
  });
}

/** Lists candidate CDC ports, or nothing when the optional package is absent. */
export async function listSystemSerialPorts(): Promise<SerialPortInfo[]> {
  try {
    const module = await import("serialport" as string);
    const list = (module as { SerialPort: { list: () => Promise<SerialPortInfo[]> } }).SerialPort.list;
    return await list();
  } catch {
    return [];
  }
}

export { SERIAL_BAUD_RATE } from "./serial_protocol.ts";
export type { SerialOp } from "./serial_protocol.ts";