import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { EXTENSION_NAME } from "./emotes.ts";

/**
 * Metadata only: percent-encode a project name for the `X-Emote-Project-Name`
 * header. Basename-shaped inputs are accepted (spaces, unicode and dots kept);
 * empty, blank, oversized, path-like (separators or dot segments),
 * control-character or malformed-unicode names are omissions, never errors:
 * lone surrogates make encodeURIComponent throw, so encoding is guarded.
 */
export function encodeProjectName(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || value.trim().length === 0) return null;
  if (/[/\\]|^\.{1,2}$|[\u0000-\u001f\u007f]/.test(value)) return null;
  try { return encodeURIComponent(value); } catch { return null; }
}

/**
 * Normalize a `/emote title` value with the same validation the sender applies
 * to project names. `null` is the explicit "reset to the folder basename"
 * choice, `undefined` marks an invalid title and a valid result is trimmed.
 */
export function normalizeTitle(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return encodeProjectName(trimmed) === null ? undefined : trimmed;
}

/** Malformed or unreadable overrides fall back to the folder basename. */
export const TITLE_WARNING = "cannot read saved title override; using the project folder name";

/**
 * One per-project title override, stored at
 * `<project>/.pi/extensions/gentle-emote/title.json`, separate from config.json
 * and from the global output preferences. Atomic validated writes; save happens
 * before the live caption applies and a failed save leaves storage untouched.
 */
export class TitleStore {
  private dir: string;

  constructor(root = process.cwd()) {
    this.dir = join(root, ".pi", "extensions", EXTENSION_NAME);
  }

  private get path(): string { return join(this.dir, "title.json"); }

  /** null (no override or explicit reset) with a warning on malformed storage. */
  load(report: (message: string) => void): string | null {
    let text: string;
    try { text = readFileSync(this.path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      report(TITLE_WARNING);
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid saved title override");
      const { title } = parsed as { title?: unknown };
      if (title === null) return null;
      const normalized = normalizeTitle(title);
      if (normalized === undefined || normalized !== title) throw new Error("invalid saved title override");
      return normalized;
    } catch {
      report(TITLE_WARNING);
      return null;
    }
  }

  /** Atomic write; rejects invalid titles so the caller keeps the current one. */
  save(title: string | null): void {
    const stored = title === null ? null : normalizeTitle(title);
    if (stored === undefined || (title !== null && stored === null)) throw new Error("invalid title");
    mkdirSync(this.dir, { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify({ title: stored })}\n`, { flag: "wx" });
      renameSync(temporary, this.path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}
