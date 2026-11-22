import { decodePng, encodePng } from "./png.ts";
import { drawDisplayOutline } from "./display_outline.ts";
import { drawDisplayText } from "./display_text.ts";
import { isWorkPhase } from "./work_phase.ts";
import { EMOTE_STATES } from "./types.ts";
import type { DisplayActivity } from "./external_display.ts";

// Display copy only: frame identifiers, commands and metadata keep their names.
const actionLabels = new Map<string, string>([
  ["think", "thinking"], ["talk", "talking"], ["read", "reading"],
  ["write", "writing"], ["compact", "compacting"], ["ask", "asking"],
  ["delegate", "delegating"], ["remember", "remembering"],
  ["explore", "exploring"], ["build", "building"], ["verify", "verifying"],
  ["judge", "judging"], ["review", "reviewing"], ["grandma", "no task"],
]);

/**
 * An idle parent (including the post-error idle the host reports while
 * workers keep running) with at least one active subagent. Shared by the status
 * label and the phase label so both rows follow the same RUNNING override.
 */
function isRunningSubagents(activity: { status: string; phase: string; activeSubagents?: number }): boolean {
  return activity.phase === "idle" && activity.status !== "busy" && (activity.activeSubagents ?? 0) > 0;
}

/**
 * Single visible-phase resolver shared by rendering and the per-destination
 * phase timer: RUNNING (idle parent with active subagents, even after error) first,
 * then the selected frame's registered demo name under any coarse/host phase.
 * Without a registered selection, the host detail fallback applies only for
 * thinking/executing; otherwise the coarse phase remains.
 */
export function resolvePhaseLabel(activity: Pick<DisplayActivity, "status" | "phase"> & Partial<Pick<DisplayActivity, "activeSubagents" | "workPhase"> & { state?: string }>): string {
  if (isRunningSubagents(activity)) return "RUNNING";
  const coarse = activity.phase;
  const detailed = activity.state !== undefined && (EMOTE_STATES as readonly string[]).includes(activity.state)
    ? activity.state
    : isWorkPhase(activity.workPhase) && (coarse === "thinking" || coarse === "executing")
      ? activity.workPhase
      : coarse;
  return actionLabels.get(detailed) ?? detailed;
}

/** MM:SS beside the visible phase label; visible IDLE and NO TASK render untimed only without active subagents, as do invalid/negative elapsed values. */
function timedPhaseLabel(label: string, phaseElapsedSeconds: number | undefined, activeSubagents?: number): string {
  if (phaseElapsedSeconds === undefined || !Number.isFinite(phaseElapsedSeconds) || phaseElapsedSeconds < 0) return label;
  if (["IDLE", "NO TASK"].includes(label.toUpperCase()) && (activeSubagents ?? 0) === 0) return label;
  const total = Math.floor(phaseElapsedSeconds);
  const clock = `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
  // The full row must fit the 16-character font limit: the clock grows past
  // 99 minutes and the phase text shrinks with it; the separator is one cell.
  return `${label.slice(0, 15 - clock.length)} ${clock}`;
}

/** Green folder-name ink for the captioned layout, matching the idle status palette green. */
const PROJECT_NAME_INK = [128, 224, 160] as const;

/** Raw post-accent sprite, not the terminal border; opaque by default, optionally preserving RGBA. */
export function prepareDisplayImage(base64: string, activity?: Pick<DisplayActivity, "status" | "phase"> & Partial<Pick<DisplayActivity, "activeSubagents" | "workPhase"> & { state?: string; phaseElapsedSeconds?: number }>, background = "#000000", backgroundCoverage = 1, outline?: string, transparentBackground = false, projectName?: string | null, captionInk: readonly [number, number, number] = PROJECT_NAME_INK): Buffer {
  if (outline !== undefined && !/^#[0-9a-f]{6}$/i.test(outline)) throw new Error("invalid display outline");
  if (!Number.isFinite(backgroundCoverage) || backgroundCoverage < 0 || backgroundCoverage > 1) throw new Error("invalid background coverage");
  if (!/^#[0-9a-f]{6}$/i.test(background)) throw new Error("invalid display background");
  const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  const rgb = [1, 3, 5].map(offset => parseInt(background.slice(offset, offset + 2), 16));
  const source = decodePng(Buffer.from(base64, "base64"));
  if (source.width < 1 || source.height < 1) throw new Error("empty display image");
  // Approved compact captioned layout (destinations with a project name):
  // blank y0, caption y1..5, gap y6..8, avatar y9..48, bottom gap y49,
  // separator y50, status y51..55, two-pixel line gap y56..57, phase/time y58..62,
  // single bottom pixel y63. The whole avatar region rides one pixel higher, so a
  // full-height sprite shifts up with it instead of clamping at the old row 10.
  // Without a name the legacy layout (sprite y0..39, status y44, phase y54) stays.
  const named = typeof projectName === "string" && projectName.length > 0;
  const avatarTop = named ? 9 : 0;
  const statusTop = named ? 51 : 44;
  const phaseTop = named ? 58 : 54;
  // The outline is reserved inside the avatar region so both separators stay clear.
  const outlineRows = named ? 40 : 41;
  const scale = Math.min(1, 48 / source.width, 40 / source.height);
  const width = Math.max(1, Math.floor(source.width * scale));
  const height = Math.max(1, Math.floor(source.height * scale));
  const left = Math.floor((64 - width) / 2), top = avatarTop + Math.floor((40 - height) / 2);
  const data = new Uint8Array(64 * 64 * 4);
  const occupied = outline ? new Uint8Array(64 * outlineRows) : null;
  // Alpha sprites retain opaque black artwork in their mask;
  // fully opaque sprites use black as the matte for the outline only.
  const hasTransparency = !!outline && source.data.some((value, index) => index % 4 === 3 && value < 255);
  if (!transparentBackground) for (let i = 3; i < data.length; i += 4) data[i] = 255;
  // In opaque mode, apply the background only inside the source PNG's bounds.
  // Outer padding and label gaps stay black, or transparent in RGBA mode.
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const src = (Math.floor(y * source.height / height) * source.width + Math.floor(x * source.width / width)) * 4;
    const dst = ((top + y) * 64 + left + x) * 4;
    const alpha = source.data[src + 3]! / 255;
    if (occupied && alpha > 0 && (hasTransparency || source.data[src] || source.data[src + 1] || source.data[src + 2])) occupied[(top + y - avatarTop) * 64 + left + x] = 1;
    if (transparentBackground) {
      // Straight RGBA: preserve even RGB under zero alpha, without premultiplication.
      data.set(source.data.subarray(src, src + 4), dst);
      continue;
    }
    // A fixed, canvas-anchored pattern: no frame-to-frame brightness switching.
    const covered = bayer[((top + y) % 4) * 4 + (left + x) % 4]! < Math.round(backgroundCoverage * 16);
    for (let c = 0; c < 3; c++) data[dst + c] = Math.round(source.data[src + c]! * alpha + (covered ? rgb[c]! : 0) * (1 - alpha));
  }
  if (occupied && outline) drawDisplayOutline(data, occupied, [1, 3, 5].map(offset => parseInt(outline.slice(offset, offset + 2), 16)), outlineRows, avatarTop);
  if (activity) {
    const color = activity.status === "error" ? [255, 96, 96] : activity.status === "busy" ? [255, 208, 96] : [128, 224, 160];
    const count = activity.activeSubagents ?? 0;
    // Parent idle, including after error, while subagents run: show SUBAGENTS/SUBAGENT
    // and RUNNING on the display only, without changing the underlying activity.
    // Exactly one known child reads as the singular SUBAGENT with no count.
    const running = isRunningSubagents(activity);
    // Trial: host ODD detail changes status copy only, below subagent/error priority.
    // The phase row, its timer, the selected frame and protocol status stay unchanged.
    // The fallback busy copy is displayed as WORKING; internal status and headers stay busy.
    const statusLabel = running ? ((activity.activeSubagents ?? 0) === 1 ? "SUBAGENT" : "SUBAGENTS")
      : activity.status === "error" && activity.phase === "idle" ? "IDLE"
      : activity.status !== "error" && isWorkPhase(activity.workPhase) ? activity.workPhase
      : activity.status === "busy" ? "working" : activity.status;
    const countLabel = count > 0 && !(running && count === 1) ? `(${count > 999 ? "999+" : count})` : "";
    // Keep the complete counter inside the existing 16-character font limit.
    const visibleStatus = countLabel ? statusLabel.slice(0, 15 - countLabel.length) : statusLabel;
    const label = countLabel ? `${visibleStatus} ${countLabel}` : visibleStatus;
    drawDisplayText(data, label, statusTop, index => index > visibleStatus.length ? [255, 255, 0] : color);
    const phaseLabel = timedPhaseLabel(resolvePhaseLabel(activity), activity.phaseElapsedSeconds, activity.activeSubagents);
    const clockStart = phaseLabel.includes(":") ? phaseLabel.lastIndexOf(" ") + 1 : phaseLabel.length;
    drawDisplayText(data, phaseLabel, phaseTop, index => index >= clockStart ? [241, 189, 101] : [238, 238, 238]);
  }
  // The folder name rides above the avatar, muted, uppercase and truncated by the font.
  // The ink is source-selectable so LED destinations can brighten the title without
  // touching the status or phase palette.
  if (named) drawDisplayText(data, projectName as string, 1, captionInk);
  return encodePng({ width: 64, height: 64, data });
}
