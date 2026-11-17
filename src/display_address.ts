import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { agentDir, EXTENSION_NAME } from "./emotes.ts";
import { isLoopbackDisplayUrl } from "./external_display.ts";

/** Either the normalized destination or the reason it was refused; never both. */
export interface DisplayAddressResult { url: string | null; error: string | null }

export interface GlobalTargetResult { ok: boolean; error: string | null; loopbackPreserved: number }

/** A host token only: IPv4, bracketed IPv6 or a DNS name, with an optional port. */
const HOST_TOKEN = /^[A-Za-z0-9._:[\]-]+$/;

/**
 * `/emote displayOn <address>` grammar: the user names the board, not a URL.
 * Scheme, path, credentials, query and fragment are refused so the destination
 * is always exactly the `/emote` route the session-ownership reservation needs.
 * Loopback belongs to `/emote localOn`; accepting it here would silently join
 * the wrong output group.
 */
export function parseDisplayAddress(input: string): DisplayAddressResult {
  const value = input.trim();
  if (!value) return { url: null, error: "missing display address" };
  if (!HOST_TOKEN.test(value)) return { url: null, error: "invalid display address" };
  let parsed: URL;
  try {
    parsed = new URL(`http://${value}/emote`);
  } catch {
    return { url: null, error: "invalid display address" };
  }
  if (!parsed.hostname || parsed.username || parsed.password || parsed.pathname !== "/emote" || parsed.search || parsed.hash) {
    return { url: null, error: "invalid display address" };
  }
  if (isLoopbackDisplayUrl(parsed.href)) return { url: null, error: "loopback addresses belong to /emote localOn" };
  return { url: parsed.href, error: null };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Loopback destinations of an LED config, kept in their original shape: the
 * local group and the D200 key are separate outputs, so a rewrite of the LED
 * group must never drop them. A legacy loopback `url` moves into `targets`,
 * because `targets` replaces that single-URL form.
 */
function preservedLoopbackTargets(external: unknown): unknown[] {
  const base: Record<string, unknown> = isPlainObject(external) ? external : {};
  const preserved: unknown[] = [];
  if (Array.isArray(base.targets)) {
    for (const entry of base.targets) {
      if (isPlainObject(entry) && typeof entry.url === "string" && isLoopbackDisplayUrl(entry.url)) preserved.push(entry);
    }
  } else if (typeof base.url === "string" && isLoopbackDisplayUrl(base.url)) {
    preserved.push({ enabled: true, url: base.url });
  }
  return preserved;
}

/**
 * The LED config whose only non-loopback destination is `url`. One helper serves
 * both shapes the command needs: the user-global write and this session's
 * sender, so an explicit order cannot be silently shadowed by a project layer
 * that still points at the previous board.
 */
export function withDisplayTarget(external: unknown, url: string): Record<string, unknown> {
  const base: Record<string, unknown> = isPlainObject(external) ? { ...external } : {};
  delete base.url;
  return { ...base, targets: [...preservedLoopbackTargets(external), { enabled: true, url }] };
}

/**
 * Rewrite the user-global config so its LED destinations are exactly `url`.
 * The write keeps every unrelated key and every loopback destination (the local
 * group and the D200 key are separate outputs), migrates a loopback legacy
 * `url` into `targets`, and fails closed on an unreadable, malformed or
 * non-object config: the user's file is never replaced by a guess. Persistence
 * is atomic, so an interrupted write cannot leave a truncated config behind.
 */
export function persistGlobalDisplayTarget(url: string, root = agentDir()): GlobalTargetResult {
  const dir = join(root, "extensions", EXTENSION_NAME);
  const path = join(dir, "config.json");
  const failed = (error: string, loopbackPreserved = 0): GlobalTargetResult => ({ ok: false, error, loopbackPreserved });

  let text: string | null = null;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return failed("cannot read the global config");
  }
  let config: Record<string, unknown> = {};
  if (text !== null) {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return failed("cannot read the global config"); }
    if (!isPlainObject(parsed)) return failed("cannot read the global config");
    config = parsed;
  }

  const externalConfig = config.externalDisplay;
  const preserved = preservedLoopbackTargets(externalConfig);
  const next = { ...config, externalDisplay: withDisplayTarget(externalConfig, url) };

  try {
    mkdirSync(dir, { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx" });
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
  } catch {
    return failed("cannot write the global config", preserved.length);
  }
  return { ok: true, error: null, loopbackPreserved: preserved.length };
}
