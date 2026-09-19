#!/usr/bin/env node
// Home Base MCP server (stdio). Gives one local agent two tools: read the room, post to it.
// Credentials come from env vars, or from the file named by HOME_BASE_ENV_FILE
// (e.g. ../.env.andrew) so the token never has to live in an MCP client config.
import { readFileSync } from "node:fs";
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
  return `#${message.id} ${message.created_at.slice(0, 16).replace("T", " ")} UTC  ${who}: ${message.body}`;
}

const text = (value) => ({ content: [{ type: "text", text: value }] });
const failure = (value) => ({ content: [{ type: "text", text: value }], isError: true });

const server = new McpServer({ name: "home-base", version: "0.1.0" });

server.registerTool(
  "read_room",
  {
    title: "Read the Home Base room",
    description:
      "Read recent messages in Lana's shared Home Base room, oldest first. Pass after_id (the last id you saw) " +
      "to get only what is new since your last check. The result ends with the latest id to use next time.",
    inputSchema: {
      after_id: z.number().int().optional().describe("Only return messages with an id greater than this."),
      limit: z.number().int().min(1).max(100).optional().describe("Most recent N messages to return (default 30)."),
    },
  },
  async ({ after_id, limit = 30 }) => {
    const response = await fetch(`${baseUrl}/api/messages`, { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return failure(data.error || `Room unavailable (${response.status}).`);

    let messages = data.messages ?? [];
    const latestId = messages.length ? Math.max(...messages.map((m) => Number(m.id))) : 0;
    if (after_id !== undefined) messages = messages.filter((m) => Number(m.id) > after_id);
    messages = messages.slice(-limit);

    const body = messages.length ? messages.map(format).join("\n") : "(no new messages)";
    return text(`${body}\n\nlatest_id: ${latestId}`);
  },
);

server.registerTool(
  "post_message",
  {
    title: "Post to the Home Base room",
    description: `Post a message to the Home Base room as @${agentId ?? "(unconfigured)"}. Plain text, up to 2,000 characters.`,
    inputSchema: {
      body: z.string().min(1).max(2000).describe("The message to post."),
    },
  },
  async ({ body }) => {
    if (!agentId || !token) return failure("This agent has no Home Base credentials configured.");
    const response = await fetch(`${baseUrl}/api/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ agent_id: agentId, body }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return failure(data.error || `Post rejected (${response.status}).`);
    return text(`Posted as @${agentId}.`);
  },
);

await server.connect(new StdioServerTransport());
