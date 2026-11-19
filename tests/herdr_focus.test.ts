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

function confirmation(agent = { pane_id: "wD:p1", focused: true }, type = "agent_info") {
  return JSON.stringify({ id: "cli-response", result: { type, agent } });
}

function harness(env = environment()) {
  const calls: Array<{ file: string; args: string[]; options: any; done: (error: Error | null, stdout: string, stderr: string) => void; kills: number }> = [];
  const logs: string[] = [];
  const execFile: HerdrFocusExecFile = (file, args, options, done) => {
    const call = { file, args, options, done, kills: 0 };
    calls.push(call);
    return { kill: () => { call.kills++; return true; } };
  };
  const controller = createHerdrFocusController({ env, execFile, log: message => logs.push(message) });
  return { controller, calls, logs };
}

function finish(call: ReturnType<typeof harness>["calls"][number], error: Error | null = null, stdout = confirmation()) {
  call.done(error, stdout, "private stderr");
}

test("captures local context, uses fixed shell-free argv and waits for CLI confirmation", async () => {
  const env = environment();
  const { controller, calls, logs } = harness(env);
  env.HERDR_BIN_PATH = "/evil";
  env.HERDR_PANE_ID = "other:p2";
  env.HERDR_SOCKET_PATH = "/other.sock";
  env.PATH = "/other";
  assert.equal(controller.enabled, true);
  const result = controller.request("click.1:agent-a_b");
  assert.ok(result instanceof Promise);
  assert.strictEqual(controller.request("click.1:agent-a_b"), result);
  let settled = false;
  void result.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false, "receipt must not imply focus success");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "/opt/herdr");
  assert.deepEqual(calls[0].args, ["agent", "focus", "wD:p1"]);
  assert.deepEqual(calls[0].options, {
    shell: false, windowsHide: true, encoding: "utf8", timeout: 2000,
    maxBuffer: 4096, env: environment(),
  });
  assert.equal(HERDR_FOCUS_TIMEOUT_MS, 2000);
  assert.equal(HERDR_FOCUS_MAX_BUFFER, 4096);
  finish(calls[0]);
  assert.equal(await result, true);
  assert.strictEqual(controller.request("click.1:agent-a_b"), result);
  // Even mutation of a child invocation's env cannot alter later invocations.
  calls[0].options.env.HERDR_PANE_ID = "changed";
  calls[0].options.env.PATH = "/changed";
  const next = controller.request("next");
  assert.deepEqual(calls[1].options.env, environment());
  assert.deepEqual(calls[1].args, ["agent", "focus", "wD:p1"]);
  finish(calls[1]);
  assert.equal(await next, true);
  assert.deepEqual(logs, []);
  controller.dispose();
});

test("accepts absolute Windows binary and named-pipe paths on any test host", async () => {
  const { controller, calls } = harness({ ...environment(), HERDR_BIN_PATH: "C:\\Program Files\\Herdr\\herdr.exe", HERDR_SOCKET_PATH: "\\\\.\\pipe\\herdr" });
  const result = controller.request("a");
  assert.equal(calls[0].file, "C:\\Program Files\\Herdr\\herdr.exe");
  assert.equal(calls[0].options.env.HERDR_SOCKET_PATH, "\\\\.\\pipe\\herdr");
  assert.deepEqual(calls[0].args, ["agent", "focus", "wD:p1"]);
  finish(calls[0]);
  assert.equal(await result, true);
  controller.dispose();
});

test("missing or malformed local context is inert without throwing", async () => {
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
    assert.equal(await controller.request("valid"), false);
    controller.dispose();
    assert.equal(calls.length, 0);
    assert.deepEqual(logs, []);
  }
});

test("IDs use the bounded ASCII grammar; rejected inputs leave dedup and execution unchanged", async () => {
  const { controller, calls, logs } = harness();
  for (const id of ["", "a".repeat(129), "a\n", "a b", "a/b", "a;cmd", "é", "a\0", undefined, null, 1, {}]) {
    if (typeof id === "string") assert.equal(HERDR_FOCUS_ID_PATTERN.test(id), false);
    assert.equal(await controller.request(id), false);
  }
  assert.equal(calls.length, 0);
  const result = controller.request("a".repeat(128));
  finish(calls[0]);
  assert.equal(await result, true);
  assert.strictEqual(controller.request("a".repeat(128)), result);
  assert.equal(calls.length, 1);
  assert.deepEqual(logs, []);
  controller.dispose();
});

test("only strict focused true for the captured pane and agent_info confirms success", async () => {
  const { controller, calls, logs } = harness();
  const invalid = [
    "", "not JSON", "{}", "null", "[]", "true", "{", "{}\n{}",
    JSON.stringify({ result: null }), JSON.stringify({ result: { type: "agent_info" } }),
    JSON.stringify({ result: { type: "agent_info", agent: null } }),
    JSON.stringify({ result: { agent: { pane_id: "wD:p1", focused: true } } }),
    confirmation({ pane_id: "other:p2", focused: true }),
    confirmation({ pane_id: "wD:p1", focused: true }, "other"),
    ...[false, "true", 1, null, undefined].map(focused => JSON.stringify({ result: { type: "agent_info", agent: { pane_id: "wD:p1", focused } } })),
    JSON.stringify({ result: { type: "agent_info", agent: { focused: true } } }),
    confirmation({ pane_id: "wD:p1\n", focused: true }),
    confirmation() + " ".repeat(HERDR_FOCUS_MAX_BUFFER),
    JSON.stringify({ result: { type: "agent_info", agent: { pane_id: "wD:p1", focused: true } }, padding: "é".repeat(2100) }),
  ];
  for (const [i, stdout] of invalid.entries()) {
    const result = controller.request(`invalid-${i}`);
    finish(calls.at(-1)!, null, stdout);
    assert.equal(await result, false, `invalid output ${i}`);
    assert.strictEqual(controller.request(`invalid-${i}`), result);
    assert.equal(calls.length, i + 1, "unconfirmed output cannot retry");
  }
  assert.deepEqual(logs, Array(invalid.length).fill("herdr: focus not confirmed"));
  const malicious = JSON.stringify({ id: "evil;execute", result: { type: "agent_info", agent: { pane_id: "wD:p1", focused: true, command: "evil" } }, executable: "/evil", args: ["--shell"] });
  const accepted = controller.request("valid");
  finish(calls.at(-1)!, null, malicious);
  assert.equal(await accepted, true);
  const next = controller.request("after-payload");
  assert.equal(calls.at(-1)!.file, "/opt/herdr");
  assert.deepEqual(calls.at(-1)!.args, ["agent", "focus", "wD:p1"]);
  const bounded = confirmation() + " ".repeat(HERDR_FOCUS_MAX_BUFFER - Buffer.byteLength(confirmation()));
  finish(calls.at(-1)!, null, bounded);
  assert.equal(await next, true, "exactly 4096 bytes is allowed");
  controller.dispose();
});

test("duplicates share outcomes; replaced pending resolves false and cannot resurrect", async () => {
  const { controller, calls } = harness();
  const one = controller.request("one");
  assert.strictEqual(controller.request("one"), one);
  const two = controller.request("two");
  assert.strictEqual(controller.request("two"), two);
  const three = controller.request("three");
  assert.equal(await two, false);
  assert.strictEqual(controller.request("two"), two);
  assert.strictEqual(controller.request("three"), three);
  assert.equal(calls.length, 1);
  finish(calls[0]);
  assert.equal(await one, true);
  assert.equal(calls.length, 2);
  finish(calls[0]); // Repeated callbacks cannot release the second child.
  const four = controller.request("four");
  assert.equal(calls.length, 2);
  finish(calls[1]);
  assert.equal(await three, true);
  assert.equal(calls.length, 3);
  finish(calls[2]);
  assert.equal(await four, true);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.kills === 0));
  controller.dispose();
});

test("settled success and failure history is bounded FIFO; active promises stay protected", async () => {
  const { controller, calls } = harness();
  assert.equal(HERDR_FOCUS_HISTORY_LIMIT, 256);
  for (let i = 0; i < HERDR_FOCUS_HISTORY_LIMIT; i++) {
    const result = controller.request(`history-${i}`);
    finish(calls.at(-1)!, null, i % 2 ? "{}" : confirmation());
    assert.equal(await result, i % 2 === 0);
    assert.strictEqual(controller.request(`history-${i}`), result);
  }
  const running = controller.request("running");
  const replaced: Promise<boolean>[] = [];
  for (let i = 0; i <= HERDR_FOCUS_HISTORY_LIMIT; i++) replaced.push(controller.request(`pending-${i}`));
  assert.deepEqual(await Promise.all(replaced.slice(0, -1)), Array(HERDR_FOCUS_HISTORY_LIMIT).fill(false));
  assert.strictEqual(controller.request("running"), running);
  assert.strictEqual(controller.request(`pending-${HERDR_FOCUS_HISTORY_LIMIT}`), replaced.at(-1));
  assert.strictEqual(controller.request("pending-0"), replaced[0], "256 settled plus two active slots fit");
  assert.equal(calls.length, HERDR_FOCUS_HISTORY_LIMIT + 1);
  finish(calls.at(-1)!);
  assert.equal(await running, true);
  finish(calls.at(-1)!);
  assert.equal(await replaced.at(-1), true);
  const oldSuccess = controller.request("history-0");
  finish(calls.at(-1)!);
  assert.equal(await oldSuccess, true, "old success was evicted");
  const oldFailure = controller.request("history-1");
  finish(calls.at(-1)!);
  assert.equal(await oldFailure, true, "old failure was evicted");
  assert.equal(calls.length, HERDR_FOCUS_HISTORY_LIMIT + 4);
  controller.dispose();
});

test("command failure, timeout and output-limit errors are false despite valid JSON, with no retries", async () => {
  const { controller, calls, logs } = harness();
  const secret = "secret socket /private/path stderr";
  for (const code of ["ENOENT", "ETIMEDOUT", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"]) {
    const id = `failure-${code}`;
    const failed = controller.request(id);
    const pending = controller.request(`${id}-pending`);
    finish(calls.at(-1)!, Object.assign(new Error(secret.repeat(100)), { code, killed: true }));
    assert.equal(await failed, false);
    assert.strictEqual(controller.request(id), failed);
    finish(calls.at(-1)!);
    assert.equal(await pending, true);
  }
  assert.equal(calls.length, 6);
  assert.deepEqual(logs, Array(3).fill("herdr: focus command failed"));
  controller.dispose();
});

test("synchronous spawn and logger errors are contained and failed IDs never retry", async () => {
  let attempts = 0;
  const controller = createHerdrFocusController({
    env: environment(),
    execFile: () => { attempts++; throw new Error("private executable path"); },
    log: () => { throw new Error("logger failed"); },
  });
  const one = controller.request("one");
  assert.equal(await one, false);
  assert.strictEqual(controller.request("one"), one);
  assert.equal(await controller.request("two"), false);
  assert.equal(attempts, 2);
  controller.dispose();
});

test("dispose resolves running and pending false, kills once and ignores late success", async () => {
  const { controller, calls, logs } = harness();
  const one = controller.request("one");
  const two = controller.request("two");
  controller.dispose();
  controller.dispose();
  assert.deepEqual(await Promise.all([one, two]), [false, false]);
  assert.equal(controller.enabled, false);
  assert.equal(calls[0].kills, 1);
  finish(calls[0], new Error("late failure"));
  finish(calls[0]);
  assert.equal(await controller.request("three"), false);
  assert.equal(await controller.request("one"), false);
  assert.equal(calls.length, 1);
  assert.deepEqual(logs, []);
});

test("synchronous callbacks leave no phantom running work, even if the wrapper then throws", async () => {
  let calls = 0;
  const controller = createHerdrFocusController({ env: environment(), execFile: (_file, _args, _options, done) => {
    calls++;
    done(null, confirmation(), "");
    if (calls === 1) throw new Error("wrapper threw after completion");
    return { kill: () => { throw new Error("must not kill completed child"); } };
  } });
  const one = controller.request("one");
  assert.equal(await one, true);
  assert.strictEqual(controller.request("one"), one);
  assert.equal(await controller.request("two"), true);
  assert.equal(calls, 2);
  controller.dispose();
  const throwing = createHerdrFocusController({ env: environment(), execFile: () => ({ kill: () => { throw new Error("already exited"); } }) });
  const pending = throwing.request("one");
  assert.doesNotThrow(() => throwing.dispose());
  assert.equal(await pending, false);
});
