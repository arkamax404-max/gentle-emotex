import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rmdir, unlink } from "node:fs/promises";
import type { Stats } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface AppearanceOptions { agentDir?: string; env?: Record<string, string | undefined> }
export interface DesktopAppearance { backgroundRgb: [number, number, number]; backgroundOpacity: number; transparentBackground: boolean }
export interface AppearanceSnapshot { version: 1; revision: number; desktop: DesktopAppearance; [key: string]: unknown }
export type AppearanceStatus = "ready" | "missing" | "saved" | "invalid" | "unsafe-path" | "unsupported-platform" | "io-error" | "busy" | "conflict" | "revision-exhausted" | "committed-durability-uncertain";
export interface AppearanceResult { status: AppearanceStatus; snapshot?: AppearanceSnapshot; cleanupError?: boolean }
const CAP = 65536;
const MAX_CONTAINER_DEPTH = 64;
const supportedPlatform = () => process.platform !== "win32" && typeof process.getuid === "function";
const leaves = ["backgroundRgb", "backgroundOpacity", "transparentBackground"];
const defaults = (): AppearanceSnapshot => ({ version: 1, revision: 0, desktop: { backgroundRgb: [0, 0, 0], backgroundOpacity: 55, transparentBackground: true } });
class Failure extends Error {
  status: AppearanceStatus;
  constructor(status: AppearanceStatus) { super(status); this.status = status; }
}
const fail = (status: AppearanceStatus): never => { throw new Failure(status); };
const code = (error: unknown) => (error as NodeJS.ErrnoException).code;
const resultError = (error: unknown): AppearanceResult => ({ status: error instanceof Failure ? error.status : "io-error" });
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Pure resolution: explicit override > defined environment override > HOME; never cwd. */
export function resolveAppearanceAgentDir(options: AppearanceOptions = {}): string {
  const env = options.env ?? process.env;
  const value = options.agentDir !== undefined ? options.agentDir : env.PI_CODING_AGENT_DIR !== undefined ? env.PI_CODING_AGENT_DIR : env.HOME ? join(env.HOME, ".pi", "agent") : undefined;
  if (!value || !isAbsolute(value) || value.includes("\0")) return fail("unsafe-path");
  // Check original components too: normalization must not hide a symlink followed by '..'.
  if (value.split(sep).some(part => part === ".." || part === ".")) return fail("unsafe-path");
  return resolve(value);
}

function safe(stat: Stats, directory: boolean, privatePath: boolean): void {
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) fail("unsafe-path");
  if (privatePath && ((typeof process.getuid === "function" && stat.uid !== process.getuid()) || (stat.mode & 0o022))) fail("unsafe-path");
}
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
async function metadata(path: string): Promise<Stats | undefined> {
  try { return await lstat(path); } catch (error) { if (code(error) === "ENOENT") return undefined; throw error; }
}
/** Ancestors are inspected but system-owned ancestors need not be user-owned/private. */
async function directories(agentDir: string, parent: string, create: boolean): Promise<void> {
  let current = parse(parent).root;
  for (const part of parent.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    let stat = await metadata(current);
    if (!stat && create) {
      try { await mkdir(current, { mode: 0o700 }); } catch (error) { if (code(error) !== "EEXIST") throw error; }
      stat = await metadata(current);
    }
    if (!stat) continue;
    safe(stat, true, current === agentDir || current.startsWith(agentDir + sep));
  }
}
async function boundedRead(path: string, limit: number): Promise<Buffer | undefined> {
  const before = await metadata(path);
  if (!before) return undefined;
  safe(before, false, true);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat(); safe(stat, false, true);
    if (!same(before, stat)) fail("unsafe-path");
    const bytes = Buffer.alloc(limit + 1); let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await handle.read(bytes, used, bytes.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > limit) fail("invalid");
    return bytes.subarray(0, used);
  } finally { await handle.close(); }
}

/** JSON.parse owns syntax. This small lexical pass rejects lost duplicate keys and
 * non-integer numeric spellings before parse can round or discard information. */
function decode(bytes: Buffer): AppearanceSnapshot {
  try {
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) fail("invalid");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const tokens = /"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null|[{}\[\]:,]/gy;
    const stack: Array<Set<string> | null> = [];
    let pos = 0;
    while (pos < text.length) {
      if (/\s/.test(text[pos])) { pos++; continue; }
      tokens.lastIndex = pos; const match = tokens.exec(text);
      if (!match) fail("invalid");
      const token = match![0]; pos = tokens.lastIndex;
      if (token === "{" || token === "[") {
        // Root object is depth 1; reject the next container before recursive parsing.
        if (stack.length >= MAX_CONTAINER_DEPTH) fail("invalid");
        stack.push(token === "{" ? new Set() : null);
      }
      else if (token === "}" || token === "]") stack.pop();
      else if (token.startsWith('"')) {
        const decoded = JSON.parse(token) as string;
        // Unicode mode matches lone surrogate code points, not valid UTF-16 pairs.
        if (/[\uD800-\uDFFF]/u.test(decoded)) fail("invalid");
        if (/^\s*:/.test(text.slice(pos))) {
          const keys = stack.at(-1);
          if (!keys || keys.has(decoded)) fail("invalid");
          keys.add(decoded);
        }
      } else if (/^-?\d/.test(token) && (!/^-?(0|[1-9][0-9]*)$/.test(token) || !Number.isSafeInteger(Number(token)))) fail("invalid");
    }
    const value = JSON.parse(text); validate(value); return value;
  } catch (error) { if (error instanceof Failure) throw error; return fail("invalid"); }
}
function validate(value: unknown): asserts value is AppearanceSnapshot {
  if (!object(value) || value.version !== 1 || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 || !object(value.desktop)) fail("invalid");
  const d = (value as AppearanceSnapshot).desktop;
  if (!Array.isArray(d.backgroundRgb) || d.backgroundRgb.length !== 3 || !d.backgroundRgb.every(n => Number.isInteger(n) && n >= 0 && n <= 255) || !Number.isInteger(d.backgroundOpacity) || d.backgroundOpacity < 0 || d.backgroundOpacity > 100 || typeof d.transparentBackground !== "boolean" || (!d.transparentBackground && d.backgroundOpacity !== 100)) fail("invalid");
}
async function snapshot(agentDir: string, file: string): Promise<AppearanceResult> {
  await directories(agentDir, dirname(file), false);
  const bytes = await boundedRead(file, CAP);
  return bytes === undefined ? { status: "missing", snapshot: defaults() } : { status: "ready", snapshot: decode(bytes) };
}
/** No filesystem mutation, defaults only on absence; errors never masquerade as defaults. */
export async function readAppearance(options: AppearanceOptions = {}): Promise<AppearanceResult> {
  if (!supportedPlatform()) return { status: "unsupported-platform" };
  try {
    const agentDir = resolveAppearanceAgentDir(options);
    return await snapshot(agentDir, join(agentDir, "extensions", "gentle-emote", "appearance.json"));
  } catch (error) { return resultError(error); }
}

/** Narrow desktop leaf transaction. Conflicts return fresh truth, never auto-rebase. */
export async function patchDesktopAppearance(options: AppearanceOptions, expectedRevision: number, patch: Partial<DesktopAppearance>): Promise<AppearanceResult> {
  if (!supportedPlatform()) return { status: "unsupported-platform" };
  let outcome: AppearanceResult = { status: "io-error" };
  let lock: string | undefined, lockIdentity: Stats | undefined, ownerIdentity: Stats | undefined;
  let temp: string | undefined, tempIdentity: Stats | undefined;
  let agentDir = "", file = "", committed = false, markerComplete = false;
  const token = randomBytes(16).toString("hex"), record = `v1:${token}\n`;
  async function ownsLock(requireToken = true): Promise<boolean> {
    await directories(agentDir, dirname(file), false);
    const identity = await metadata(lock!);
    if (!identity || !lockIdentity || !same(identity, lockIdentity)) return false;
    safe(identity, true, true);
    const owner = await metadata(join(lock!, "owner"));
    if (!ownerIdentity) return !owner;
    if (!owner || !same(owner, ownerIdentity)) return false;
    return !requireToken || (await boundedRead(join(lock!, "owner"), 36))?.toString("utf8") === record;
  }
  try {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !object(patch) || !Object.keys(patch).length || Object.keys(patch).some(key => !leaves.includes(key))) fail("invalid");
    if (patch.transparentBackground === false && (!Object.prototype.hasOwnProperty.call(patch, "backgroundOpacity") || patch.backgroundOpacity !== 100)) fail("invalid");
    agentDir = resolveAppearanceAgentDir(options); file = join(agentDir, "extensions", "gentle-emote", "appearance.json");
    await directories(agentDir, dirname(file), true);
    lock = `${file}.lock`;
    const start = performance.now();
    for (;;) {
      try { await mkdir(lock, { mode: 0o700 }); lockIdentity = await lstat(lock); safe(lockIdentity, true, true); break; }
      catch (error) {
        if (code(error) !== "EEXIST") throw error;
        const stat = await lstat(lock); safe(stat, true, true);
        if (performance.now() - start >= 1000) fail("busy");
        await delay(Math.min(50, Math.max(1, 1000 - (performance.now() - start))));
      }
    }
    const marker = await open(join(lock, "owner"), "wx", 0o600);
    try { ownerIdentity = await marker.stat(); await marker.writeFile(record); await marker.sync(); markerComplete = true; } finally { await marker.close(); }
    if (!await ownsLock()) fail("unsafe-path");
    const current = (await snapshot(agentDir, file)).snapshot!;
    if (current.revision !== expectedRevision) outcome = { status: "conflict", snapshot: current };
    else if (current.revision === Number.MAX_SAFE_INTEGER) outcome = { status: "revision-exhausted", snapshot: current };
    else {
      const next = { ...current, revision: current.revision + 1, desktop: { ...current.desktop, ...patch } };
      validate(next);
      const bytes = Buffer.from(JSON.stringify(next) + "\n");
      if (bytes.length > CAP) fail("invalid");
      decode(bytes);
      temp = `${file}.${token}.tmp`;
      const handle = await open(temp, "wx", 0o600);
      try { tempIdentity = await handle.stat(); await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await directories(agentDir, dirname(file), false);
      const target = await metadata(file); if (target) safe(target, false, true);
      const temporary = await metadata(temp);
      if (!temporary || !same(temporary, tempIdentity) || !await ownsLock()) fail("unsafe-path");
      safe(temporary, false, true);
      await rename(temp, file); committed = true;
      outcome = { status: "saved", snapshot: next };
      let parent;
      try { parent = await open(dirname(file), constants.O_RDONLY); await parent.sync(); }
      catch (error) {
        if (!["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes(code(error) ?? "")) outcome.status = "committed-durability-uncertain";
      } finally { if (parent) { try { await parent.close(); } catch { outcome.status = "committed-durability-uncertain"; } } }
    }
  } catch (error) { outcome = resultError(error); }
  finally {
    try {
      if (tempIdentity && !committed) {
        await directories(agentDir, dirname(file), false);
        const stat = await metadata(temp!);
        if (!stat || !same(stat, tempIdentity)) throw new Error("temporary identity changed");
        safe(stat, false, true); await unlink(temp!);
      }
    } catch { outcome.cleanupError = true; }
    // Temporary cleanup must never prevent an independent attempt to release our lock.
    try {
      if (lockIdentity) {
        if (!await ownsLock(markerComplete)) throw new Error("lock identity changed");
        if (ownerIdentity) await unlink(join(lock!, "owner"));
        // Verify the directory once more after removing our marker.
        const stat = await metadata(lock!);
        if (!stat || !same(stat, lockIdentity)) throw new Error("lock identity changed");
        await rmdir(lock!);
      }
    } catch { outcome.cleanupError = true; }
  }
  return outcome;
}
