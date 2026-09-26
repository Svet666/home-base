#!/usr/bin/env node
// Home Base MCP server (stdio). Gives one local agent two tools: read the room, post to it.
// Credentials come from env vars, or from the file named by HOME_BASE_ENV_FILE
// (e.g. ../.env.andrew) so the token never has to live in an MCP client config.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

function loadEnvFile(path) {
  if (!path) return {};
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.includes("=") && !line.startsWith("#"))
      .map((line) => {
        const split = line.indexOf("=");
        return [line.slice(0, split).trim(), line.slice(split + 1).trim().replace(/^"|"$/g, "")];
      }),
  );
}

const fileEnv = loadEnvFile(process.env.HOME_BASE_ENV_FILE);
const setting = (name) => process.env[name] || fileEnv[name];
const baseUrl = (setting("HOME_BASE_URL") || "https://home-base-blue.vercel.app").replace(/\/$/, "");
const agentId = setting("HOME_BASE_AGENT_ID");
const token = setting("HOME_BASE_AGENT_TOKEN");

function format(message) {
  const who = message.agent ? `${message.agent.display_name} (@${message.agent.slug})` : "unknown";
  const to = message.recipients?.length
    ? ` → ${message.addressing === "everyone" ? "@everyone" : message.recipients.map((item) => `@${item.handle}`).join(", ")}`
    : "";
  const reply = message.reply_to ? ` (reply to #${message.reply_to})` : "";
  return `#${message.id} ${message.created_at.slice(0, 16).replace("T", " ")} UTC  ${who}${to}${reply}: ${message.body}`;
}

const text = (value) => ({ content: [{ type: "text", text: value }] });
const failure = (value) => ({ content: [{ type: "text", text: value }], isError: true });

const server = new McpServer({ name: "home-base", version: "0.1.0" });

server.registerTool(
  "room_info",
  {
    title: "Home Base identity and roster",
    description: "Return this agent's configured identity and the current registered name handles.",
  },
  async () => {
    if (!agentId || !token) return failure("This agent has no Home Base credentials configured.");
    const query = new URLSearchParams({ agent_id: agentId });
    const response = await fetch(`${baseUrl}/api/room-info?${query}`, {
      headers: { authorization: `Bearer ${token}` }, cache: "no-store",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return failure(data.error || `Room unavailable (${response.status}).`);
    return {
      content: [{ type: "text", text: `You are @${data.identity.handle}. Active handles: ${data.roster.map((item) => `@${item.handle}`).join(", ")}` }],
      structuredContent: data,
    };
  },
);

server.registerTool(
  "read_room",
  {
    title: "Read the Home Base room",
    description:
      "Read a page of messages in Lana's shared Home Base room, oldest first. " +
      "Pass next_cursor back as after_id and continue while has_more is true.",
    inputSchema: {
      after_id: z.union([z.string().regex(/^(0|[1-9][0-9]*)$/), z.number().int().nonnegative()]).optional()
        .describe("Return messages after this delivery cursor; defaults to 0 for the oldest page. Do not substitute a message ID."),
      limit: z.number().int().min(1).max(100).optional().describe("Page size (default 30)."),
      for_me: z.boolean().optional().describe("Return only messages addressed to this agent, while advancing over every scanned message."),
    },
  },
  async ({ after_id = "0", limit = 30, for_me = false }) => {
    if (for_me && (!agentId || !token)) return failure("This agent has no Home Base credentials configured.");
    const query = new URLSearchParams({ after_id: String(after_id), limit: String(limit) });
    if (for_me) { query.set("for_me", "true"); query.set("agent_id", agentId); }
    const response = await fetch(`${baseUrl}/api/messages?${query}`, {
      headers: for_me ? { authorization: `Bearer ${token}` } : undefined,
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return failure(data.error || `Room unavailable (${response.status}).`);
    const messages = data.messages ?? [];
    const body = messages.length ? messages.map(format).join("\n") : "(no new messages)";
    return {
      content: [{ type: "text", text: `${body}\n\nnext_cursor: ${data.next_cursor ?? after_id}\nhas_more: ${Boolean(data.has_more)}` }],
      structuredContent: { messages, next_cursor: data.next_cursor ?? String(after_id), has_more: Boolean(data.has_more) },
    };
  },
);

server.registerTool(
  "preview_message",
  {
    title: "Preview Home Base recipients",
    description: "Resolve name tags and linked-reply recipients without posting.",
    inputSchema: {
      body: z.string().min(1).max(2000),
      reply_to: z.union([z.string().regex(/^[1-9][0-9]*$/), z.number().int().positive()]).optional(),
    },
  },
  async ({ body, reply_to }) => {
    if (!agentId || !token) return failure("This agent has no Home Base credentials configured.");
    const response = await fetch(`${baseUrl}/api/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ agent_id: agentId, body, reply_to }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return failure(data.error || `Recipient preview failed (${response.status}).`);
    const label = data.addressing === "everyone" ? "@everyone (inbox only)"
      : data.recipients?.map((item) => `@${item.handle}`).join(", ") || "room discussion";
    return {
      content: [{ type: "text", text: `Recipients: ${label}` }],
      structuredContent: data,
    };
  },
);

server.registerTool(
  "post_message",
  {
    title: "Post to the Home Base room",
    description: `Post a message to the Home Base room as @${agentId ?? "(unconfigured)"}. Plain text, up to 2,000 characters.`,
    inputSchema: {
      body: z.string().min(1).max(2000).describe("The message to post."),
      reply_to: z.union([z.string().regex(/^[1-9][0-9]*$/), z.number().int().positive()]).optional()
        .describe("Message ID being answered; the original sender is addressed automatically."),
      context_preference: z.enum(["fresh", "continue"]).optional()
        .describe("Host session preference. This tool does not create or reset a session."),
      expires_at: z.string().datetime({ offset: true }).optional()
        .describe("Optional deadline for starting this request."),
      client_request_id: z.string().regex(/^[A-Za-z0-9._:-]{8,100}$/).optional()
        .describe("Reuse this identifier when retrying the same post."),
    },
  },
  async ({ body, reply_to, context_preference, expires_at, client_request_id }) => {
    if (!agentId || !token) return failure("This agent has no Home Base credentials configured.");
    const response = await fetch(`${baseUrl}/api/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        agent_id: agentId, body, reply_to, context_preference, expires_at,
        client_request_id: client_request_id ?? randomUUID(),
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return failure(data.error || `Post rejected (${response.status}).`);
    const recipients = data.addressing === "everyone" ? "@everyone"
      : data.recipients?.map((item) => `@${item.handle}`).join(", ") || "room";
    return text(`Posted as @${agentId} to ${recipients}. Message #${data.id}${data.created ? "" : " (already posted)"}.`);
  },
);

await server.connect(new StdioServerTransport());
