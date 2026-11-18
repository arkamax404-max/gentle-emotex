import { crc32 } from "node:zlib";

/**
 * Wire protocol v1 for the LED panel's USB serial ingress
 * (`docs/serial-transport.md` in the firmware repository). This module is pure:
 * it builds frames and parses replies, and never touches a port. Everything here
 * is little-endian and uses the reflected CRC-32 polynomial 0xEDB88320, which is
 * exactly `zlib.crc32`.
 */

export const SERIAL_ENTER = "EMOTE\n";
export const SERIAL_ENTER_ACK = "EMOTE_READY\n";
export const SERIAL_EXIT = "EMTE\n";
export const SERIAL_EXIT_ACK = "EMOTE_EXIT\n";
export const SERIAL_MAGIC = "EMTS";
export const SERIAL_REPLY_MAGIC = "EMTR";
export const SERIAL_PROTOCOL_VERSION = 1;
/** The firmware runs its console and ingress at 115200 8N1. */
export const SERIAL_BAUD_RATE = 115_200;

export const MAX_PNG_BYTES = 32_768;
export const MAX_NAME_BYTES = 1_152;
export const MAX_SESSION_BYTES = 128;
export const MAX_REQUEST_ID = 0xffff;

export const SERIAL_HEADER_BYTES = 18;
export const SERIAL_CRC_BYTES = 4;
export const SERIAL_REPLY_BYTES = 12;

const OP_CODES = { image: 0, claim: 1, heartbeat: 2, release: 3 } as const;
export type SerialOp = keyof typeof OP_CODES;

const RESULTS = ["ok", "crc", "version", "op", "flags", "reserved", "length", "oversize", "session", "name", "png", "busy"] as const;

/** The firmware's result code as the documented name, or `unknown`. */
export function serialResultName(code: number): string {
  return RESULTS[code] ?? "unknown";
}

/** The HTTP session-id rule, reused byte for byte on the wire. */
const SESSION_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export interface SerialFrameRequest {
  op: SerialOp;
  /** Sender-chosen correlation id, echoed in the reply; correlation only. */
  requestId: number;
  sessionId?: string;
  /** Percent-encoded project name. Images only, exactly like the HTTP header. */
  name?: string;
  /** Parity with `X-Emote-State: clock`. Never rejected by the firmware. */
  clockState?: boolean;
  /** Raw PNG bytes; images only. */
  payload?: Buffer;
}

/**
 * Builds one frame exactly as the firmware's parser expects it. Every refusal
 * here mirrors a rejection the firmware would answer with a NACK, so a frame
 * this function returns is always structurally acceptable.
 */
export function buildSerialFrame(request: SerialFrameRequest): Buffer {
  const opCode = OP_CODES[request.op];
  if (opCode === undefined) throw new Error(`invalid serial op: ${String(request.op)}`);

  const { requestId, sessionId, name, clockState } = request;
  if (!Number.isInteger(requestId) || requestId < 0 || requestId > MAX_REQUEST_ID) {
    throw new Error(`invalid serial requestId: ${String(requestId)}`);
  }
  if (sessionId !== undefined && Buffer.byteLength(sessionId, "utf8") > MAX_SESSION_BYTES) {
    throw new Error("invalid serial length: session id above 128 bytes");
  }
  if (sessionId !== undefined && !SESSION_PATTERN.test(sessionId)) {
    throw new Error(`invalid serial session: ${sessionId}`);
  }
  if (request.op !== "image" && name !== undefined) {
    throw new Error("invalid serial name: names belong to images only");
  }
  const nameBytes = name === undefined ? null : Buffer.from(name, "utf8");
  if (nameBytes && (nameBytes.length === 0 || nameBytes.length > MAX_NAME_BYTES)) {
    throw new Error("invalid serial length: name outside 1..1152 bytes");
  }
  if (clockState !== undefined && typeof clockState !== "boolean") {
    throw new Error(`invalid serial clockState: ${String(clockState)}`);
  }
  if (request.op !== "image" && sessionId === undefined) {
    throw new Error("invalid serial session: a control requires identity");
  }
  if (request.op !== "image" && request.payload !== undefined) {
    throw new Error("invalid serial length: controls carry no payload");
  }

  let payload: Buffer | null = null;
  if (request.op === "image") {
    payload = request.payload ?? null;
    if (!payload || payload.length === 0) throw new Error("invalid serial length: an image needs a payload");
    if (payload.length > MAX_PNG_BYTES) throw new Error(`invalid serial oversize: ${payload.length} bytes above 32768`);
  }

  const flags = (sessionId === undefined ? 0 : 1) | (nameBytes === null ? 0 : 2) | (clockState === true ? 4 : 0);
  const header = Buffer.alloc(SERIAL_HEADER_BYTES);
  header.write(SERIAL_MAGIC, 0, "latin1");
  header[4] = SERIAL_PROTOCOL_VERSION;
  header[5] = opCode;
  header[6] = flags;
  header[7] = 0;
  header.writeUInt16LE(requestId, 8);
  header.writeUInt16LE(sessionId === undefined ? 0 : Buffer.byteLength(sessionId, "utf8"), 10);
  header.writeUInt16LE(nameBytes === null ? 0 : nameBytes.length, 12);
  header.writeUInt32LE(payload === null ? 0 : payload.length, 14);

  const body = [header, sessionId === undefined ? null : Buffer.from(sessionId, "utf8"), nameBytes, payload].filter(
    (part): part is Buffer => part !== null,
  );
  const covered = Buffer.concat(body);
  const crc = Buffer.alloc(SERIAL_CRC_BYTES);
  crc.writeUInt32LE(crc32(covered), 0);
  return Buffer.concat([covered, crc]);
}

export interface SerialReply {
  requestId: number;
  result: number;
  resultName: string;
}

/**
 * Scans a chunk for `EMTR` replies. Console log lines may interleave between
 * replies, so this never reads line-wise: it looks for the magic, validates the
 * CRC and hands back the bytes it did not consume, which the caller keeps for the
 * next chunk. A corrupt or foreign `EMTR` is skipped, never surfaced as a verdict.
 */
export function parseSerialReplies(buffer: Buffer): { replies: SerialReply[]; rest: Buffer } {
  const replies: SerialReply[] = [];
  let offset = 0;
  for (;;) {
    const start = buffer.indexOf(SERIAL_REPLY_MAGIC, offset, "latin1");
    if (start < 0) break;
    if (buffer.length - start < SERIAL_REPLY_BYTES) break;
    const head = buffer.subarray(start, start + 8);
    if (head[4] !== SERIAL_PROTOCOL_VERSION || crc32(head) !== buffer.readUInt32LE(start + 8)) {
      offset = start + SERIAL_REPLY_MAGIC.length;
      continue;
    }
    const result = head[5]!;
    replies.push({ requestId: head.readUInt16LE(6), result, resultName: serialResultName(result) });
    offset = start + SERIAL_REPLY_BYTES;
  }
  return { replies, rest: buffer.subarray(offset) };
}
const PORT_PATTERNS = [
  /^COM[1-9][0-9]?$/i,
  /^\/dev\/tty(ACM|USB)[0-9]+$/,
  /^\/dev\/cu\.(usbmodem|usbserial)[0-9]+$/,
];

/**
 * Validates an explicit port name. A path, a URL or anything else is refused
 * instead of being handed to the OS, so `/emote usbOn` can never open something
 * that is not a serial device. Returns an error message, or null when valid.
 */
export function parseSerialPortPath(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return "missing serial port";
  if (PORT_PATTERNS.some(pattern => pattern.test(trimmed))) return null;
  return "invalid serial port";
}
