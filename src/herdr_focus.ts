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
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => { kill(): boolean };

export type HerdrFocusResult = Promise<boolean>;
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
  type Operation = {
    promise: Promise<boolean>;
    resolve: (success: boolean) => void;
    settled: boolean;
    cancelled: boolean;
    child?: ReturnType<HerdrFocusExecFile>;
  };
  // Remember up to HISTORY_LIMIT settled results, plus the two active slots.
  // Never evict an unresolved promise or make active work eligible for replay.
  const history = new Map<string, Operation>();
  const ignored = Promise.resolve(false);
  let disposed = false;
  let pending: Operation | undefined;
  let running: Operation | undefined;

  function settle(operation: Operation, success: boolean) {
    if (operation.settled) return;
    operation.settled = true;
    operation.resolve(success);
    let settledCount = 0;
    for (const entry of history.values()) if (entry.settled) settledCount++;
    for (const [id, entry] of history) {
      if (settledCount <= HERDR_FOCUS_HISTORY_LIMIT) break;
      if (entry.settled) {
        history.delete(id);
        settledCount--;
      }
    }
  }

  function reportFailure(commandFailed: boolean) {
    // Do not log errors, stdout, stderr, paths, IDs or environment.
    try {
      options.log?.(commandFailed ? "herdr: focus command failed" : "herdr: focus not confirmed");
    } catch { /* logger unavailable */ }
  }

  function kill(child: ReturnType<HerdrFocusExecFile> | undefined) {
    try { child?.kill(); } catch { /* already exited or cancellation unavailable */ }
  }

  function start(operation: Operation) {
    running = operation;
    function complete(error: Error | null, stdout: string) {
      if (disposed || running !== operation || operation.settled) return;
      const success = !error && confirmsFocus(stdout, pane!);
      if (!success) reportFailure(!!error);
      // A best-effort logger may itself dispose the controller.
      if (disposed || running !== operation) return;
      running = undefined;
      settle(operation, success);
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
      // Also cover disposal during a synchronous executor invocation.
      if (operation.cancelled) kill(operation.child);
    } catch {
      complete(new Error("spawn failed"), "");
    }
  }

  return {
    get enabled() { return available && !disposed; },
    request(id: unknown): HerdrFocusResult {
      if (!available || disposed || typeof id !== "string" || !HERDR_FOCUS_ID_PATTERN.test(id)) return ignored;
      const previous = history.get(id);
      if (previous) return previous.promise;
      let resolve!: Operation["resolve"];
      const promise = new Promise<boolean>(done => { resolve = done; });
      const operation: Operation = { promise, resolve, settled: false, cancelled: false };
      history.set(id, operation);
      if (running) {
        const replaced = pending;
        pending = operation; // Only the latest pending click needs a focus.
        if (replaced) settle(replaced, false);
      } else start(operation);
      return promise;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const active = running;
      const queued = pending;
      running = undefined;
      pending = undefined;
      if (active) {
        active.cancelled = true;
        settle(active, false);
        kill(active.child);
      }
      if (queued) settle(queued, false);
      history.clear();
    },
  };
}

function confirmsFocus(stdout: string, pane: string): boolean {
  if (typeof stdout !== "string" || Buffer.byteLength(stdout, "utf8") > HERDR_FOCUS_MAX_BUFFER) return false;
  try {
    const response = JSON.parse(stdout);
    return response?.result?.type === "agent_info"
      && response.result.agent?.pane_id === pane
      && response.result.agent.focused === true;
  } catch {
    return false;
  }
}

function isAbsoluteLocalPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) return false;
  // Accept POSIX paths, drive-qualified Windows paths and UNC/named-pipe paths
  // regardless of the host running tests. Reject drive-relative and rooted-only
  // Windows paths, which still depend on mutable process drive/cwd state.
  return value.startsWith("/") || /^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(value);
}
