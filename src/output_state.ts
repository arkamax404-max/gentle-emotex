import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { agentDir, EXTENSION_NAME } from "./emotes.ts";

export const OUTPUTS = ["internal", "debug", "d200", "display", "usb"] as const;
export type Output = typeof OUTPUTS[number];
export type OutputStates = Record<Output, boolean>;

/**
 * Outputs with a persisted boolean. The D200 key is deliberately absent: both its
 * enabled state and its port are session-local, so `d200.json` is a legacy file
 * that is never read, never warned about and never rewritten.
 */
const PERSISTENT_OUTPUTS: readonly Output[] = OUTPUTS.filter(output => output !== "d200");

/** Global preferences are separate from layered config and from each other. */
export class OutputStateStore {
  private dir: string;

  constructor(root = agentDir()) {
    this.dir = join(root, "extensions", EXTENSION_NAME, "output-states");
  }

  private path(output: Output): string { return join(this.dir, `${output}.json`); }

  private read(output: Output): boolean {
    let text: string;
    try { text = readFileSync(this.path(output), "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return output === "debug";
      throw error;
    }
    const value: unknown = JSON.parse(text);
    if (typeof value !== "boolean") throw new Error(`invalid saved ${output} state`);
    return value;
  }

  load(report: (message: string) => void): OutputStates {
    const states = { internal: false, debug: false, d200: false, display: false, usb: false };
    // The d200 state is session-local: any legacy d200.json is ignored silently.
    for (const output of PERSISTENT_OUTPUTS) {
      try { states[output] = this.read(output); }
      catch { report(`cannot read saved ${output} state; output stays off`); }
    }
    return states;
  }

  save(output: Output, enabled: boolean): void {
    if (output === "d200") throw new Error("the d200 state is session-local and is never saved");
    // Do not silently overwrite corrupt or unreadable preferences.
    this.read(output);
    mkdirSync(this.dir, { recursive: true });
    const temporary = `${this.path(output)}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(enabled)}\n`, { flag: "wx" });
      renameSync(temporary, this.path(output));
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}
