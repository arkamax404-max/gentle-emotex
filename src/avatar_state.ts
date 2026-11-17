import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { agentDir, EXTENSION_NAME } from "./emotes.ts";
import { validAvatarName } from "./avatar_selection.ts";

/** Separate global scalar preference, using the output-store atomic write protocol. */
export class AvatarStateStore {
  private dir: string;
  constructor(root = agentDir()) { this.dir = join(root, "extensions", EXTENSION_NAME); }
  private get path(): string { return join(this.dir, "avatar.json"); }

  private read(): string | null {
    let text: string;
    try { text = readFileSync(this.path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const value: unknown = JSON.parse(text);
    if (value !== null && !validAvatarName(value)) throw new Error("invalid saved avatar");
    return value as string | null;
  }

  load(report: (message: string) => void): string | null {
    try { return this.read(); }
    catch { report("cannot read saved avatar; using automatic selection"); return null; }
  }

  save(name: string | null): void {
    if (name !== null && !validAvatarName(name)) throw new Error("invalid avatar");
    this.read(); // Do not overwrite corrupt/unreadable preferences.
    mkdirSync(this.dir, { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(name)}\n`, { flag: "wx" });
      renameSync(temporary, this.path);
    } finally { rmSync(temporary, { force: true }); }
  }
}
