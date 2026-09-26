import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as pause } from "node:timers/promises";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const agents = [
  { id: "a", slug: "claire-codex", handle: "claire", display_name: "Claire", token_hash: hash("claire-token"), post_secret: "s".repeat(32), active: true },
  { id: "b", slug: "wren-actex", handle: "wren", display_name: "Wren", token_hash: hash("wren-token"), active: true },
  { id: "c", slug: "lana", handle: "lana", display_name: "Lana", token_hash: hash("lana-token"), active: true },
];
const messages = Array.from({ length: 130 }, (_, index) => ({
  id: index + 1, delivery_order: index + 1, agent_id: "b", body: `History ${index + 1}`,
  created_at: "2026-09-26T12:00:00Z", recipients: [50, 110].includes(index + 1) ? [{ id: "a", handle: "claire" }] : [],
  addressing: [50, 110].includes(index + 1) ? "direct" : "none",
  reply_to: null, context_preference: null, expires_at: null,
}));

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

const supabase = createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  const query = url.searchParams;
  const json = (status, value) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };
  if (url.pathname === "/rest/v1/agents") {
    let rows = agents.filter((agent) => agent.active);
    if (query.has("slug")) rows = rows.filter((agent) => agent.slug === query.get("slug").slice(3));
    if (query.has("token_hash")) rows = rows.filter((agent) => agent.token_hash === query.get("token_hash").slice(3));
    if (query.has("post_secret")) rows = rows.filter((agent) => agent.post_secret === query.get("post_secret").slice(3));
    return json(200, rows);
  }
  if (url.pathname !== "/rest/v1/messages") return json(404, {});
  if (request.method === "POST") {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const incoming = JSON.parse(raw);
    if (incoming.client_request_id && messages.some((item) =>
      item.agent_id === incoming.agent_id && item.client_request_id === incoming.client_request_id)) {
      return json(409, { code: "23505" });
    }
    const message = { id: messages.length + 1, delivery_order: messages.length + 1, created_at: new Date().toISOString(), ...incoming };
    messages.push(message);
    return json(201, [message]);
  }
  let rows = [...messages];
  if (query.has("id")) {
    const filter = query.get("id");
    if (filter.startsWith("gt.")) rows = rows.filter((item) => item.id > Number(filter.slice(3)));
    if (filter.startsWith("eq.")) rows = rows.filter((item) => item.id === Number(filter.slice(3)));
  }
  if (query.has("delivery_order")) {
    const filter = query.get("delivery_order");
    if (filter.startsWith("gt.")) rows = rows.filter((item) => item.delivery_order > Number(filter.slice(3)));
  }
  if (query.has("agent_id")) rows = rows.filter((item) => item.agent_id === query.get("agent_id").slice(3));
  if (query.has("client_request_id")) rows = rows.filter((item) => item.client_request_id === query.get("client_request_id").slice(3));
  if (query.get("order")?.endsWith(".desc")) rows.reverse();
  if (query.has("limit")) rows = rows.slice(0, Number(query.get("limit")));
  return json(200, rows.map((item) => ({
    ...item,
    agent: agents.find((agent) => agent.id === item.agent_id),
  })));
});

const mockPort = await listen(supabase);
const portReservation = createServer();
const appPort = await listen(portReservation);
portReservation.close();
const app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(appPort)], {
  cwd: process.cwd(),
  env: { ...process.env, SUPABASE_URL: `http://127.0.0.1:${mockPort}`, SUPABASE_SECRET_KEY: "test-secret" },
  windowsHide: true,
  stdio: "ignore",
});
const base = `http://127.0.0.1:${appPort}`;
try {
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(`${base}/api/messages?after_id=0&limit=1`);
      if (response.ok) { ready = true; break; }
    } catch {}
    await pause(100);
  }
  assert.ok(ready, "Next.js test server started");

  let cursor = "0";
  const seen = [];
  while (true) {
    const response = await fetch(`${base}/api/messages?after_id=${cursor}&limit=30`);
    assert.equal(response.status, 200);
    const page = await response.json();
    seen.push(...page.messages.map((message) => Number(message.id)));
    cursor = page.next_cursor;
    if (!page.has_more) break;
  }
  assert.deepEqual(seen, Array.from({ length: 130 }, (_, index) => index + 1));

  cursor = "0";
  const addressed = [];
  while (true) {
    const response = await fetch(`${base}/api/messages?after_id=${cursor}&limit=30&for_me=true&agent_id=claire-codex`, {
      headers: { authorization: "Bearer claire-token" },
    });
    assert.equal(response.status, 200);
    const page = await response.json();
    addressed.push(...page.messages.map((message) => Number(message.id)));
    cursor = page.next_cursor;
    if (!page.has_more) break;
  }
  assert.deepEqual(addressed, [50, 110]);

  const preview = await fetch(`${base}/api/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer claire-token" },
    body: JSON.stringify({ agent_id: "claire-codex", body: "Can @WREN help?" }),
  });
  assert.equal(preview.status, 200);
  assert.deepEqual((await preview.json()).recipients, [{ id: "b", handle: "wren" }]);
  assert.equal(messages.length, 130, "preview does not post");

  const post = (agent, token, body, requestId, extra = {}) => fetch(`${base}/api/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ agent_id: agent, body, client_request_id: requestId, ...extra }),
  });
  const first = await post("claire-codex", "claire-token", "Can @WREN help?", "trial-request-1");
  assert.equal(first.status, 201);
  const created = await first.json();
  assert.deepEqual(created.recipients, [{ id: "b", handle: "wren" }]);
  const retry = await post("claire-codex", "claire-token", "Can @WREN help?", "trial-request-1");
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).id, created.id);
  assert.equal((await post("claire-codex", "claire-token", "Different", "trial-request-1")).status, 409);

  const reply = await post("wren-actex", "wren-token", "I can help", "trial-request-2", { reply_to: created.id });
  assert.equal(reply.status, 201);
  assert.deepEqual((await reply.json()).recipients, [{ id: "a", handle: "claire" }]);
  const everyone = await post("claire-codex", "claire-token", "News @everyone", "trial-request-3");
  assert.equal((await everyone.json()).addressing, "everyone");
  assert.equal((await post("claire-codex", "claire-token", "Ask @Missing", "trial-request-4")).status, 400);

  const link = `${base}/p/${"s".repeat(32)}?msg=${encodeURIComponent("Link asks @Wren")}&client_request_id=link-trial-1`;
  const beforeLink = messages.length;
  const linkPreview = await fetch(link + "&preview=1");
  assert.equal(linkPreview.status, 200);
  assert.match(await linkPreview.text(), /Recipients: @wren/);
  assert.equal(messages.length, beforeLink);
  assert.equal((await fetch(link)).status, 201);
  assert.deepEqual(messages.at(-1).recipients, [{ id: "b", handle: "wren" }]);
  assert.equal((await fetch(link)).status, 200);
  assert.equal(messages.length, beforeLink + 1);

  process.stdout.write("API integration passed: 130-message backlog, filtered cursor, tags, reply, retry, posting link.\n");
} finally {
  app.kill();
  supabase.close();
}
