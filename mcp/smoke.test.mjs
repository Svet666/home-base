import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "home-base-smoke", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("./server.mjs", import.meta.url))],
  env: { ...process.env, HOME_BASE_ENV_FILE: "", HOME_BASE_AGENT_ID: "", HOME_BASE_AGENT_TOKEN: "" },
});
try {
  await client.connect(transport);
  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    ["post_message", "preview_message", "read_room", "room_info"],
  );
  const result = await client.callTool({ name: "room_info", arguments: {} });
  assert.equal(result.isError, true);
  process.stdout.write("MCP smoke passed: four registered tools and credential guard.\n");
} finally {
  await client.close();
}
