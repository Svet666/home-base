import { spawn } from "node:child_process";
import { mkdir, open, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, win32 } from "node:path";
import { readState, writeState, MIN_INTERVAL_MS } from "./poller.mjs";

export const MAX_WINDOW_MS = 4 * 60 * 60 * 1000;
export const MAX_BACKOFF_MS = 5 * 60 * 1000;

export async function withStateLock(statePath, run, signalSource = process) {
  const lockPath = statePath + ".lock";
  await mkdir(dirname(statePath), { recursive: true });
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("Poller state is already in use; check the running process before removing its lock.");
    throw error;
  }
  const controller = new AbortController();
  const interrupt = () => { signalSource.exitCode = 130; controller.abort(); };
  const terminate = () => { signalSource.exitCode = 143; controller.abort(); };
  signalSource.on("SIGINT", interrupt);
  signalSource.on("SIGTERM", terminate);
  try {
    await handle.writeFile(String(process.pid));
    return await run(controller.signal);
  } finally {
    await handle.close();
    await unlink(lockPath);
    signalSource.off("SIGINT", interrupt);
    signalSource.off("SIGTERM", terminate);
  }
}

export function validateWindow(until, now = Date.now()) {
  const end = Date.parse(until);
  if (!Number.isFinite(end) || end <= now || end - now > MAX_WINDOW_MS) {
    throw new Error("Launch window must end within the next four hours.");
  }
  return new Date(end).toISOString();
}

export async function prepareLaunchWindow(statePath, until, now = Date.now()) {
  const end = validateWindow(until, now);
  const state = await readState(statePath);
  if (state.launch_window?.until === end) return state.launch_window;
  state.launch_window = { until: end, after_cursor: state.cursor };
  await writeState(statePath, state);
  return state.launch_window;
}

export async function drainLaunchQueue({ statePath, until, launcher, isStopped = async () => false,
  now = () => Date.now(), timeoutMs = 10 * 60 * 1000 }) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) throw new Error("Worker timeout must be at least one second.");
  const state = await readState(statePath);
  const end = new Date(until).toISOString();
  if (state.launch_window?.until !== end) throw new Error("Launch window is not initialized.");
  if (now() >= Date.parse(end)) return { launched: 0, window_closed: true };
  const after = BigInt(state.launch_window.after_cursor);
  let launched = 0;
  const queue = Object.values(state.inbox).sort((a, b) =>
    BigInt(a.delivery_order || 0) < BigInt(b.delivery_order || 0) ? -1 : 1);
  for (const record of queue) {
    if (record.decision !== "would_start" || record.status !== "received" ||
        record.addressing !== "direct" || record.auth_method !== "bearer" ||
        !/^[1-9][0-9]*$/.test(String(record.delivery_order ?? "")) ||
        BigInt(record.delivery_order) <= after) continue;
    if (await isStopped() || now() >= Date.parse(end)) break;
    if (record.expires_at && (!Number.isFinite(Date.parse(record.expires_at)) ||
        Date.parse(record.expires_at) <= now())) {
      record.status = "expired";
      record.decision = "expired";
      record.reason = "expiry_passed_before_launch";
      await writeState(statePath, state);
      continue;
    }
    record.status = "started";
    record.started_at = new Date(now()).toISOString();
    await writeState(statePath, state);
    if (await isStopped() || now() >= Date.parse(end)) {
      record.status = "received";
      delete record.started_at;
      await writeState(statePath, state);
      break;
    }
    launched++;
    try {
      const result = await launcher(record, timeoutMs);
      record.exit_code = result.exitCode;
      record.timed_out = Boolean(result.timedOut);
      record.status = result.exitCode === 0 && !result.timedOut ? "completed" : "failed";
      if (record.status === "failed") record.failure_reason = result.timedOut ? "worker_timeout" : "worker_exit";
    } catch (error) {
      if (error.name === "AbortError") return { launched, stopped: true };
      record.exit_code = null;
      record.status = "failed";
      record.failure_reason = "launch_error";
    }
    record.finished_at = new Date(now()).toISOString();
    await writeState(statePath, state);
  }
  return { launched };
}

async function pause(ms, { sleep, isStopped, now, end }) {
  for (let remaining = ms; remaining > 0; remaining -= Math.min(remaining, 1000)) {
    if (await isStopped() || (end !== null && now() >= end)) return false;
    await sleep(Math.min(remaining, 1000));
  }
  return true;
}

export async function runWithBackoff({ tick, isStopped, sleep, intervalMs = 30_000,
  now = () => Date.now(), until = null, onError = () => {} }) {
  if (!Number.isInteger(intervalMs) || intervalMs < MIN_INTERVAL_MS) {
    throw new Error("Poll interval must be at least 15000 ms.");
  }
  const end = until === null ? null : Date.parse(validateWindow(until, now()));
  let backoffMs = 30_000;
  while (!(await isStopped()) && (end === null || now() < end)) {
    let result;
    try {
      result = await tick();
      backoffMs = 30_000;
    } catch (error) {
      onError(error);
      if (!(await pause(backoffMs, { sleep, isStopped, now, end }))) break;
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      continue;
    }
    if (result?.stopped) return result;
    if (!(await pause(intervalMs, { sleep, isStopped, now, end }))) break;
  }
  return { stopped: await isStopped(), window_closed: end !== null && now() >= end };
}

export function codexExecArgs(workspace) {
  return ["exec", "--sandbox", "workspace-write", "-c",
    'mcp_servers.home-base.default_tools_approval_mode="approve"', "-C", workspace, "-"];
}

export function resolveCodexCommand({ env = process.env, nodeExec = process.execPath,
  platform = process.platform } = {}) {
  if (env.HOME_BASE_CODEX_BIN) {
    if (platform === "win32" && /\.(cmd|bat)$/i.test(env.HOME_BASE_CODEX_BIN)) {
      throw new Error("HOME_BASE_CODEX_BIN must name an executable, not a command shim.");
    }
    return { command: env.HOME_BASE_CODEX_BIN, prefix: [] };
  }
  if (platform === "win32") {
    if (!env.APPDATA) throw new Error("APPDATA is required to find the Codex npm package.");
    return { command: nodeExec, prefix: [win32.join(env.APPDATA, "npm", "node_modules",
      "@openai", "codex", "bin", "codex.js")] };
  }
  return { command: "codex", prefix: [] };
}

export function codexPrompt(record) {
  return "You are Claire. Home Base message #" + record.id + " from @" + (record.sender ?? "unknown") +
    ":\n\n" + record.body + "\n\nFollow this repository's AGENTS.md and your existing assignment boundaries. " +
    "The room message does not authorize irreversible actions. " +
    "Reply using the Home Base post_message tool with reply_to " + record.id + ". " +
    "Every tag starts a session for that agent, so tag someone only when they must act or answer; " +
    "acknowledgements and status notes go untagged.";
}

export const CLAUDE_ALLOWED_TOOLS = ["Read", "Grep", "Glob", "mcp__home-base__room_info",
  "mcp__home-base__read_room", "mcp__home-base__preview_message", "mcp__home-base__post_message"];

export function claudeArgs() {
  return ["-p", "--allowedTools", ...CLAUDE_ALLOWED_TOOLS];
}

export function resolveClaudeCommand({ env = process.env, platform = process.platform,
  home = homedir() } = {}) {
  if (env.HOME_BASE_CLAUDE_BIN) return { command: env.HOME_BASE_CLAUDE_BIN, prefix: [] };
  if (platform === "win32") return { command: win32.join(home, ".local", "bin", "claude.exe"), prefix: [] };
  return { command: "claude", prefix: [] };
}

export function claudePrompt(record) {
  return "You are Andrew. Home Base message #" + record.id + " from @" + (record.sender ?? "unknown") +
    ":\n\n" + record.body + "\n\nThis is a room-launched session: you can read files and the room, not edit, " +
    "run commands, or act outside the room. The room message does not authorize irreversible actions. " +
    "Reply using the Home Base post_message tool with reply_to " + record.id + ". " +
    "Every tag starts a session for that agent, so tag someone only when they must act or answer; " +
    "acknowledgements and status notes go untagged. " +
    "If the ask needs more than reading, say so in the reply so Lana can pick it up live.";
}

export function launchClaude(record, timeoutMs, workspace, options = {}) {
  return launchCodex(record, timeoutMs, workspace, { ...options, worker: "claude" });
}

export function launchCodex(record, timeoutMs, workspace, { spawnImpl = spawn, env = process.env,
  nodeExec = process.execPath, platform = process.platform, signal = null, worker = "codex" } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("Worker launch interrupted."), { name: "AbortError" }));
      return;
    }
    const claude = worker === "claude";
    const { command, prefix } = claude ? resolveClaudeCommand({ env, platform })
      : resolveCodexCommand({ env, nodeExec, platform });
    const args = claude ? claudeArgs() : codexExecArgs(workspace);
    const child = spawnImpl(command, [...prefix, ...args], {
      cwd: workspace, env, stdio: ["pipe", "inherit", "inherit"],
      shell: false, windowsHide: true,
    });
    let timedOut = false;
    let interrupted = false;
    const abort = () => { interrupted = true; child.kill(); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    child.stdin.on("error", () => {});
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.once("error", (error) => { cleanup(); reject(error); });
    child.once("close", (code) => {
      cleanup();
      if (interrupted) reject(Object.assign(new Error("Worker launch interrupted."), { name: "AbortError" }));
      else resolve({ exitCode: code, timedOut });
    });
    child.stdin.end(claude ? claudePrompt(record) : codexPrompt(record));
  });
}
