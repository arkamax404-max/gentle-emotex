/**
 * Pure view model and text rows for the `/emote` control panel. The host
 * component owns keyboard input, selection and theme; this module decides what
 * the panel says, so every row is testable without a TUI.
 *
 * Nothing here sends, writes or reads a file, and no destination URL, route,
 * port route or credential is ever rendered: the panel shows preferences,
 * counts and deadlines, never where the frames actually go.
 */

export const PANEL_OUTPUTS = ["internal", "local", "d200", "display"] as const;
export type PanelOutput = (typeof PANEL_OUTPUTS)[number];

export const PANEL_CLOCK_MODES = ["off", "receiver", "silence"] as const;
export type PanelClockMode = (typeof PANEL_CLOCK_MODES)[number];

/** One output switch as the panel shows it. */
export interface PanelOutputRow {
  output: PanelOutput;
  /** The stored preference, independent of whether a destination exists. */
  enabled: boolean;
  /** Destinations this output currently owns; always 0 for the terminal avatar. */
  destinations: number;
  /** Safe extra detail, such as a D200 port number. Never a destination. */
  detail?: string;
}

/** One destination's idle-clock capability as the panel shows it. */
export interface PanelClockRow {
  /** Positional label: `local`, `lan` or `d200`. */
  label: string;
  mode: PanelClockMode;
  session: boolean;
  /** Milliseconds left on the settled deadline; null when not settled. */
  remaining: number | null;
  carrier: boolean;
}

export interface PanelAppearance {
  avatar: string;
  avatarManual: boolean;
  /** Saved project title override, or null for the folder basename. */
  title: string | null;
  /** Working-directory folder basename, the default title. */
  folder: string;
  size: number;
  placement: string;
  frame: boolean;
  accent: string;
}

export interface PanelStatus {
  status: string;
  phase: string;
  activeSubagents: number;
  workPhase: string | null;
  workPhaseSource: "native" | "direct" | "none";
  png: { state: string; frame: string; set: string } | null;
}

export interface PanelSnapshot {
  /** The extension's own `enabled` switch. */
  enabled: boolean;
  /** False in a session that cannot own shared displays (a child session). */
  ownsDisplays: boolean;
  outputs: PanelOutputRow[];
  clocks: PanelClockRow[];
  appearance: PanelAppearance;
  status: PanelStatus;
}

const OUTPUT_LABELS: Record<PanelOutput, string> = {
  internal: "terminal avatar",
  local: "local simulators / desktop",
  d200: "d200 key",
  display: "led / esp32",
};

/** `off` → `receiver` → `silence` → `off`; an unknown value falls back to `off`. */
export function cycleClockMode(mode: PanelClockMode): PanelClockMode {
  if (mode === "off") return "receiver";
  if (mode === "receiver") return "silence";
  return "off";
}

/**
 * A deadline reads as remaining whole seconds (rounded up, so the last partial
 * second is never hidden), `active` once it elapsed, and `not-settled` while the
 * activity or the selected state is not eligible.
 */
export function clockDeadline(remaining: number | null): string {
  if (remaining === null) return "not-settled";
  if (remaining > 0) return `remaining ${Math.ceil(remaining / 1000)}s`;
  return "active";
}

function destinationText(count: number): string {
  if (count <= 0) return "no destination";
  return count === 1 ? "1 destination" : `${count} destinations`;
}

function outputRow(row: PanelOutputRow): string {
  const marker = row.enabled ? "[on ]" : "[off]";
  const label = OUTPUT_LABELS[row.output] ?? row.output;
  // The terminal avatar owns no destinations, so a count there would be a lie.
  if (row.output === "internal") return ` ${marker} ${label}`;
  const detail = row.detail ? `  (${row.detail})` : `  (${destinationText(row.destinations)})`;
  return ` ${marker} ${label}${detail}`;
}

function clockRow(row: PanelClockRow): string {
  return ` ${row.label.padEnd(6)} ${row.mode.padEnd(10)}${clockDeadline(row.remaining)}`;
}

function statusRows(status: PanelStatus): string[] {
  const png = status.png ? `${status.png.state}/${status.png.frame} (${status.png.set})` : "none selected yet";
  return [
    ` activity ${status.status}/${status.phase}  subagents ${status.activeSubagents}`,
    ` phase ${status.workPhase ?? "none"} (source ${status.workPhaseSource})`,
    ` png ${png}`,
  ];
}

function appearanceRows(appearance: PanelAppearance): string[] {
  const avatar = ` avatar ${appearance.avatar} (${appearance.avatarManual ? "manual" : "auto"})`;
  const title = `  title ${appearance.title ?? "-"} (${appearance.folder})`;
  return [
    `${avatar}${title}`,
    ` size ${appearance.size}  placement ${appearance.placement}  frame ${appearance.frame ? "on" : "off"}  accent ${appearance.accent}`,
  ];
}

/** The complete panel body, one entry per row; the component pads and themes it. */
export function buildPanelRows(snapshot: PanelSnapshot): string[] {
  if (!snapshot.enabled) {
    return [
      " emote extension disabled in configuration",
      ' set "enabled": true to manage the avatar and its outputs',
    ];
  }
  const rows = ["OUTPUTS", ...snapshot.outputs.map(outputRow), "CLOCK"];
  if (snapshot.clocks.length === 0) rows.push(" clock: no destination");
  else rows.push(...snapshot.clocks.map(clockRow));
  rows.push("STATUS", ...statusRows(snapshot.status), "APPEARANCE", ...appearanceRows(snapshot.appearance));
  if (!snapshot.ownsDisplays) rows.push(" display ownership: unavailable in this session");
  return rows;
}

/** Rows that change when the user cycles a control; the component uses them as anchors. */
export function panelSections(rows: string[]): string[] {
  return rows.filter(row => ["OUTPUTS", "CLOCK", "STATUS", "APPEARANCE"].includes(row));
}