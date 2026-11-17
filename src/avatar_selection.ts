import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { agentDir, EXTENSION_NAME } from "./emotes.ts";
import { EMOTE_STATES } from "./types.ts";
import { decodePng } from "./png.ts";

/** Only an immediate folder name; auto is reserved for the mapping reset. */
export function validAvatarName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value &&
    value !== "auto" && value !== "." && value !== ".." &&
    !/[/\\:\u0000-\u001f\u007f-\u009f]/.test(value);
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

function roots(extDir: string, cwd: string): string[] {
  return [join(cwd, ".pi", "extensions", EXTENSION_NAME, "emotes"),
    join(agentDir(), "extensions", EXTENSION_NAME, "emotes"), join(extDir, "emotes")];
}

/** Validate precisely the files existing loaders read, without changing shared discovery.
 * Checks precede synchronous loading; concurrent filesystem replacement is not locked.
 */
function checkedDirectory(root: string, candidate: string, policy: "manual" | "automatic-partial"): string | null {
  try {
    // The emotes tree itself cannot be substituted with a symlink/junction.
    const rootStat = lstatSync(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return null;
    const realRoot = realpathSync(root);
    if (!within(realpathSync(join(root, "..")), realRoot)) return null;
    const dir = realpathSync(candidate);
    if (!within(realRoot, dir) || !statSync(dir).isDirectory()) return null;
    const checked = (path: string, directory = false) => {
      if (!within(realRoot, realpathSync(path))) throw new Error("avatar path escapes emotes");
      const stat = statSync(path);
      if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error("invalid avatar entry");
    };
    for (const file of ["emotes.json", "ascii.yaml"]) {
      const path = join(dir, file);
      if (existsSync(path) || (() => { try { lstatSync(path); return true; } catch { return false; } })()) checked(path);
    }
    let idle = false;
    let usableFrame = false;
    for (const state of EMOTE_STATES) {
      const stateDir = join(dir, state);
      try { lstatSync(stateDir); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      checked(stateDir, true);
      for (const file of readdirSync(stateDir).filter(file => file.endsWith(".png"))) {
        const path = join(stateDir, file); checked(path);
        decodePng(readFileSync(path));
        if (!file.startsWith("fail")) {
          usableFrame = true;
          if (state === "idle") idle = true;
        }
      }
    }
    if (idle || (policy === "automatic-partial" && usableFrame)) return candidate;
    const ascii = join(dir, "ascii.yaml");
    return existsSync(ascii) && /^idle:\s*\S/m.test(readFileSync(ascii, "utf8")) ? candidate : null;
  } catch { return null; }
}

/** First existing layer owns the name, even when unsafe/unusable: no silent shadow fallback.
 * Manual selection requires idle; automatic twins may supply only other usable PNG states.
 * Both policies validate the same roots, configuration, state directories and frame files.
 */
export function findAvatar(name: string, extDir: string, cwd: string, policy: "manual" | "automatic-partial" = "manual"): string | null {
  if (!validAvatarName(name)) return null;
  for (const root of roots(extDir, cwd)) {
    const path = join(root, name);
    try { lstatSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return null;
    }
    return checkedDirectory(root, path, policy);
  }
  return null;
}

export function avatarNames(extDir: string, cwd: string): string[] {
  const names = new Set<string>();
  for (const root of roots(extDir, cwd)) {
    try { for (const name of readdirSync(root)) if (validAvatarName(name)) names.add(name); } catch { /* absent layer */ }
  }
  return [...names].sort().filter(name => findAvatar(name, extDir, cwd) !== null);
}
