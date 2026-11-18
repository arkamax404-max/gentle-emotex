import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
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
const LOCK_TIMEOUT_MS = 250;
const LOCK_RETRY_MS = 10;

/** Blocks this attempt only; total wait is bounded by LOCK_TIMEOUT_MS. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** A lock is only ours if the file still carries the token we wrote into it. */
function ownsLock(lockFile: string, token: string): boolean {
  try {
    return readFileSync(lockFile, "utf-8") === token;
  } catch {
    return false;
  }
}

/** True when the process that wrote the lock can no longer be running. */
function ownerIsGone(lockFile: string): boolean {
  try {
    const [pid] = readFileSync(lockFile, "utf-8").split(":");
    const owner = Number(pid);
    if (!Number.isSafeInteger(owner) || owner <= 0) return false;
    if (owner === process.pid) return false;
    try {
      process.kill(owner, 0);
      return false; // alive (or not ours to signal)
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  } catch {
    return false;
  }
}

/**
 * Exclusive create of a sibling lock file. A lock is only taken over when its
 * recorded owner process is provably gone; age alone is never a takeover reason,
 * because a live writer paused for a few seconds would then be duplicated and
 * both writers would report success while one snapshot is discarded.
 */
function acquireLock(lockFile: string, token: string): boolean {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      writeFileSync(lockFile, token, { flag: "wx" });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
      if (ownerIsGone(lockFile)) {
        try { unlinkSync(lockFile); } catch { /* someone else cleaned it */ }
        continue;
      }
      if (Date.now() >= deadline) return false;
      pause(LOCK_RETRY_MS);
    }
  }
}

export function writePanelConfig(agentRoot: string, key: PanelConfigKey, value: unknown): ConfigWriteResult {
  if (!isPanelConfigKey(key)) return { ok: false, error: "unsupported configuration key" };
  const invalid = validatePanelConfigValue(key, value);
  if (invalid !== null) return { ok: false, error: invalid };

  const file = join(agentRoot, "extensions", "gentle-emote", "config.json");
  const lockFile = `${file}.lock`;
  try {
    mkdirSync(dirname(file), { recursive: true });
  } catch {
    return { ok: false, error: "cannot write configuration" };
  }

  // One shared configuration, many running sessions: the read, the merge and the
  // rename must happen under a single exclusive lock, otherwise two sessions
  // changing different keys each rename a stale snapshot and silently discard
  // the other's choice while both report success.
  const token = `${process.pid}:${randomUUID()}`;
  if (!acquireLock(lockFile, token)) return { ok: false, error: "configuration is busy" };

  try {
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
      writeFileSync(temporary, `${JSON.stringify({ ...current, [key]: value }, null, 2)}
`, "utf-8");
      renameSync(temporary, file);
      return { ok: true, error: null };
    } catch {
      try { unlinkSync(temporary); } catch { /* nothing to clean up */ }
      return { ok: false, error: "cannot write configuration" };
    }
  } finally {
    // Never delete a lock that is not ours: another writer may have taken over
    // after our own process was presumed gone.
    if (ownsLock(lockFile, token)) {
      try { unlinkSync(lockFile); } catch { /* already gone */ }
    }
  }
}
