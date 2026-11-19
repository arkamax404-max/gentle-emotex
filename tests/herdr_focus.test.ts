import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createHerdrFocusController, HERDR_FOCUS_ID_PATTERN, HERDR_FOCUS_HISTORY_LIMIT,
  HERDR_FOCUS_TIMEOUT_MS, HERDR_FOCUS_MAX_BUFFER,
} from "../src/herdr_focus.ts";
import type { HerdrFocusExecFile } from "../src/herdr_focus.ts";

function environment(): NodeJS.ProcessEnv {
  return { HERDR_ENV: "1", HERDR_PANE_ID: "wD:p1", HERDR_BIN_PATH: "/opt/herdr", HERDR_SOCKET_PATH: "/tmp/herdr.sock", PATH: "/usr/bin" };
}

function harness(env = environment()) {
  const calls: Array<{ file: string; args: string[]; options: any; done: (error: Error | null) => void; kills: number }> = [];
  const logs: string[] = [];
  const execFile: HerdrFocusExecFile = (file, args, options, done) => {
    const call = { file, args, options, done, kills: 0 };
    calls.push(call);
    return { kill: () => { call.kills++; return true; } };
  };
  const controller = createHerdrFocusController({ env, execFile, log: message => logs.push(message) });
  return { controller, calls, logs };
}

function finish(call: ReturnType<typeof harness>["calls"][number], error: Error | null = null) {
  call.done(error);
}

test("captures the local executable, pane and environment; only invokes shell-free Herdr focus", () => {
  const env = environment();
  const { controller, calls, logs } = harness(env);
  env.HERDR_BIN_PATH = "/evil";
  env.HERDR_PANE_ID = "other:p2";
  env.HERDR_SOCKET_PATH = "/other.sock";
  env.PATH = "/other";
  assert.equal(controller.enabled, true);
  assert.equal(controller.request("click.1:agent-a_b"), "accepted");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "/opt/herdr");
  assert.deepEqual(calls[0].args, ["agent", "focus", "wD:p1"]);
  assert.deepEqual(calls[0].options, {
    shell: false, windowsHide: true, encoding: "utf8", timeout: HERDR_FOCUS_TIMEOUT_MS,
    maxBuffer: HERDR_FOCUS_MAX_BUFFER, env: environment(),
  });
  assert.ok(HERDR_FOCUS_TIMEOUT_MS > 0 && HERDR_FOCUS_TIMEOUT_MS <= 5000);
  assert.ok(HERDR_FOCUS_MAX_BUFFER > 0 && HERDR_FOCUS_MAX_BUFFER <= 16384);
  finish(calls[0]);
  assert.deepEqual(logs, []);
  controller.dispose();
});

test("accepts absolute Windows binary and named-pipe paths on any test host", () => {
  const { controller, calls } = harness({ ...environment(), HERDR_BIN_PATH: "C:\\Program Files\\Herdr\\herdr.exe", HERDR_SOCKET_PATH: "\\\\.\\pipe\\herdr" });
  assert.equal(controller.request("a"), "accepted");
  assert.equal(calls[0].file, "C:\\Program Files\\Herdr\\herdr.exe");
  assert.equal(calls[0].options.env.HERDR_SOCKET_PATH, "\\\\.\\pipe\\herdr");
  assert.deepEqual(calls[0].args, ["agent", "focus", "wD:p1"]);
  controller.dispose();
});

test("missing or malformed local context is inert without throwing", () => {
  const invalid = [
    {}, ...Object.keys(environment()).filter(key => key.startsWith("HERDR_")).map(key => ({ ...environment(), [key]: undefined })),
    ...["", "0", "true"].map(HERDR_ENV => ({ ...environment(), HERDR_ENV })),
    ...["", "-p1", "wD:p1;evil", "wD:p1\n", "a".repeat(129)].map(HERDR_PANE_ID => ({ ...environment(), HERDR_PANE_ID })),
    ...["herdr", "./herdr", "C:herdr.exe", "\\herdr.exe", "/bin/herdr\0", " "].map(HERDR_BIN_PATH => ({ ...environment(), HERDR_BIN_PATH })),
    ...["", "relative.sock", "/tmp/sock\n", " "].map(HERDR_SOCKET_PATH => ({ ...environment(), HERDR_SOCKET_PATH })),
  ];
  for (const env of invalid) {
    const { controller, calls, logs } = harness(env);
    assert.equal(controller.enabled, false, JSON.stringify(env));
    assert.equal(controller.request("valid"), "ignored");
    controller.dispose();
    assert.equal(calls.length, 0);
    assert.deepEqual(logs, []);
  }
});

test("IDs use the exported bounded ASCII grammar and rejected inputs leave dedup and execution unchanged", () => {
  const { controller, calls, logs } = harness();
  for (const id of ["", "a".repeat(129), "a\n", "a b", "a/b", "a;cmd", "é", "a\0", undefined, null, 1, {}]) {
    if (typeof id === "string") assert.equal(HERDR_FOCUS_ID_PATTERN.test(id), false);
    assert.equal(controller.request(id), "ignored");
  }
  assert.equal(calls.length, 0);
  assert.equal(controller.request("a".repeat(128)), "accepted");
  finish(calls[0]);
  assert.equal(controller.request("a".repeat(128)), "duplicate");
  assert.equal(calls.length, 1);
  assert.deepEqual(logs, []);
  controller.dispose();
});

test("deduplicates running, pending and coalesced requests with only one running and one pending focus", () => {
  const { controller, calls } = harness();
  assert.equal(controller.request("one"), "accepted");
  assert.equal(controller.request("one"), "duplicate");
  assert.equal(controller.request("two"), "accepted");
  assert.equal(controller.request("two"), "duplicate");
  assert.equal(controller.request("three"), "accepted");
  assert.equal(controller.request("two"), "duplicate");
  assert.equal(calls.length, 1);
  finish(calls[0]);
  assert.equal(calls.length, 2);
  finish(calls[0]); // A repeated/late callback must not release the second child.
  assert.equal(controller.request("four"), "accepted");
  assert.equal(calls.length, 2);
  finish(calls[1]);
  assert.equal(calls.length, 3);
  finish(calls[2]);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.kills === 0));
  controller.dispose();
});

test("dedup history is bounded FIFO while active work stays protected from eviction", () => {
  const { controller, calls } = harness();
  assert.ok(HERDR_FOCUS_HISTORY_LIMIT >= 2 && HERDR_FOCUS_HISTORY_LIMIT <= 1024);
  controller.request("running");
  for (let i = 0; i < HERDR_FOCUS_HISTORY_LIMIT + 1; i++) controller.request(`id-${i}`);
  assert.equal(controller.request("running"), "duplicate");
  assert.equal(controller.request(`id-${HERDR_FOCUS_HISTORY_LIMIT}`), "duplicate");
  finish(calls[0]);
  finish(calls[1]);
  assert.equal(controller.request("id-0"), "accepted", "old coalesced IDs eventually expire");
  finish(calls[2]);
  assert.equal(controller.request("id-0"), "duplicate");
  controller.dispose();
});

test("failures including timeout/output-limit errors log only fixed bounded text, never retry, and drain pending", () => {
  const { controller, calls, logs } = harness();
  const secret = "secret socket /private/path stderr";
  for (const code of ["ENOENT", "ETIMEDOUT", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"]) {
    const id = `failure-${code}`;
    controller.request(id);
    controller.request(`${id}-pending`);
    const call = calls.at(-1)!;
    finish(call, Object.assign(new Error(secret.repeat(100)), { code, killed: true }));
    assert.equal(controller.request(id), "duplicate");
    finish(calls.at(-1)!);
  }
  assert.equal(calls.length, 6);
  assert.deepEqual(logs, Array(3).fill("herdr: focus command failed"));
  controller.dispose();
});

test("synchronous spawn and logger errors are contained; accepted means receipt, not focus success", () => {
  let attempts = 0;
  const controller = createHerdrFocusController({
    env: environment(),
    execFile: () => { attempts++; throw new Error("private executable path"); },
    log: () => { throw new Error("logger failed"); },
  });
  assert.equal(controller.request("one"), "accepted");
  assert.equal(controller.request("one"), "duplicate");
  assert.equal(controller.request("two"), "accepted");
  assert.equal(attempts, 2);
  controller.dispose();
});

test("dispose cancels once, drops pending and ignores all late callbacks and future requests", () => {
  const { controller, calls, logs } = harness();
  controller.request("one");
  controller.request("two");
  controller.dispose();
  controller.dispose();
  assert.equal(controller.enabled, false);
  assert.equal(calls[0].kills, 1);
  finish(calls[0], new Error("late failure"));
  finish(calls[0]);
  assert.equal(controller.request("three"), "ignored");
  assert.equal(controller.request("one"), "ignored");
  assert.equal(calls.length, 1);
  assert.deepEqual(logs, []);
});

test("disposal contains kill errors and synchronous completion does not leave phantom running work", () => {
  let calls = 0;
  const controller = createHerdrFocusController({ env: environment(), execFile: (_file, _args, _options, done) => {
    calls++;
    done(null);
    return { kill: () => { throw new Error("must not kill completed child"); } };
  } });
  assert.equal(controller.request("one"), "accepted");
  assert.equal(controller.request("two"), "accepted");
  assert.equal(calls, 2);
  controller.dispose();
  const throwing = createHerdrFocusController({ env: environment(), execFile: () => ({ kill: () => { throw new Error("already exited"); } }) });
  throwing.request("one");
  assert.doesNotThrow(() => throwing.dispose());
});
