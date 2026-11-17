import { test } from "node:test";
import assert from "node:assert/strict";
import { D200_PORT, createD200Display, d200Url, parseD200Port, resolveD200Port } from "../src/d200_display.ts";
import { decodePng, encodePng } from "../src/png.ts";
import { drawDisplayText } from "../src/display_text.ts";

// A real 64x64 frame: the sender composites the PNG before POSTing it.
const framePng = encodePng({ width: 64, height: 64, data: new Uint8Array(64 * 64 * 4).fill(255) });
const image = { base64: framePng.toString("base64"), state: "think", frame: "think.png", set: "gentleman" };
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function recorder() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response();
  };
  return { calls, fetcher: fetcher as unknown as typeof fetch };
}

test("the D200 destination defaults to 127.0.0.1:8003", () => {
  assert.equal(D200_PORT, 8003);
  assert.equal(resolveD200Port({}), 8003);
  assert.equal(d200Url(), "http://127.0.0.1:8003/emote");
  assert.equal(d200Url(8123), "http://127.0.0.1:8123/emote");
});

test("the port can be overridden for tests and invalid values fall back", () => {
  assert.equal(resolveD200Port({ GENTLE_EMOTE_D200_PORT: "9000" }), 9000);
  for (const value of ["", "0", "abc", "70000", "-1"]) assert.equal(resolveD200Port({ GENTLE_EMOTE_D200_PORT: value }), 8003, value);
});

test("an explicit D200 port is a bare decimal port in 1..65535 and nothing else", () => {
  assert.deepEqual(parseD200Port("8003"), { port: 8003, error: null });
  assert.deepEqual(parseD200Port("  9100  "), { port: 9100, error: null });
  assert.deepEqual(parseD200Port("1"), { port: 1, error: null });
  assert.deepEqual(parseD200Port("65535"), { port: 65535, error: null });
  // One bounded message per cause, like `/emote displayOn <address>`.
  for (const empty of ["", "   ", "\t"]) assert.deepEqual(parseD200Port(empty), { port: null, error: "missing D200 port" }, JSON.stringify(empty));
  for (const input of ["0", "65536", "-1", "+8003", "80.5", "1e3", "0x1f90", "abc", "8003abc", "http://127.0.0.1:9000/emote", "127.0.0.1:9000", "9000/emote"]) {
    assert.deepEqual(parseD200Port(input), { port: null, error: "invalid D200 port (1-65535)" }, input);
  }
});

test("a D200 display posts protocol v1 frames to the key receiver", async () => {
  const { calls, fetcher } = recorder();
  const display = createD200Display({ fetcher });
  try {
    assert.equal(display.enabled, true);
    assert.equal(display.local, true);
    display.select(image);
    await flush();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://127.0.0.1:8003/emote");
    assert.equal(calls[0].init.method, "POST");
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers["Content-Type"], "image/png");
    assert.equal(headers["X-Emote-Version"], "1");
    assert.equal(headers["X-Emote-State"], "think");
    assert.equal(headers["X-Emote-Frame"], "think.png");
    assert.equal(headers["X-Emote-Set"], "gentleman");
    assert.ok(Buffer.isBuffer(calls[0].init.body));
  } finally {
    display.dispose();
  }
});

test("identical selections are deduplicated and a new frame is sent", async () => {
  const { calls, fetcher } = recorder();
  const display = createD200Display({ fetcher });
  try {
    display.select(image);
    display.select(image);
    await flush();
    assert.equal(calls.length, 1);
    display.select({ ...image, frame: "think_blink.png" });
    await flush();
    assert.equal(calls.length, 2);
  } finally {
    display.dispose();
  }
});

test("activity changes resend the same frame with new labels", async () => {
  const { calls, fetcher } = recorder();
  const display = createD200Display({ fetcher });
  try {
    display.select(image);
    await flush();
    display.updateActivity({ status: "busy", phase: "executing", activeSubagents: 2 });
    await flush();
    assert.equal(calls.length, 2);
    assert.equal((calls[1].init.headers as Record<string, string>)["X-Emote-Status"], "busy");
    assert.equal((calls[1].init.headers as Record<string, string>)["X-Emote-Active-Subagents"], "2");
  } finally {
    display.dispose();
  }
});

test("the D200 mirror carries the detailed work phase header", async () => {
  const { calls, fetcher } = recorder();
  const display = createD200Display({ fetcher });
  try {
    display.select(image);
    await flush();
    display.updateActivity({ status: "busy", phase: "executing", activeSubagents: 0, workPhase: "checking" });
    await flush();
    assert.equal(calls.length, 2);
    const headers = calls[1]!.init.headers as Record<string, string>;
    assert.equal(headers["X-Emote-Phase"], "executing");
    assert.equal(headers["X-Emote-Work-Phase"], "checking");
  } finally {
    display.dispose();
  }
});

test("a named D200 mirror renders the captioned layout while an unnamed one keeps legacy", async () => {
  const a = recorder(); const b = recorder();
  const named = createD200Display({ fetcher: a.fetcher, projectName: "mi repo ñ" });
  const legacy = createD200Display({ fetcher: b.fetcher });
  try {
    named.select(image); legacy.select(image);
    await flush();
    const namedImage = decodePng(Buffer.from(a.calls[0]!.init.body as Uint8Array));
    const legacyImage = decodePng(Buffer.from(b.calls[0]!.init.body as Uint8Array));
    const expected = new Uint8Array(64 * 64 * 4);
    for (let i = 3; i < expected.length; i += 4) expected[i] = 255;
    drawDisplayText(expected, "MI REPO N", 1, [128, 224, 160]);
    drawDisplayText(expected, "idle", 51, [128, 224, 160]);
    // The avatar region rides one pixel higher: caption y1..5 plus gap y6..8 stay blank,
    // and the full-height sprite itself occupies rows 9..48 (row 9 artwork, row 49 empty).
    assert.deepEqual(namedImage.data.slice(0, 9 * 64 * 4), expected.slice(0, 9 * 64 * 4), "the caption rides above the avatar with a clear caption gap");
    assert.ok(
      namedImage.data.slice(9 * 64 * 4, 10 * 64 * 4).some((value, index) => index % 4 !== 3 && value > 0),
      "the raised full-height sprite starts with artwork at row 9",
    );
    for (let x = 0; x < 64; x++) {
      assert.deepEqual([...namedImage.data.slice((49 * 64 + x) * 4, (49 * 64 + x) * 4 + 4)], [0, 0, 0, 255], `row 49 stays empty x=${x}`);
    }
    assert.deepEqual(namedImage.data.slice(51 * 64 * 4, 56 * 64 * 4), expected.slice(51 * 64 * 4, 56 * 64 * 4), "the status row compacts to 51");
    // Legacy geometry: the sprite rides at y0..39, so the named layout's caption
    // gap rows y6..8 carry sprite pixels in the unnamed mirror instead.
    assert.ok(
      legacyImage.data.slice(6 * 64 * 4, 9 * 64 * 4).some((value, index) => index % 4 !== 3 && value > 0),
      "the unnamed mirror keeps the legacy sprite rows",
    );
    assert.equal((a.calls[0]!.init.headers as Record<string, string>)["X-Emote-Project-Name"], encodeURIComponent("mi repo ñ"), "the loopback key receiver still gets the metadata header");
  } finally {
    named.dispose(); legacy.dispose();
  }
});

test("disposing the D200 display stops delivery", async () => {
  const { calls, fetcher } = recorder();
  const display = createD200Display({ fetcher });
  display.select(image);
  await flush();
  display.dispose();
  display.select({ ...image, frame: "read.png" });
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(display.enabled, false);
});
