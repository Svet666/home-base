import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pollOnce, readState, runLoop } from "../poller/poller.mjs";

async function withState(run) {
  const dir = await mkdtemp(join(tmpdir(), "home-base-poller-"));
  try { await run(join(dir, "state.json")); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

function message(id, overrides = {}) {
  return {
    id, body: `Message ${id}`, addressing: "direct", auth_method: "bearer",
    reply_to: null, context_preference: null, expires_at: null,
    agent: { handle: "lana" }, ...overrides,
  };
}

test("restart keeps cursor and inbox IDs without duplicate decisions", async () => withState(async (statePath) => {
  const calls = [];
  const fetchPage = async (cursor) => {
    calls.push(cursor);
    return cursor === "0"
      ? { messages: [message(1)], next_cursor: "1", has_more: false }
      : { messages: [message(1), message(2)], next_cursor: "2", has_more: false };
  };
  await pollOnce({ fetchPage, statePath });
  await pollOnce({ fetchPage, statePath });
  const state = await readState(statePath);
  assert.deepEqual(calls, ["0", "1"]);
  assert.deepEqual(Object.keys(state.inbox), ["1", "2"]);
  assert.equal(state.inbox[1].decision, "would_start");
  assert.equal(state.cursor, "2");
}));

test("empty filtered pages still advance and drain", async () => withState(async (statePath) => {
  const calls = [];
  const pages = [
    { messages: [], next_cursor: "10", has_more: true },
    { messages: [], next_cursor: "20", has_more: true },
    { messages: [message(30)], next_cursor: "30", has_more: false },
  ];
  const result = await pollOnce({ statePath, fetchPage: async (cursor) => {
    calls.push(cursor);
    return pages.shift();
  } });
  assert.deepEqual(calls, ["0", "10", "20"]);
  assert.equal(result.pages, 3);
  assert.equal((await readState(statePath)).inbox[30].decision, "would_start");
}));

test("expiry and inbox-only origins do not request a start", async () => withState(async (statePath) => {
  const rows = [
    message(1, { expires_at: "2026-01-01T00:00:00Z" }),
    message(2, { auth_method: "posting_link" }),
    message(3, { addressing: "everyone" }),
    message(4, { auth_method: "legacy" }),
    message(5, { context_preference: "continue" }),
  ];
  await pollOnce({ statePath, now: () => Date.parse("2026-09-27T00:00:00Z"),
    fetchPage: async () => ({ messages: rows, next_cursor: "5", has_more: false }) });
  const { inbox } = await readState(statePath);
  assert.equal(inbox[1].status, "expired");
  assert.equal(inbox[1].reason, "expiry_passed");
  for (const id of [2, 3, 4]) assert.equal(inbox[id].decision, "inbox_only");
  assert.equal(inbox[5].reason, "no_live_session");
}));

test("stop control halts before reading and between pages", async () => withState(async (statePath) => {
  let reads = 0;
  let stopped = true;
  const fetchPage = async () => { reads++; stopped = true; return { messages: [message(1)], next_cursor: "1", has_more: true }; };
  const before = await pollOnce({ statePath, fetchPage, isStopped: async () => stopped });
  assert.equal(before.stopped, true);
  assert.equal(reads, 0);
  stopped = false;
  const during = await pollOnce({ statePath, fetchPage, isStopped: async () => stopped });
  assert.equal(during.stopped, true);
  assert.equal(reads, 1);
  assert.equal((await readState(statePath)).cursor, "0");
}));

test("reply chain stops at its turn cap and survives restart", async () => withState(async (statePath) => {
  const first = [message(1), message(2, { reply_to: 1 })];
  await pollOnce({ statePath, turnCap: 2, fetchPage: async () => ({ messages: first, next_cursor: "2", has_more: false }) });
  await pollOnce({ statePath, turnCap: 2, fetchPage: async () => ({
    messages: [message(3, { reply_to: 2 })], next_cursor: "3", has_more: false,
  }) });
  const { inbox } = await readState(statePath);
  assert.equal(inbox[1].decision, "would_start");
  assert.equal(inbox[2].decision, "would_start");
  assert.equal(inbox[3].decision, "wait");
  assert.equal(inbox[3].reason, "reply_loop_cap");
  assert.equal(inbox[3].root_id, "1");
}));

test("continuous mode enforces the minimum interval", async () => withState(async (statePath) => {
  await assert.rejects(runLoop({ statePath, intervalMs: 1000, isStopped: async () => false,
    fetchPage: async () => { throw new Error("should not read"); }, sleep: async () => {} }), /at least/);
}));

test("a saved cursor cannot be reused for another agent", async () => withState(async (statePath) => {
  const fetchPage = async () => ({ messages: [], next_cursor: "0", has_more: false });
  await pollOnce({ statePath, agentId: "claire-codex", fetchPage });
  await assert.rejects(pollOnce({ statePath, agentId: "andrew", fetchPage }), /different agent/);
}));
