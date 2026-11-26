import { test } from "node:test";
import assert from "node:assert/strict";
import { crc32 } from "node:zlib";
import {
  MAX_NAME_BYTES,
  MAX_PNG_BYTES,
  SERIAL_ENTER,
  SERIAL_ENTER_ACK,
  SERIAL_EXIT,
  SERIAL_EXIT_ACK,
  SERIAL_PROTOCOL_VERSION,
  buildSerialFrame,
  parseSerialPortPath,
  parseSerialReplies,
  serialResultName,
} from "../src/serial_protocol.ts";

const session = "integration-session";
const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

test("the session handshake strings are exactly the firmware's", () => {
  assert.equal(SERIAL_ENTER, "EMOTE\n");
  assert.equal(SERIAL_ENTER_ACK, "EMOTE_READY\n");
  assert.equal(SERIAL_EXIT, "EMTE\n");
  assert.equal(SERIAL_EXIT_ACK, "EMOTE_EXIT\n");
  assert.equal(SERIAL_PROTOCOL_VERSION, 1);
});

test("an image frame matches the documented layout byte for byte", () => {
  const frame = buildSerialFrame({ op: "image", requestId: 0x1234, sessionId: session, name: "gentle%2Demotex", clockState: true, payload: image });
  assert.equal(frame.subarray(0, 4).toString("latin1"), "EMTS", "magic");
  assert.equal(frame[4], 1, "version");
  assert.equal(frame[5], 0, "op image is 0");
  assert.equal(frame[6], 0b111, "hasSession, hasName and clockState");
  assert.equal(frame[7], 0, "reserved");
  assert.equal(frame.readUInt16LE(8), 0x1234, "requestId little-endian");
  assert.equal(frame.readUInt16LE(10), session.length, "sessionIdLen");
  assert.equal(frame.readUInt16LE(12), "gentle%2Demotex".length, "nameLen");
  assert.equal(frame.readUInt32LE(14), image.length, "payloadLen");
  const body = frame.subarray(18, frame.length - 4);
  assert.equal(body.subarray(0, session.length).toString("latin1"), session);
  assert.equal(body.subarray(session.length, session.length + "gentle%2Demotex".length).toString("latin1"), "gentle%2Demotex");
  assert.deepEqual(body.subarray(body.length - image.length), image, "raw PNG payload, never base64");
  assert.equal(frame.readUInt32LE(frame.length - 4), crc32(frame.subarray(0, frame.length - 4)), "CRC-32 over magic..payload");
});

test("clock activation carries only session identity and four little-endian UTC bytes", () => {
  for (const utcSeconds of [1577836800, 2147483647]) {
    const frame = buildSerialFrame({ op: "clock", requestId: 0x1234, sessionId: session, utcSeconds });
    assert.equal(frame.subarray(0, 8).toString("hex"), "454d545301040100");
    assert.equal(frame.readUInt16LE(8), 0x1234);
    assert.equal(frame.readUInt16LE(10), session.length);
    assert.equal(frame.readUInt16LE(12), 0);
    assert.equal(frame.readUInt32LE(14), 4);
    assert.equal(frame.subarray(18, 18 + session.length).toString("latin1"), session);
    assert.equal(frame.readUInt32LE(18 + session.length), utcSeconds);
    assert.equal(frame.length, 18 + session.length + 4 + 4);
    assert.equal(frame.readUInt32LE(frame.length - 4), crc32(frame.subarray(0, -4)));
  }
});

test("clock activation rejects invalid time, identity, name and flags", () => {
  const clock = { op: "clock", requestId: 7, sessionId: session, utcSeconds: 1700000000 } as const;
  for (const utcSeconds of [undefined, 1577836799, 2147483648, 1700000000.5, NaN]) {
    assert.throws(() => buildSerialFrame({ ...clock, utcSeconds }), /serial time/);
  }
  assert.throws(() => buildSerialFrame({ ...clock, sessionId: undefined }), /session/);
  assert.throws(() => buildSerialFrame({ ...clock, sessionId: "bad session" }), /session/);
  assert.throws(() => buildSerialFrame({ ...clock, name: "panel" }), /name/);
  assert.throws(() => buildSerialFrame({ ...clock, clockState: true }), /flags/);
  assert.throws(() => buildSerialFrame({ ...clock, payload: image }), /length/);
});

test("control frames carry no payload and require session identity", () => {
  for (const [op, code] of [["claim", 1], ["heartbeat", 2], ["release", 3]] as const) {
    const frame = buildSerialFrame({ op, requestId: 7, sessionId: session });
    assert.equal(frame[5], code, `${op} opcode`);
    assert.equal(frame[6], 0b001, "session only, no name and no clock state");
    assert.equal(frame.readUInt32LE(14), 0, "controls carry no payload");
    assert.equal(frame.length, 18 + session.length + 4, "header, session and CRC only");
  }
  assert.throws(() => buildSerialFrame({ op: "claim", requestId: 1 }), /session/, "a control without identity is refused");
});

test("the builder refuses what the firmware would reject", () => {
  assert.throws(() => buildSerialFrame({ op: "image", requestId: 1, sessionId: session, payload: Buffer.alloc(MAX_PNG_BYTES + 1) }), /oversize/);
  assert.throws(() => buildSerialFrame({ op: "image", requestId: 2, sessionId: session }), /length/);
  assert.throws(() => buildSerialFrame({ op: "image", requestId: 3, sessionId: "x".repeat(129), payload: image }), /length/);
  assert.throws(() => buildSerialFrame({ op: "image", requestId: 4, sessionId: session, name: "n".repeat(MAX_NAME_BYTES + 1), payload: image }), /length/);
  assert.throws(() => buildSerialFrame({ op: "image", requestId: 5, sessionId: session, name: "panel", payload: image, clockState: "yes" as never }), /clockState/);
  assert.throws(() => buildSerialFrame({ op: "image", requestId: 6, sessionId: "bad session", payload: image }), /session/);
  assert.throws(() => buildSerialFrame({ op: "poll" as never, requestId: 7, sessionId: session }), /op/);
  assert.throws(() => buildSerialFrame({ op: "image", requestId: 0x10000, sessionId: session, payload: image }), /requestId/);
  assert.throws(() => buildSerialFrame({ op: "claim", requestId: 8, sessionId: session, name: "panel" }), /name/, "names belong to images only");
});

test("replies are found by scanning, because console lines interleave", () => {
  const reply = (requestId: number, result: number) => {
    const head = Buffer.alloc(8);
    head.write("EMTR", 0, "latin1");
    head[4] = 1;
    head[5] = result;
    head.writeUInt16LE(requestId, 6);
    const crc = Buffer.alloc(4);
    crc.writeUInt32LE(crc32(head), 0);
    return Buffer.concat([head, crc]);
  };
  const noisy = Buffer.concat([
    Buffer.from("Receiver ready: http://192.168.1.129/emote\nORIENT: rotation 90 degrees\n"),
    reply(0x1234, 0),
    Buffer.from("trailing console text"),
  ]);
  const parsed = parseSerialReplies(noisy);
  assert.equal(parsed.replies.length, 1, "only the framed reply is taken");
  assert.deepEqual(parsed.replies[0], { requestId: 0x1234, result: 0, resultName: "ok" });
  assert.match(parsed.rest.toString("latin1"), /trailing console text/, "console bytes after the reply are kept, not eaten");

  const two = parseSerialReplies(Buffer.concat([reply(1, 0), reply(2, 10)]));
  assert.deepEqual(two.replies.map(r => [r.requestId, r.resultName]), [[1, "ok"], [2, "png"]]);

  const incomplete = parseSerialReplies(reply(3, 0).subarray(0, 9));
  assert.deepEqual(incomplete.replies, [], "a partial reply is not invented");
  assert.equal(incomplete.rest.length, 9, "and its bytes are preserved for the next chunk");

  const corrupt = reply(4, 0);
  corrupt[5] = 1;
  assert.deepEqual(parseSerialReplies(corrupt).replies, [], "a bad CRC never surfaces as a verdict");
});

test("result codes map to the documented names", () => {
  const names = ["ok", "crc", "version", "op", "flags", "reserved", "length", "oversize", "session", "name", "png", "busy", "time"];
  names.forEach((name, code) => assert.equal(serialResultName(code), name));
  assert.equal(serialResultName(99), "unknown");
});
test("an explicit port must look like a serial device", () => {
  for (const valid of ["COM5", "com12", "/dev/ttyACM0", "/dev/ttyUSB3", "/dev/cu.usbmodem1101"]) {
    assert.equal(parseSerialPortPath(valid), null, valid);
  }
  for (const invalid of ["", "   ", "ttyACM0", "/dev/sda1", "COM0", "COM", "C:\COM5", "http://host/COM5", "COM5/extra", "../COM5"]) {
    assert.notEqual(parseSerialPortPath(invalid), null, JSON.stringify(invalid));
  }
});
