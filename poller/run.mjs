#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pollOnce, runLoop } from "./poller.mjs";

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

const options = { fetchPage, statePath, agentId, isStopped, turnCap };
const result = process.argv.includes("--once")
  ? await pollOnce(options)
  : await runLoop({ ...options, intervalMs, sleep: (ms) => new Promise((done) => setTimeout(done, ms)) });
console.log(JSON.stringify(result));
