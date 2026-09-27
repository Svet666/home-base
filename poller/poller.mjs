import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export const MIN_INTERVAL_MS = 15_000;

export async function readState(path) {
  try {
    const state = JSON.parse(await readFile(path, "utf8"));
    if (state.version !== 1 || !/^(0|[1-9][0-9]*)$/.test(state.cursor) ||
        !state.inbox || Array.isArray(state.inbox) || typeof state.inbox !== "object") {
      throw new Error("Invalid poller state file.");
    }
    return state;
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, cursor: "0", inbox: {} };
    throw error;
  }
}

export async function writeState(path, state) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(state, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await rename(temp, path);
}

function recordFor(message, inbox, now, turnCap) {
  const id = String(message.id);
  const parent = message.reply_to == null ? null : String(message.reply_to);
  const root = parent ? (inbox[parent]?.root_id ?? parent) : id;
  const expiry = message.expires_at ? Date.parse(message.expires_at) : null;
  let decision = "inbox_only";
  let reason = "not_direct_bearer";
  let status = "waiting";

  if (message.addressing === "direct" && message.auth_method === "bearer") {
    if (expiry !== null && (!Number.isFinite(expiry) || expiry <= now)) {
      decision = "expired";
      reason = "expiry_passed";
      status = "expired";
    } else if (message.context_preference === "continue") {
      decision = "wait";
      reason = "no_live_session";
    } else {
      const turns = Object.values(inbox).filter((item) => item.root_id === root && item.decision === "would_start").length;
      if (turns >= turnCap) {
        decision = "wait";
        reason = "reply_loop_cap";
      } else {
        decision = "would_start";
        reason = message.context_preference === "fresh" ? "direct_bearer_fresh" : "direct_bearer";
        status = "received";
      }
    }
  }

  return {
    id, root_id: root, reply_to: parent, body: message.body,
    sender: message.agent?.handle ?? message.agent?.slug ?? null,
    addressing: message.addressing, auth_method: message.auth_method,
    context_preference: message.context_preference ?? null,
    expires_at: message.expires_at ?? null,
    observed_at: new Date(now).toISOString(), status, decision, reason,
  };
}

export async function pollOnce({ fetchPage, statePath, agentId, isStopped = async () => false,
  now = () => Date.now(), pageSize = 30, turnCap = 6 }) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error("Page size must be 1-100.");
  if (!Number.isInteger(turnCap) || turnCap < 1) throw new Error("Turn cap must be positive.");
  const state = await readState(statePath);
  if (state.agent_id && agentId && state.agent_id !== agentId) {
    throw new Error("Poller state belongs to a different agent.");
  }
  if (agentId) state.agent_id = agentId;
  let pages = 0;
  let recorded = 0;
  while (true) {
    if (await isStopped()) return { stopped: true, pages, recorded, cursor: state.cursor };
    const page = await fetchPage(state.cursor, pageSize);
    if (await isStopped()) return { stopped: true, pages, recorded, cursor: state.cursor };
    if (!page || !Array.isArray(page.messages) || typeof page.has_more !== "boolean" ||
        !/^[1-9][0-9]*$/.test(String(page.next_cursor ?? "")) && page.next_cursor !== "0") {
      throw new Error("Invalid room page; cursor was not saved.");
    }
    const next = String(page.next_cursor);
    if (BigInt(next) < BigInt(state.cursor) || (page.has_more && BigInt(next) <= BigInt(state.cursor))) {
      throw new Error("Room cursor did not advance; cursor was not saved.");
    }
    for (const message of page.messages) {
      const id = String(message.id);
      if (!/^[1-9][0-9]*$/.test(id)) throw new Error("Invalid message ID; cursor was not saved.");
      if (state.inbox[id]) continue;
      state.inbox[id] = recordFor(message, state.inbox, now(), turnCap);
      recorded++;
    }
    state.cursor = next;
    await writeState(statePath, state);
    pages++;
    if (!page.has_more) return { stopped: false, pages, recorded, cursor: state.cursor };
  }
}

export async function runLoop({ intervalMs = 30_000, isStopped, sleep, ...options }) {
  if (!Number.isInteger(intervalMs) || intervalMs < MIN_INTERVAL_MS) {
    throw new Error(`Poll interval must be at least ${MIN_INTERVAL_MS} ms.`);
  }
  while (!(await isStopped())) {
    const result = await pollOnce({ ...options, isStopped });
    if (result.stopped) return result;
    // Small waits make the stop file responsive without increasing poll frequency.
    for (let remaining = intervalMs; remaining > 0; remaining -= Math.min(remaining, 1000)) {
      if (await isStopped()) return { ...result, stopped: true };
      await sleep(Math.min(remaining, 1000));
    }
  }
  return { stopped: true, pages: 0, recorded: 0 };
}
