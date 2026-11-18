import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The only appearance keys the panel may persist. This module exists so a panel
 * action cannot rewrite arbitrary configuration: the whitelist, the value
 * validation and the atomic write live here, and nothing else is writable.
 *
 * Writes go to the user-global config of the agent directory the session
 * actually runs on (`<agent dir>/extensions/gentle-emote/config.json`), never to
 * a project layer. An unreadable or non-object file fails closed and is left
 * byte for byte untouched, so a broken configuration can never be replaced by
 * one written from a guess.
 */
export const PANEL_CONFIG_KEYS = ["size", "placement", "frame", "accent"] as const;
export type PanelConfigKey = (typeof PANEL_CONFIG_KEYS)[number];

export interface ConfigWriteResult {
  ok: boolean;
  error: string | null;
}

const PLACEMENTS = ["beside-editor", "above-editor"] as const;
const ACCENTS = ["auto", "pink", "cyan", "yellow", "green"] as const;
const MIN_SIZE = 4;
const MAX_SIZE = 24;

/** `null` when the value is acceptable for that key, an error message otherwise. */
export function validatePanelConfigValue(key: PanelConfigKey, value: unknown): string | null {
  if (key === "size") {
    return Number.isInteger(value) && (value as number) >= MIN_SIZE && (value as number) <= MAX_SIZE
      ? null
      : "invalid size";
  }
  if (key === "placement") {
    return typeof value === "string" && (PLACEMENTS as readonly string[]).includes(value) ? null : "invalid placement";
  }
  if (key === "frame") return typeof value === "boolean" ? null : "invalid frame";
  if (key === "accent") {
    if (typeof value !== "string") return "invalid accent";
    if ((ACCENTS as readonly string[]).includes(value)) return null;
    return /^#[0-9a-f]{6}$/i.test(value) ? null : "invalid accent";
  }
  return "unsupported configuration key";
}

export function isPanelConfigKey(value: unknown): value is PanelConfigKey {
  return typeof value === "string" && (PANEL_CONFIG_KEYS as readonly string[]).includes(value);
}

/**
 * Writes one whitelisted key into the user-global config, atomically: a
 * temporary sibling is written and renamed over the file, so a crash never
 * leaves a half-written configuration, and every unrelated key survives.
 */
export function writePanelConfig(agentRoot: string, key: PanelConfigKey, value: unknown): ConfigWriteResult {
  if (!isPanelConfigKey(key)) return { ok: false, error: "unsupported configuration key" };
  const invalid = validatePanelConfigValue(key, value);
  if (invalid !== null) return { ok: false, error: invalid };

  const file = join(agentRoot, "extensions", "gentle-emote", "config.json");
  let current: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf-8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, error: "cannot read configuration" };
      }
      current = parsed as Record<string, unknown>;
    } catch {
      return { ok: false, error: "cannot read configuration" };
    }
  }

  const temporary = `${file}.${process.pid}.tmp`;
  try {
    // A fresh agent directory has no config file and may not even have the
    // extension directory yet; creating it is safe, guessing the file is not.
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(temporary, `${JSON.stringify({ ...current, [key]: value }, null, 2)}\n`, "utf-8");
    renameSync(temporary, file);
    return { ok: true, error: null };
  } catch {
    try { unlinkSync(temporary); } catch { /* nothing to clean up */ }
    return { ok: false, error: "cannot write configuration" };
  }
}