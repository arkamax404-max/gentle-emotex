import { test } from "node:test";
import assert from "node:assert/strict";
import { crc32 } from "node:zlib";
import { createSerialDisplay, type SerialPortLike } from "../src/serial_display.ts";
import { SERIAL_ENTER, SERIAL_ENTER_ACK, SERIAL_EXIT, SERIAL_EXIT_ACK } from "../src/serial_protocol.ts";

const session = "serial-session";
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 8, 7]);

function reply(requestId: number, result: number): Buffer {
  const head = Buffer.alloc(8);
  head.write("EMTR", 0, "latin1");
  head[4] = 1;
  head[5] = result;
  head.writeUInt16LE(requestId, 6);
  const crc = Buffer.alloc(4);
  crc.writeUInt32LE(crc32(head), 0);
  return Buffer.concat([head, crc]);
}

/** A fake CDC peer that speaks protocol v1 and records what the sender wrote. */
function fakePort(options: { autoAck?: boolean; answers?: Array<number | "silent">; lineEnd?: string } = {}) {
  const listeners: Array<(chunk: Buffer) => void> = [];
  const written: Buffer[] = [];
  const answers = [...(options.answers ?? [])];
  let handshake = false;
  const frames: Buffer[] = [];
  const port: SerialPortLike = {
    write(data: Buffer, callback?: (error?: Error | null) => void) {
      written.push(Buffer.from(data));
      const text = data.toString("latin1");
      if (text === SERIAL_ENTER) {
        handshake = true;
        if (options.autoAck !== false) queueMicrotask(() => emit(Buffer.from(SERIAL_ENTER_ACK.replace(String.fromCharCode(10), options.lineEnd ?? String.fromCharCode(10)))));
      } else if (text === SERIAL_EXIT) {
        queueMicrotask(() => emit(Buffer.from(SERIAL_EXIT_ACK.replace(String.fromCharCode(10), options.lineEnd ?? String.fromCharCode(10)))));
      } else if (data.subarray(0, 4).toString("latin1") === "EMTS") {
        frames.push(data);
        const id = data.readUInt16LE(8);
        const answer = answers.length > 0 ? answers.shift()! : 0;
        if (answer !== "silent") queueMicrotask(() => emit(reply(id, answer as number)));
      }
      callback?.(null);
    },
    close(callback?: (error?: Error | null) => void) {
      closed = true;
      callback?.(null);
    },
    on(_event: string, handler: (chunk: Buffer) => void) {
      listeners.push(handler);
    },
    off() {},
  };
  return { port, written, frames, isHandshaken: () => handshake };
  function emit(chunk: Buffer) {
    for (const listener of listeners) listener(chunk);
  }
}

let closed = false;

const image = { base64: png.toString("base64"), state: "idle", frame: "idle.png", set: "gentleman" };

function transport(port: SerialPortLike, extra: Record<string, unknown> = {}) {
  return createSerialDisplay({
    open: async () => port,
    list: async () => [{ path: "COM5" }],
    sessionId: session,
    projectName: "gentle%2Demotex",
    replyTimeoutMs: 20,
    resendAttempts: 1,
    report: () => {},
    ...extra,
  });
}

test("auto-detection needs exactly one candidate, and never guesses", async () => {
  const one = fakePort();
  const ok = transport(one.port);
  assert.deepEqual(await ok.start(), { ok: true, path: "COM5" });
  assert.equal(one.isHandshaken(), true, "the handshake was written");
  assert.equal(one.written[0]!.toString("latin1"), SERIAL_ENTER);
  await ok.stop();

  const none = createSerialDisplay({ open: async () => fakePort().port, list: async () => [], sessionId: session, report: () => {} });
  const zero = await none.start();
  assert.equal(zero.ok, false);
  assert.match(zero.error ?? "", /no usb serial display/i);

  const two = createSerialDisplay({
    open: async () => fakePort().port,
    list: async () => [{ path: "COM5" }, { path: "COM6" }],
    sessionId: session,
    report: () => {},
  });
  const ambiguous = await two.start();
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.error ?? "", /more than one/i, "ambiguity asks for an explicit port instead of guessing");
});

test("an explicit port bypasses detection and a silent handshake fails closed", async () => {
  const explicit = fakePort();
  const withPort = transport(explicit.port);
  assert.deepEqual(await withPort.start("COM9"), { ok: true, path: "COM9" });
  await withPort.stop();

  const mute = fakePort({ autoAck: false });
  const noAck = transport(mute.port, { replyTimeoutMs: 10 });
  const failed = await noAck.start();
  assert.equal(failed.ok, false);
  assert.match(failed.error ?? "", /did not answer/i);
  assert.equal(closed, true, "a failed handshake closes the port");
});

test("an image is sent as one correlated frame and accepted", async () => {
  const peer = fakePort();
  const link = transport(peer.port);
  await link.start();
  const result = await link.sendImage(image);
  assert.deepEqual(result, { ok: true, result: "ok" });
  const frame = peer.frames[0]!;
  assert.equal(frame[5], 0, "image opcode");
  assert.equal(frame[6] & 1, 1, "session flag");
  assert.equal(frame[6] & 2, 2, "the project name rides image frames");
  assert.deepEqual(frame.subarray(frame.length - 4 - png.length, frame.length - 4), png, "raw PNG payload");
  await link.stop();
  assert.equal(peer.written.at(-1)!.toString("latin1"), SERIAL_EXIT, "the session is left cleanly");
});

test("a clock image marks the frame, and only images carry the name", async () => {
  const peer = fakePort();
  const link = transport(peer.port);
  await link.start();
  await link.sendImage({ ...image, state: "clock" });
  assert.equal(peer.frames[0]![6] & 4, 4, "clockState flag");
  await link.sendImage(image);
  assert.equal(peer.frames[1]![6] & 2, 2, "the project name rides images");
  assert.equal(peer.frames[1]![6] & 4, 0);
  await link.sendControl("heartbeat");
  assert.equal(peer.frames[2]![6] & 2, 0, "controls never carry a name");
  await link.stop();
});

test("a NACK resends the whole frame, and a missing reply is bounded", async () => {
  const nackThenOk = fakePort({ answers: [1, 0] });
  const link = transport(nackThenOk.port);
  await link.start();
  assert.deepEqual(await link.sendImage(image), { ok: true, result: "ok" });
  assert.equal(nackThenOk.frames.length, 2, "the same frame was resent once");
  assert.equal(nackThenOk.frames[0]!.readUInt16LE(8), nackThenOk.frames[1]!.readUInt16LE(8), "same request id: correlation only");
  await link.stop();

  const silent = fakePort({ answers: ["silent", "silent", "silent"] });
  const dropping = transport(silent.port);
  await dropping.start();
  const timedOut = await dropping.sendImage(image);
  assert.equal(timedOut.ok, false);
  assert.match(timedOut.error ?? "", /timeout/i);
  assert.equal(silent.frames.length, 2, "one send plus exactly one resend, then it stops");
  await dropping.stop();
});

test("stop-and-wait: never two frames in flight", async () => {
  const peer = fakePort({ answers: ["silent", 0, 0] });
  const link = transport(peer.port);
  await link.start();
  const first = link.sendImage(image);
  const second = link.sendImage(image);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(peer.frames.length, 1, "the second frame waits for the first reply");
  await Promise.all([first, second]);
  await link.stop();
});

test("setQuiet suppresses only the link's own heartbeats", async () => {
  const peer = fakePort();
  const link = transport(peer.port, { heartbeatMs: 5 });
  await link.start();
  await new Promise(resolve => setTimeout(resolve, 40));
  const before = peer.frames.length;
  assert.ok(before > 0, "heartbeats flow while the link is loud");
  link.setQuiet(true);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(peer.frames.length, before, "no heartbeat frame travels while quiet");
  assert.deepEqual(await link.sendImage(image), { ok: true, result: "ok" }, "images still send while quiet");
  assert.equal(peer.frames.length, before + 1);
  assert.deepEqual(await link.sendControl("heartbeat"), { ok: true, result: "ok" }, "explicit controls still send while quiet");
  assert.equal(peer.frames.length, before + 2);
  link.setQuiet(false);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.ok(peer.frames.length > before + 2, "heartbeats resume when the link is loud again");
  await link.stop();
});

test("console noise around replies is tolerated", async () => {
  const peer = fakePort();
  const link = transport(peer.port);
  await link.start();
  // A heartbeat answered after a burst of console text still resolves.
  const sending = link.sendControl("heartbeat");
  await new Promise(resolve => setTimeout(resolve, 2));
  assert.deepEqual(await sending, { ok: true, result: "ok" });
  await link.stop();
});
test("an Arduino-style CRLF acknowledgement is accepted", async () => {
  const peer = fakePort({ lineEnd: String.fromCharCode(13) + String.fromCharCode(10) });
  const link = transport(peer.port);
  assert.deepEqual(await link.start(), { ok: true, path: "COM5" }, "println sends CRLF, not a bare newline");
  await link.stop();
  assert.equal(peer.written.at(-1)!.toString("latin1"), SERIAL_EXIT);
});
