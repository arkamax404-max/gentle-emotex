import { encodePng } from "./png.ts";

const GLYPHS: Record<string, readonly string[]> = {
  "0": ["111", "101", "101", "101", "111"], "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"], "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"], "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"], "7": ["111", "001", "010", "010", "010"],
  "8": ["111", "101", "111", "101", "111"], "9": ["111", "101", "111", "001", "111"],
  "/": ["001", "001", "010", "100", "100"], ":": ["000", "010", "000", "010", "000"],
};
const INK = { white: [242, 241, 220], muted: [147, 181, 160], blue: [85, 189, 232],
  green: [184, 243, 91], skin: [244, 195, 140], amber: [241, 189, 101], path: [41, 75, 54] };
/** Exact Lemmings walker palette taken 1:1 from the authoritative sprite sheet. */
const WALKER = { hair: [0, 179, 0], skin: [240, 208, 208], tunic: [64, 64, 224] };
/**
 * Native Lemmings walk cycle, extracted 1:1 (no resizing) from the authoritative
 * 12x-magnified reference sheet (576x576 -> native 48x48, 3x3 poses in 16x16
 * cells; canonical extraction in tests/fixtures/lemmings-walk.json). Each frame
 * keeps its native offset inside its 16x16 cell; every pose stands with its
 * feet on cell row 12. Faces right, in sheet order.
 */
const WALK_FEET_ROW = 12;
const WALK_FRAMES: { x: number; y: number; rows: readonly string[] }[] = [
  { x: 6, y: 4, rows: ["GGGG", "GGS.", ".SSS", ".SB.", ".SB.", ".SB.", ".BB.", "SBB.", ".SS."] },
  { x: 6, y: 3, rows: [".G.G.", "GGG..", "GGS..", ".SSS.", ".SB..", "SBB..", "SBB.S", ".BB.S", "BB.S.", "SS..."] },
  { x: 5, y: 4, rows: [".G.G..", ".GGG..", "..GS..", "..SSS.", ".SSB..", ".SBB..", "SSBBB.", ".BBBB.", "SS..SS"] },
  { x: 5, y: 4, rows: ["..GG.", ".GGSG", ".GSSS", "..SB.", "..SB.", ".SBB.", "..BB.", "SBBBB", "S..SS"] },
  { x: 6, y: 4, rows: ["GGGG", "GGS.", "GSSS", ".SB.", ".BS.", ".SB.", ".BB.", "SBB.", ".SS."] },
  { x: 6, y: 3, rows: [".G.G.", "GGG..", "GGS..", ".SSS.", ".SB..", ".BS..", ".BS.S", ".BB.S", "BB.S.", "SS..."] },
  { x: 5, y: 4, rows: [".G.G..", ".GGG..", "..GS..", "..SSS.", "..BS..", "..BS..", "..BBS.", ".BBBB.", "SS..SS"] },
  { x: 5, y: 4, rows: ["..GG.", ".GGSG", ".GSSS", "..SB.", "..SB.", "..BS.", "..BB.", "SBBBB", "S..SS"] },
  { x: 5, y: 3, rows: [".GG.", "GGS.", "GSSS", ".SB.", ".BS.", ".BBS", ".BBS", ".BB.", "SB..", ".S.."] },
];

/** Selected bottom-promenade design: native pixels, local DD/MM/YYYY and 24h time. */
export function prepareIdleClockImage(nowMs: number, transparentBackground = false): Buffer {
  const now = new Date(nowMs);
  if (!Number.isFinite(now.getTime())) throw new Error("invalid idle clock time");
  const data = new Uint8Array(64 * 64 * 4);
  if (!transparentBackground) for (let i = 3; i < data.length; i += 4) data[i] = 255;
  const rect = (left: number, top: number, width: number, height: number, ink: number[]) => {
    for (let y = Math.max(0, top); y < Math.min(64, top + height); y++) {
      for (let x = Math.max(0, left); x < Math.min(64, left + width); x++) {
        data.set([ink[0]!, ink[1]!, ink[2]!, 255], (y * 64 + x) * 4);
      }
    }
  };
  const text = (value: string, left: number, top: number, scale: number, ink: number[]) => {
    for (let i = 0; i < value.length; i++) {
      const glyph = GLYPHS[value[i]!];
      if (!glyph) continue;
      for (let y = 0; y < 5; y++) for (let x = 0; x < 3; x++) {
        if (glyph[y]![x] === "1") rect(left + (i * 4 + x) * scale, top + y * scale, scale, scale, ink);
      }
    }
  };
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${String(now.getFullYear()).padStart(4, "0")}`;
  text(date, Math.floor((64 - (date.length * 4 - 1)) / 2), 1, 1, INK.muted);
  text(pad(now.getHours()), 12, 9, 4, INK.white);
  text(pad(now.getMinutes()), 12, 31, 4, INK.blue);
  text(":", 43, 35, 1, INK.amber);
  text(pad(now.getSeconds()), 46, 33, 2, INK.amber);
  rect(0, 63, 64, 1, INK.path);
  for (let x = 0; x < 64; x += 8) rect(x, 63, 3, 1, INK.green);
  const step = Math.floor(nowMs / 1000);
  const frameCount = WALK_FRAMES.length;
  const frame = WALK_FRAMES[((step % frameCount) + frameCount) % frameCount]!;
  const colors: Record<string, number[]> = { G: WALKER.hair, S: WALKER.skin, B: WALKER.tunic };
  const cellTop = 62 - WALK_FEET_ROW;
  for (const offset of [0, 40]) {
    const left = ((step * 2 + offset) % 80 + 80) % 80 - 8;
    for (let y = 0; y < frame.rows.length; y++) for (let x = 0; x < frame.rows[y]!.length; x++) {
      const ink = colors[frame.rows[y]![x]!];
      if (ink) rect(left + 1 + frame.x + x, cellTop + frame.y + y, 1, 1, ink);
    }
  }
  return encodePng({ width: 64, height: 64, data });
}
