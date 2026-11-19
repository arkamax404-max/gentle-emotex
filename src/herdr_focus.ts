import { execFile as nodeExecFile } from "node:child_process";

// Shared with the future wire parser. The final lookahead rejects trailing newlines too.
export const HERDR_FOCUS_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$(?![\s\S])/;
export const HERDR_FOCUS_HISTORY_LIMIT = 256;
export const HERDR_FOCUS_TIMEOUT_MS = 2000;
export const HERDR_FOCUS_MAX_BUFFER = 4096;

export type HerdrFocusExecFile = (
  file: string,
  args: string[],
  options: { shell: false; windowsHide: true; encoding: "utf8"; timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv },
  callback: (error: Error | null) => void,
) => { kill(): boolean };

export type HerdrFocusResult = "accepted" | "duplicate" | "ignored";
export interface HerdrFocusController {
  readonly enabled: boolean;
  request(id: unknown): HerdrFocusResult;
  dispose(): void;
}

export function createHerdrFocusController(options: {
  env: NodeJS.ProcessEnv;
  execFile?: HerdrFocusExecFile;
  log?: (message: string) => void;
}): HerdrFocusController {
  // Never consult process.env later: each controller belongs to exactly one session.
  const env = { ...options.env };
  const binary = env.HERDR_BIN_PATH;
  const pane = env.HERDR_PANE_ID;
  const socket = env.HERDR_SOCKET_PATH;
  const available = env.HERDR_ENV === "1"
    && typeof pane === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/.test(pane)
    && isAbsoluteLocalPath(binary) && isAbsoluteLocalPath(socket);
  const execFile: HerdrFocusExecFile = options.execFile ?? nodeExecFile;
  // Up to HISTORY_LIMIT remembered IDs plus the two active slots. Evicting a
  // historical entry must never make an active request eligible for replay.
  const history = new Set<string>();
  let disposed = false;
  let pending: string | undefined;
  let running: { id: string; child?: ReturnType<HerdrFocusExecFile> } | undefined;

  function reportFailure() {
    // Do not log errors, stderr, paths, IDs or environment. Logging is best effort.
    try { options.log?.("herdr: focus command failed"); } catch { /* logger unavailable */ }
  }

  function start(id: string) {
    const operation: NonNullable<typeof running> = { id };
    running = operation;
    function complete(error: Error | null) {
      if (disposed || running !== operation) return;
      running = undefined;
      if (error) reportFailure();
      const next = pending;
      pending = undefined;
      if (next !== undefined) start(next);
    }
    try {
      operation.child = execFile(binary!, ["agent", "focus", pane!], {
        shell: false,
        windowsHide: true,
        encoding: "utf8",
        timeout: HERDR_FOCUS_TIMEOUT_MS,
        maxBuffer: HERDR_FOCUS_MAX_BUFFER,
        env: { ...env },
      }, complete);
    } catch {
      complete(new Error("spawn failed"));
    }
  }

  return {
    get enabled() { return available && !disposed; },
    request(id: unknown): HerdrFocusResult {
      if (!available || disposed || typeof id !== "string" || !HERDR_FOCUS_ID_PATTERN.test(id)) return "ignored";
      if (history.has(id) || running?.id === id || pending === id) return "duplicate";
      history.add(id);
      if (history.size > HERDR_FOCUS_HISTORY_LIMIT) history.delete(history.values().next().value!);
      if (running) pending = id; // Only the latest pending click needs a focus.
      else start(id);
      // Receipt, not command success; failures are never retried automatically.
      return "accepted";
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      pending = undefined;
      history.clear();
      const child = running?.child;
      running = undefined;
      try { child?.kill(); } catch { /* already exited or cancellation unavailable */ }
    },
  };
}

function isAbsoluteLocalPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) return false;
  // Accept POSIX paths, drive-qualified Windows paths and UNC/named-pipe paths
  // regardless of the host running tests. Reject drive-relative and rooted-only
  // Windows paths, which still depend on mutable process drive/cwd state.
  return value.startsWith("/") || /^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(value);
}
