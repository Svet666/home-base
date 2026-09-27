import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "home-base-smoke", version: "1.0.0" });
let readQuery;
const api = createServer((request, response) => {
  readQuery = new URL(request.url, "http://localhost").searchParams;
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ messages: [], next_cursor: "13", older_cursor: "10", has_more: true }));
});
api.listen(0, "127.0.0.1");
await once(api, "listening");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("./server.mjs", import.meta.url))],
  env: {
    ...process.env, HOME_BASE_ENV_FILE: "", HOME_BASE_AGENT_ID: "", HOME_BASE_AGENT_TOKEN: "",
    HOME_BASE_URL: `http://127.0.0.1:${api.address().port}`,
  },
});
try {
  await client.connect(transport);
  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    ["post_message", "preview_message", "read_room", "room_info"],
  );
  const post = listed.tools.find((tool) => tool.name === "post_message");
  assert.ok(post.inputSchema.required.includes("client_request_id"));
  const read = await client.callTool({ name: "read_room", arguments: {} });
  assert.equal(read.isError, undefined);
  assert.equal(readQuery.has("after_id"), false);
  assert.equal(readQuery.get("limit"), "30");
  assert.equal(read.structuredContent.older_cursor, "10");
  const result = await client.callTool({ name: "room_info", arguments: {} });
  assert.equal(result.isError, true);
  process.stdout.write("MCP smoke passed: four registered tools and credential guard.\n");
} finally {
  await client.close();
  api.close();
}
