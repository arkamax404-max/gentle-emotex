import { test } from "node:test";
import assert from "node:assert/strict";
import { drawDisplayText } from "../src/display_text.ts";

const pixel = (data: Uint8Array, x: number, y: number) => [...data.slice((y * 64 + x) * 4, (y * 64 + x) * 4 + 4)];
const canvas = () => {
  const data = new Uint8Array(64 * 64 * 4);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return data;
};

test("the font gains filename glyphs for dot and underscore", () => {
  for (const [char, lit] of [[".", [[31, 4 + 4]]], ["_", [[30, 4 + 4], [31, 4 + 4], [32, 4 + 4]]]] as const) {
    const data = canvas();
    drawDisplayText(data, char, 4, [255, 255, 255]);
    for (let y = 4; y < 9; y++) for (let x = 30; x < 33; x++) {
      const expected = lit.some(([lx, ly]) => lx === x && ly === y) ? [255, 255, 255, 255] : [0, 0, 0, 255];
      assert.deepEqual(pixel(data, x, y), expected, `${char} at ${x},${y}`);
    }
  }
});

test("accents normalize to readable unaccented uppercase letters", () => {
  const data = canvas();
  drawDisplayText(data, "señor", 4, [255, 255, 255]);
  const expected = canvas();
  drawDisplayText(expected, "SENOR", 4, [255, 255, 255]);
  assert.deepEqual(data, expected, "ñ renders as N");
  const acute = canvas();
  drawDisplayText(acute, "café-plugin", 4, [255, 255, 255]);
  const plain = canvas();
  drawDisplayText(plain, "CAFE-PLUGIN", 4, [255, 255, 255]);
  assert.deepEqual(acute, plain, "é renders as E");
});
