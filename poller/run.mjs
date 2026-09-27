#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pollOnce, readState } from "./poller.mjs";
import { drainLaunchQueue, launchCodex, MAX_WINDOW_MS, prepareLaunchWindow,
  runWithBackoff, validateWindow, withStateLock } from "./launch.mjs";

function fileSettings(path) {
  if (!path) return {};
  return Object.fromEntries(readFileSync(path, "utf8").split(/\r?\n/)
    .filter((line) => line.includes("=") && !line.startsWith("#"))
    .map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at).trim(), line.slice(at + 1).trim().replace(/^"|"$/g, "")];
    }));
}

const settings = fileSettings(process.env.HOME_BASE_ENV_FILE);
const setting = (key) => process.env[key] || settings[key];
const baseUrl = (setting("HOME_BASE_URL") || "https://home-base-blue.vercel.app").replace(/\/$/, "");
const agentId = setting("HOME_BASE_AGENT_ID");
const token = setting("HOME_BASE_AGENT_TOKEN");
if (!agentId || !token) throw new Error("Set HOME_BASE_ENV_FILE to this host's credential file.");

const statePath = resolve(process.env.HOME_BASE_POLLER_STATE || ".home-base-poller/state.json");
const stopPath = resolve(process.env.HOME_BASE_POLLER_STOP || ".home-base-poller/STOP");
const intervalMs = Number(process.env.HOME_BASE_POLLER_INTERVAL_MS || 30_000);
const turnCap = Number(process.env.HOME_BASE_POLLER_TURN_CAP || 6);
const isStopped = async () => existsSync(stopPath);
const fetchPage = async (afterId, limit) => {
  const query = new URLSearchParams({ after_id: afterId, limit: String(limit), for_me: "true", agent_id: agentId });
  const response = await fetch(`${baseUrl}/api/messages?${query}`, {
    headers: { authorization: `Bearer ${token}` }, cache: "no-store",
  });
  const page = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Room read failed (${response.status}): ${page.error || "unknown error"}`);
  return page;
};

const fetchParent = async (parentId, child) => {
  let before = String(child.delivery_order ?? "");
  if (!/^[1-9][0-9]*$/.test(before)) throw new Error("Reply is missing its delivery order.");
  while (true) {
    if (await isStopped()) return null;
    const query = new URLSearchParams({ before_id: before, limit: "100" });
    const response = await fetch(`${baseUrl}/api/messages?${query}`, { cache: "no-store" });
    const page = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Room history read failed (${response.status}): ${page.error || "unknown error"}`);
    if (!Array.isArray(page.messages)) throw new Error("Invalid room history page.");
    const found = page.messages.find((row) => String(row.id) === parentId);
    if (found) return found;
    if (!page.has_more) return null;
    const next = String(page.older_cursor ?? "");
    if (!/^[1-9][0-9]*$/.test(next) || BigInt(next) >= BigInt(before)) {
      throw new Error("Room history cursor did not advance.");
    }
    before = next;
  }
};

const options = { fetchPage, fetchParent, statePath, agentId, isStopped, turnCap };
const args = process.argv.slice(2);
const launch = args.includes("--launch");
const once = args.includes("--once");
const untilIndex = args.indexOf("--until");
if (launch && once) throw new Error("Use continuous mode with --launch.");
if (launch !== (untilIndex >= 0) || (untilIndex >= 0 && !args[untilIndex + 1])) {
  throw new Error("--launch requires --until <ISO timestamp>.");
}
const until = launch ? validateWindow(args[untilIndex + 1]) : null;
const workerTimeoutMs = Number(process.env.HOME_BASE_POLLER_WORKER_TIMEOUT_MS || 10 * 60 * 1000);
if (!Number.isInteger(workerTimeoutMs) || workerTimeoutMs < 1000 || workerTimeoutMs > MAX_WINDOW_MS) {
  throw new Error("Worker timeout must be between one second and four hours.");
}
const workspace = resolve(process.env.HOME_BASE_CODEX_WORKSPACE || process.cwd());
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const onError = (error) => console.error("Poller tick failed: " + error.message);

async function main() {
  if (launch) {
    const state = await readState(statePath);
    let ready = state.launch_window?.until === until;
    if (ready) {
      console.log(JSON.stringify({ launch_ready: true, until, after_cursor: state.launch_window.after_cursor }));
    }
    return runWithBackoff({
      isStopped, sleep, intervalMs, until, onError,
      tick: async () => {
        const polled = await pollOnce(options);
        if (polled.stopped) return polled;
        if (!ready) {
          const window = await prepareLaunchWindow(statePath, until);
          ready = true;
          console.log(JSON.stringify({ launch_ready: true, until, after_cursor: window.after_cursor }));
          return polled;
        }
        const queue = await drainLaunchQueue({
          statePath, until, isStopped, timeoutMs: workerTimeoutMs,
          launcher: (record, timeout) => launchCodex(record, timeout, workspace),
        });
        return { ...polled, ...queue };
      },
    });
  }
  if (once) return pollOnce(options);
  return runWithBackoff({ isStopped, sleep, intervalMs, onError, tick: () => pollOnce(options) });
}

console.log(JSON.stringify(await withStateLock(statePath, main)));
