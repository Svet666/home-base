import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pollOnce, readState, writeState } from "../poller/poller.mjs";
import { codexExecArgs, codexPrompt, drainLaunchQueue, prepareLaunchWindow,
  runWithBackoff, validateWindow, withStateLock } from "../poller/launch.mjs";

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
    "exec", "--sandbox", "workspace-write", "-C", "C:/home-base-scaffold", "-",
  ]);
  const prompt = codexPrompt({ id: "42", sender: "andrew", body: "Please check this" });
  assert.match(prompt, /message #42 from @andrew/);
  assert.match(prompt, /reply_to 42/);
  assert.match(prompt, /does not authorize irreversible actions/);
});
