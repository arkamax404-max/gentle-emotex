import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodePng } from "../src/png.ts";
import { prepareIdleClockImage } from "../src/idle_clock_image.ts";

// Canonical native Lemmings walk sprite, extracted 1:1 from the authoritative
// reference sheet (12x magnified 576x576 preview -> native 48x48, 3x3 poses in
// 16x16 cells). The fixture is the independent source-derived reference; these
// tests assert the renderer reproduces it exactly, without any resizing.
const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/lemmings-walk.json", import.meta.url), "utf8")) as {
  palette: Record<string, number[]>;
  nativeSheet: { cell: number };
  feetRowInCell: number;
  frames: { x: number; y: number; rows: string[] }[];
};
const PALETTE: Record<string, number[]> = FIXTURE.palette;
const CHAR_INKS: number[][] = Object.values(PALETTE);
const HAIR = PALETTE["G"]!;
const SKIN = PALETTE["S"]!;
const CELL = FIXTURE.nativeSheet.cell;
const FEET_ROW_IN_CELL = FIXTURE.feetRowInCell;
const FRAME_COUNT = FIXTURE.frames.length;

const CLOCK_INKS: number[][] = [
  [242, 241, 220], // white hours
  [147, 181, 160], // muted date
  [85, 189, 232], // blue minutes
  [184, 243, 91], // green path ticks
  [244, 195, 140], // skin separator
  [241, 189, 101], // amber seconds
  [41, 75, 54], // dark path
];

const BASE = new Date(2026, 10, 9, 12, 0, 0).getTime();
const at = (step: number, transparent = false) => prepareIdleClockImage(BASE + step * 1000, transparent);

function pixel(data: Uint8Array, x: number, y: number): number[] {
  const offset = (y * 64 + x) * 4;
  return [...data.slice(offset, offset + 4)];
}
const isBlack = (rgba: number[]) => rgba[0] === 0 && rgba[1] === 0 && rgba[2] === 0;
function sameRgb(rgba: number[], ink: number[]): boolean {
  return rgba[3] === 255 && rgba[0] === ink[0] && rgba[1] === ink[1] && rgba[2] === ink[2];
}
function charAt(rgba: number[]): string | null {
  for (const [key, ink] of Object.entries(PALETTE)) if (sameRgb(rgba, ink)) return key;
  return null;
}
// Unchanged walker travel formula: two walkers 40 columns apart, 2 columns per second.
const walkerLeft = (step: number, offset = 0) => (((step * 2 + offset) % 80) + 80) % 80 - 8;
// Each frame keeps its native offset inside a 16x16 source cell; the cell is
// placed so the feet row lands directly above the path row 63.
const cellTop = 62 - FEET_ROW_IN_CELL;

function assertFrameAt(data: Uint8Array, step: number, offset: number, frameIndex: number, where: string) {
  const frame = FIXTURE.frames[frameIndex]!;
  const cellLeft = walkerLeft(step, offset) + 1;
  assert.ok(cellLeft >= 0 && cellLeft + CELL <= 64, `${where}: walker cell fully on screen`);
  for (let cy = 3; cy < 13; cy++) {
    for (let cx = 0; cx < CELL; cx++) {
      const row = frame.rows[cy - frame.y];
      const col = cx - frame.x;
      const expected = row ? row[col] ?? "." : ".";
      const actual = pixel(data, cellLeft + cx, cellTop + cy);
      if (expected !== ".") {
        assert.deepEqual(actual, [...PALETTE[expected]!, 255], `${where} native pixel ${cx}/${cy}`);
      } else {
        assert.ok(isBlack(actual), `${where} background pixel ${cx}/${cy} must stay empty, got ${actual}`);
      }
    }
  }
}

test("walker palette matches the extracted reference and stays separate from the clock inks", () => {
  assert.deepEqual(PALETTE, { G: [0, 179, 0], S: [240, 208, 208], B: [64, 64, 224] });
  for (const charInk of CHAR_INKS) {
    for (const clockInk of CLOCK_INKS) {
      assert.notDeepEqual(charInk, clockInk, "character ink must differ from every clock ink");
    }
  }
  const data = decodePng(at(5)).data;
  for (let y = 53; y < 63; y++) {
    for (let x = 0; x < 64; x++) {
      const rgba = pixel(data, x, y);
      assert.ok(
        CLOCK_INKS.every(ink => !sameRgb(rgba, ink)),
        `clock ink ${rgba} must not appear in the walker strip at ${x}/${y}`,
      );
    }
  }
});

test("each of the nine extracted sheet poses is rendered 1:1 in sheet order at native pixels", () => {
  // Steps 4..12 select frames (step % 9) = 4,5,6,7,8,0,1,2,3: every sheet pose
  // exactly once for walker 1, whose cell stays fully on screen. Walker 2's
  // +40 travel offset is only fully visible on steps 4..7 (frames 4..7).
  for (let step = 4; step < 13; step++) {
    const frameIndex = ((step % FRAME_COUNT) + FRAME_COUNT) % FRAME_COUNT;
    const data = decodePng(at(step)).data;
    assertFrameAt(data, step, 0, frameIndex, `frame ${frameIndex} walker 1`);
  }
  for (let step = 4; step < 8; step++) {
    const frameIndex = ((step % FRAME_COUNT) + FRAME_COUNT) % FRAME_COUNT;
    const data = decodePng(at(step)).data;
    assertFrameAt(data, step, 40, frameIndex, `frame ${frameIndex} walker 2`);
  }
});

test("walkers keep native alignment: feet on row 62 above the path, head rows empty, never touching the path", () => {
  const data = decodePng(at(4)).data;
  for (let y = 51; y <= 52; y++) {
    for (let x = 0; x < 64; x++) assert.ok(isBlack(pixel(data, x, y)), `head gap row ${y} must stay empty at ${x}`);
  }
  const feetRow = [...Array(64).keys()].filter(x => sameRgb(pixel(data, x, 62), SKIN));
  assert.ok(feetRow.length >= 4, "bare skin feet stand on row 62 for both walkers");
  const expectedPath = (x: number) => (x % 8 < 3 ? [184, 243, 91] : [41, 75, 54]);
  for (let x = 0; x < 64; x++) assert.deepEqual(pixel(data, x, 63), [...expectedPath(x), 255], `path pixel ${x}`);
  for (let y = 50; y <= 62; y++) {
    for (let x = 0; x < 64; x++) {
      assert.ok(!sameRgb(pixel(data, x, y), [41, 75, 54]) && !sameRgb(pixel(data, x, y), [184, 243, 91]),
        `walker strip must not borrow path ink at ${x}/${y}`);
    }
  }
});

test("the gait advances every second through the whole pose cycle", () => {
  for (let step = 4; step < 13; step++) {
    const a = decodePng(at(step)).data.slice(50 * 64 * 4, 63 * 64 * 4);
    const b = decodePng(at(step + 1)).data.slice(50 * 64 * 4, 63 * 64 * 4);
    assert.notDeepEqual(a, b, `walker strip must change between seconds ${step} and ${step + 1}`);
  }
});

test("the silhouette reads as the original right-facing lemming with bare feet and no white shoes", () => {
  const data = decodePng(at(4)).data;
  // Frame 4 of the sheet: flat green hair "GGGG" spans the head top.
  const hairTop = [...Array(64).keys()].filter(x => sameRgb(pixel(data, x, 54), HAIR));
  assert.ok(hairTop.length === 8, "flat green hair spans both walkers' head tops with native width 4");
  const feetRow = [...Array(64).keys()].filter(x => sameRgb(pixel(data, x, 62), SKIN));
  assert.ok(feetRow.length >= 4, "bare skin feet on the ground row");
  for (let y = 50; y <= 62; y++) {
    for (let x = 0; x < 64; x++) {
      assert.ok(!sameRgb(pixel(data, x, y), [242, 241, 220]), "no white shoe pixels in the walker strip");
    }
  }
});

test("walkers never overlap the time, date or seconds glyphs on their full travel", () => {
  for (let step = 0; step < 40; step++) {
    const data = decodePng(at(step)).data;
    for (let y = 0; y <= 52; y++) {
      for (let x = 0; x < 64; x++) assert.ok(charAt(pixel(data, x, y)) === null, `character ink above y53 at ${x}/${y} step ${step}`);
    }
    for (let y = 53; y <= 62; y++) {
      for (let x = 0; x < 64; x++) {
        const rgba = pixel(data, x, y);
        assert.ok(charAt(rgba) !== null || isBlack(rgba), `unexpected strip pixel ${rgba} at ${x}/${y} step ${step}`);
      }
    }
  }
});

test("transparent background keeps walker pixels opaque and everything else unchanged", () => {
  const opaque = decodePng(at(6));
  const transparent = decodePng(at(6, true));
  assert.deepEqual(prepareIdleClockImage(BASE + 6 * 1000, false), prepareIdleClockImage(BASE + 6 * 1000));
  let walkerPixels = 0;
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      const a = pixel(opaque.data, x, y);
      const b = pixel(transparent.data, x, y);
      if (charAt(a) !== null) {
        assert.deepEqual(b, a, `walker pixel ${x}/${y} stays opaque under transparency`);
        walkerPixels++;
      } else if (isBlack(a)) {
        assert.equal(b[3], 0, `gap ${x}/${y} becomes transparent`);
      } else {
        assert.deepEqual(b, a, `clock ink ${x}/${y} unchanged by transparency`);
      }
    }
  }
  assert.ok(walkerPixels > 0, "walkers remain drawn ink");
});

test("time, date and path pixels keep their exact clock inks and positions", () => {
  const data = decodePng(at(4)).data;
  for (let x = 0; x < 64; x++) {
    const expected = x % 8 < 3 ? [184, 243, 91] : [41, 75, 54];
    assert.deepEqual(pixel(data, x, 63), [...expected, 255], `path pixel ${x}`);
  }
  const expectedInks: number[][] = [[242, 241, 220], [147, 181, 160], [85, 189, 232], [241, 189, 101], [0, 0, 0]];
  for (let y = 0; y <= 52; y++) {
    for (let x = 0; x < 64; x++) {
      const rgba = pixel(data, x, y);
      assert.ok(
        expectedInks.some(ink => sameRgb(rgba, ink)) || isBlack(rgba),
        `unexpected color ${rgba} above the walker strip at ${x}/${y}`,
      );
    }
  }
});

test("negative epoch timestamps render successfully with preserved clock/path regions", () => {
  const data = decodePng(prepareIdleClockImage(-1000)).data;
  for (let x = 0; x < 64; x++) {
    const expected = x % 8 < 3 ? [184, 243, 91] : [41, 75, 54];
    assert.deepEqual(pixel(data, x, 63), [...expected, 255], `path pixel ${x}`);
  }
  const expectedInks: number[][] = [[242, 241, 220], [147, 181, 160], [85, 189, 232], [241, 189, 101], [0, 0, 0]];
  for (let y = 0; y <= 52; y++) {
    for (let x = 0; x < 64; x++) {
      const rgba = pixel(data, x, y);
      assert.ok(expectedInks.some(ink => sameRgb(rgba, ink)) || isBlack(rgba), `unexpected color ${rgba} at ${x}/${y}`);
    }
  }
  for (let y = 53; y <= 62; y++) {
    for (let x = 0; x < 64; x++) {
      const rgba = pixel(data, x, y);
      assert.ok(charAt(rgba) !== null || isBlack(rgba), `walker strip pixel ${rgba} at ${x}/${y}`);
    }
  }
});
