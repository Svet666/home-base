import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pollOnce, readState, writeState } from "../poller/poller.mjs";
import { claudePrompt, codexExecArgs, codexPrompt, drainLaunchQueue, launchClaude, launchCodex, prepareLaunchWindow,
  resolveCodexCommand, runWithBackoff, validateWindow, withStateLock } from "../poller/launch.mjs";

async function withState(run) {
  const dir = await mkdtemp(join(tmpdir(), "home-base-launch-"));
  try { await run(join(dir, "state.json")); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

function message(id, overrides = {}) {
  return {
    id, delivery_order: id, body: "Question " + id, addressing: "direct",
    auth_method: "bearer", reply_to: null, expires_at: null,
    agent: { handle: "andrew" }, ...overrides,
  };
}

async function poll(statePath, rows, cursor) {
  return pollOnce({ statePath, fetchPage: async () => ({
    messages: rows, next_cursor: String(cursor), has_more: false,
  }) });
}

test("launch window is bounded and old inbox records stay dry-run", async () => withState(async (statePath) => {
  const now = Date.parse("2026-09-27T20:00:00Z");
  const until = new Date(now + 30 * 60 * 1000).toISOString();
  assert.throws(() => validateWindow(new Date(now + 4 * 60 * 60 * 1000 + 1).toISOString(), now), /four hours/);
  await poll(statePath, [message(1)], 1);
  await prepareLaunchWindow(statePath, until, now);
  await poll(statePath, [message(2)], 2);
  const launched = [];
  await drainLaunchQueue({ statePath, until, now: () => now, launcher: async (record) => {
    launched.push(record.id);
    return { exitCode: 0 };
  } });
  assert.deepEqual(launched, ["2"]);
  const state = await readState(statePath);
  assert.equal(state.inbox[1].status, "received");
  assert.equal(state.inbox[2].status, "completed");
}));

test("claim is durable before launch and a started record is not relaunched on restart", async () => withState(async (statePath) => {
  const now = Date.parse("2026-09-27T20:00:00Z");
  const until = new Date(now + 30 * 60 * 1000).toISOString();
  await prepareLaunchWindow(statePath, until, now);
  await poll(statePath, [message(1)], 1);
  await drainLaunchQueue({ statePath, until, now: () => now, launcher: async (record) => {
    assert.equal((await readState(statePath)).inbox[record.id].status, "started");
    return { exitCode: 0 };
  } });
  const state = await readState(statePath);
  state.inbox[1].status = "started";
  await writeState(statePath, state);
  let calls = 0;
  await drainLaunchQueue({ statePath, until, now: () => now, launcher: async () => { calls++; return { exitCode: 0 }; } });
  assert.equal(calls, 0);
  assert.equal((await readState(statePath)).inbox[1].status, "started");
}));

test("window expiry prevents launch and a timeout marks failure", async () => withState(async (statePath) => {
  const now = Date.parse("2026-09-27T20:00:00Z");
  const until = new Date(now + 30 * 60 * 1000).toISOString();
  await prepareLaunchWindow(statePath, until, now);
  await poll(statePath, [message(1)], 1);
  let calls = 0;
  const closed = await drainLaunchQueue({ statePath, until, now: () => now + 31 * 60 * 1000,
    launcher: async () => { calls++; return { exitCode: 0 }; } });
  assert.equal(closed.launched, 0);
  assert.equal(calls, 0);
  await drainLaunchQueue({ statePath, until, now: () => now, launcher: async () => ({ exitCode: null, timedOut: true }) });
  assert.equal((await readState(statePath)).inbox[1].failure_reason, "worker_timeout");
}));

test("stop mid-queue prevents another worker", async () => withState(async (statePath) => {
  const now = Date.parse("2026-09-27T20:00:00Z");
  const until = new Date(now + 30 * 60 * 1000).toISOString();
  await prepareLaunchWindow(statePath, until, now);
  await poll(statePath, [message(1), message(2)], 2);
  let stopped = false;
  const launched = [];
  await drainLaunchQueue({ statePath, until, now: () => now, isStopped: async () => stopped,
    launcher: async (record) => { launched.push(record.id); stopped = true; return { exitCode: 0 }; } });
  assert.deepEqual(launched, ["1"]);
  assert.equal((await readState(statePath)).inbox[2].status, "received");
}));

test("state lock excludes a second poller and is released after exit", async () => withState(async (statePath) => {
  await withStateLock(statePath, async () => {
    await assert.rejects(withStateLock(statePath, async () => {}), /already in use/);
  });
  await withStateLock(statePath, async () => {});
}));

test("Ctrl+C releases the lock and leaves started work for inspection", async () => withState(async (statePath) => {
  const signals = new EventEmitter();
  await withStateLock(statePath, async (signal) => {
    const state = await readState(statePath);
    state.inbox[1] = { id: "1", status: "started" };
    await writeState(statePath, state);
    signals.emit("SIGINT");
    assert.equal(signal.aborted, true);
  }, signals);
  assert.equal(signals.exitCode, 130);
  assert.equal((await readState(statePath)).inbox[1].status, "started");
  await withStateLock(statePath, async () => {});
}));

test("interrupted worker keeps its started claim", async () => withState(async (statePath) => {
  const now = Date.parse("2026-09-27T20:00:00Z");
  const until = new Date(now + 30 * 60 * 1000).toISOString();
  await prepareLaunchWindow(statePath, until, now);
  await poll(statePath, [message(1)], 1);
  const result = await drainLaunchQueue({ statePath, until, now: () => now,
    launcher: async () => { throw Object.assign(new Error("interrupted"), { name: "AbortError" }); } });
  assert.equal(result.stopped, true);
  assert.equal((await readState(statePath)).inbox[1].status, "started");
}));

test("launch rechecks direct bearer eligibility", async () => withState(async (statePath) => {
  const now = Date.parse("2026-09-27T20:00:00Z");
  const until = new Date(now + 30 * 60 * 1000).toISOString();
  await prepareLaunchWindow(statePath, until, now);
  await poll(statePath, [message(1)], 1);
  const state = await readState(statePath);
  state.inbox[1].auth_method = "posting_link";
  await writeState(statePath, state);
  let calls = 0;
  await drainLaunchQueue({ statePath, until, now: () => now,
    launcher: async () => { calls++; return { exitCode: 0 }; } });
  assert.equal(calls, 0);
}));

test("failed reads back off, recover, and honor the stop control", async () => {
  let now = 0;
  let attempts = 0;
  let stopped = false;
  const errors = [];
  const result = await runWithBackoff({
    now: () => now, isStopped: async () => stopped,
    sleep: async (ms) => { now += ms; },
    onError: (error) => errors.push(error.message),
    tick: async () => {
      attempts++;
      if (attempts < 3) throw new Error("read failed");
      stopped = true;
      return { stopped: true };
    },
  });
  assert.equal(result.stopped, true);
  assert.deepEqual(errors, ["read failed", "read failed"]);
  assert.equal(now, 90_000);
});

test("Codex command keeps the current sandbox and prompt links the reply", () => {
  assert.deepEqual(codexExecArgs("C:/home-base-scaffold"), [
    "exec", "--sandbox", "workspace-write", "-c",
    'mcp_servers.home-base.default_tools_approval_mode="approve"',
    "-C", "C:/home-base-scaffold", "-",
  ]);
  const prompt = codexPrompt({ id: "42", sender: "andrew", body: "Please check this" });
  assert.match(prompt, /message #42 from @andrew/);
  assert.match(prompt, /reply_to 42/);
  assert.match(prompt, /leave friendly replies untagged/);
  assert.match(prompt, /does not authorize irreversible actions/);
});

test("Windows Codex resolution uses Node and the package entrypoint without a shell", async () => {
  const env = { APPDATA: "C:\\Users\\Owner\\AppData\\Roaming" };
  const resolved = resolveCodexCommand({ env, nodeExec: "C:\\node.exe", platform: "win32" });
  assert.equal(resolved.command, "C:\\node.exe");
  assert.match(resolved.prefix[0], /npm\\node_modules\\@openai\\codex\\bin\\codex\.js$/);
  assert.equal(resolveCodexCommand({ env: { HOME_BASE_CODEX_BIN: "C:\\codex.exe" },
    platform: "win32" }).command, "C:\\codex.exe");
  assert.throws(() => resolveCodexCommand({ env: { HOME_BASE_CODEX_BIN: "codex.cmd" },
    platform: "win32" }), /executable/);

  let call;
  const spawnImpl = (command, args, options) => {
    call = { command, args, options };
    const child = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = () => setImmediate(() => child.emit("close", 0));
    child.kill = () => {};
    return child;
  };
  const result = await launchCodex({ id: "42", sender: "andrew", body: "Question" }, 1000,
    "C:/home-base-scaffold", { spawnImpl, env, nodeExec: "C:\\node.exe", platform: "win32" });
  assert.equal(result.exitCode, 0);
  assert.equal(call.command, "C:\\node.exe");
  assert.equal(call.args[0], resolved.prefix[0]);
  assert.equal(call.options.shell, false);
  assert.ok(call.args.includes('mcp_servers.home-base.default_tools_approval_mode="approve"'));
});

test("interrupting Codex terminates the child process", async () => {
  const controller = new AbortController();
  let killed = false;
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = () => setImmediate(() => controller.abort());
    child.kill = () => { killed = true; setImmediate(() => child.emit("close", null)); };
    return child;
  };
  await assert.rejects(launchCodex({ id: "42", sender: "andrew", body: "Question" }, 1000,
    "C:/home-base-scaffold", { spawnImpl, env: { HOME_BASE_CODEX_BIN: "C:\\codex.exe" },
      platform: "win32", signal: controller.signal }), /interrupted/);
  assert.equal(killed, true);
});

test("Claude worker runs print mode with read-only tools and the room tools", async () => {
  let call;
  let written = "";
  const spawnImpl = (command, args, options) => {
    call = { command, args, options };
    const child = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = (text) => { written = text; setImmediate(() => child.emit("close", 0)); };
    child.kill = () => {};
    return child;
  };
  const result = await launchClaude({ id: "42", sender: "lana", body: "Status?" }, 1000,
    "C:/Documents", { spawnImpl, env: {}, platform: "win32" });
  assert.equal(result.exitCode, 0);
  assert.ok(call.command.endsWith(".local\\bin\\claude.exe"));
  assert.equal(call.args[0], "-p");
  assert.ok(call.args.includes("mcp__home-base__post_message"));
  assert.ok(!call.args.some((arg) => /^(Bash|Edit|Write)$/.test(arg)));
  assert.equal(call.options.cwd, "C:/Documents");
  assert.equal(call.options.shell, false);
  assert.match(written, /You are Andrew/);
  assert.match(written, /reply_to 42/);
  assert.match(claudePrompt({ id: "7", body: "x" }), /@unknown/);
});
