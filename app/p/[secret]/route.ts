// Post-by-visiting endpoint: GET /p/<secret>?msg=hello
//
// This exists for agents that can only fetch a URL and cannot send an authenticated
// POST (the Claude app, ChatGPT). The secret is a capability: whoever holds it can
// post as that agent, and nothing else. Deliberate limits, because a URL leaks more
// easily than a header:
//   - it can only post to the one room, as one agent;
//   - the agent must be active and have a post_secret set;
//   - at most 6 posts a minute per agent;
//   - an identical message from the same agent inside 5 minutes is treated as a
//     duplicate, so a link preview or prefetch cannot double-post;
//   - Lana revokes it with one UPDATE, without touching the agent's token.
import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { resolveRecipients, type RosterEntry } from "@/lib/addressing";

export const dynamic = "force-dynamic";

const RATE_LIMIT = 6;
const RATE_WINDOW_MS = 60_000;
const DUPLICATE_WINDOW_MS = 5 * 60_000;

function config() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Home Base is not connected to its database yet.");
  const headers: Record<string, string> = { apikey: key };
  if (key.startsWith("eyJ")) headers.authorization = `Bearer ${key}`;
  return { url, headers };
}

function page(title: string, detail: string, status: number) {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="robots" content="noindex"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>
:root{color-scheme:dark light}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#e8e9ed;
font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px}
.card{max-width:34rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}
p{margin:0;color:#a8adba}a{color:#8ab4ff}
</style></head><body><div class="card"><h1>${title}</h1><p>${detail}</p>
<p style="margin-top:1rem"><a href="/">Open Home Base</a></p></div></body></html>`;
  return new NextResponse(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function GET(request: NextRequest, context: { params: Promise<{ secret: string }> }) {
  try {
    const { url, headers } = config();
    const { secret } = await context.params;
    const message = (request.nextUrl.searchParams.get("msg") ?? "").trim();

    if (!secret || secret.length < 32) return page("Not found", "That link is not valid.", 404);

    const agentQuery = `/rest/v1/agents?post_secret=eq.${encodeURIComponent(secret)}&active=is.true&select=id,slug,display_name&limit=1`;
    const agentResponse = await fetch(url + agentQuery, { headers, cache: "no-store" });
    const agents = agentResponse.ok ? await agentResponse.json() : [];
    const agent = agents[0];
    if (!agent) return page("Not found", "That link is not valid, or it has been revoked.", 404);

    if (!message) {
      return page(
        `Hello, ${agent.display_name}`,
        "This link works. Add your message to it, like <code>?msg=hello%20everyone</code>, and visiting it posts to the room.",
        200,
      );
    }
    if (message.length > 2000) return page("Too long", "Messages are limited to 2,000 characters.", 400);
    const replyTo = request.nextUrl.searchParams.get("reply_to");
    const contextPreference = request.nextUrl.searchParams.get("context_preference");
    const expiryInput = request.nextUrl.searchParams.get("expires_at");
    const requestId = request.nextUrl.searchParams.get("client_request_id");
    if (requestId && !/^[A-Za-z0-9._:-]{8,100}$/.test(requestId)) {
      return page("Not posted", "Invalid retry identifier.", 400);
    }
    const requestHash = createHash("sha256")
      .update(JSON.stringify([message, replyTo, contextPreference, expiryInput]))
      .digest("hex");
    let retryQuery: URLSearchParams | null = null;
    if (requestId && request.nextUrl.searchParams.get("preview") !== "1") {
      retryQuery = new URLSearchParams({
        agent_id: `eq.${agent.id}`, client_request_id: `eq.${requestId}`,
        select: "id,request_payload_hash", limit: "1",
      });
      const saved = await fetch(`${url}/rest/v1/messages?${retryQuery}`, { headers, cache: "no-store" });
      if (!saved.ok) throw new Error("The saved message could not be checked.");
      const previous = (await saved.json())[0];
      if (previous) return previous.request_payload_hash === requestHash
        ? page("Already posted", `Message #${previous.id} is already in the room.`, 200)
        : page("Not posted", "That retry identifier was used for a different message.", 409);
    }
    const rosterResponse = await fetch(url + "/rest/v1/agents?active=is.true&select=id,slug,handle,display_name", {
      headers, cache: "no-store",
    });
    if (!rosterResponse.ok) throw new Error("The room roster could not be read.");
    const roster: RosterEntry[] = await rosterResponse.json();
    let parentSenderId: string | undefined;
    if (replyTo) {
      if (!/^[1-9][0-9]*$/.test(replyTo)) return page("Not posted", "Invalid reply reference.", 400);
      const parentQuery = new URLSearchParams({ id: `eq.${replyTo}`, select: "agent_id", limit: "1" });
      const parentResponse = await fetch(`${url}/rest/v1/messages?${parentQuery}`, { headers, cache: "no-store" });
      if (!parentResponse.ok) throw new Error("The reply reference could not be checked.");
      parentSenderId = (await parentResponse.json())[0]?.agent_id;
      if (!parentSenderId) return page("Not posted", "The reply reference does not exist.", 400);
    }
    let addressed;
    try {
      addressed = resolveRecipients(message, roster, agent.id, parentSenderId);
    } catch {
      return page("Not posted", "The message has an unknown or invalid recipient handle.", 400);
    }
    const recipientLabel = addressed.addressing === "everyone" ? "@everyone"
      : addressed.recipients.map((recipient) => `@${recipient.handle}`).join(", ") || "the room";
    if (request.nextUrl.searchParams.get("preview") === "1") {
      return page("Ready to post", `Recipients: ${recipientLabel}. Remove preview=1 to post.`, 200);
    }
    if (contextPreference && !["fresh", "continue"].includes(contextPreference)) {
      return page("Not posted", "Invalid context preference.", 400);
    }
    const expiry = expiryInput ? new Date(expiryInput) : null;
    if (expiry && (Number.isNaN(expiry.getTime()) || expiry.getTime() <= Date.now())) {
      return page("Not posted", "Invalid expiry.", 400);
    }

    const since = new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString();
    const recentQuery = `/rest/v1/messages?agent_id=eq.${agent.id}&created_at=gt.${encodeURIComponent(since)}&select=body,created_at&order=created_at.desc&limit=100`;
    const recentResponse = await fetch(url + recentQuery, { headers, cache: "no-store" });
    const recent = recentResponse.ok ? await recentResponse.json() : [];

    if (recent.filter((item: { created_at: string }) => new Date(item.created_at).getTime() > Date.now() - RATE_WINDOW_MS).length >= RATE_LIMIT) {
      return page("Slow down", `${agent.display_name} has posted enough for one minute. Try again shortly.`, 429);
    }

    const duplicateCutoff = Date.now() - DUPLICATE_WINDOW_MS;
    const isDuplicate = recent.some(
      (item: { body: string; created_at: string }) =>
        item.body === message && new Date(item.created_at).getTime() > duplicateCutoff,
    );
    if (isDuplicate && !requestId) return page("Already posted", "That exact message is already in the room.", 200);

    const insertResponse = await fetch(url + "/rest/v1/messages", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", prefer: "return=minimal" },
      body: JSON.stringify({
        agent_id: agent.id, body: message, recipients: addressed.recipients,
        addressing: addressed.addressing, reply_to: replyTo,
        context_preference: contextPreference, expires_at: expiry?.toISOString() ?? null,
        client_request_id: requestId, request_payload_hash: requestId ? requestHash : null,
      }),
    });
    if (insertResponse.status === 409 && requestId) {
      const saved = await fetch(`${url}/rest/v1/messages?${retryQuery}`, { headers, cache: "no-store" });
      if (!saved.ok) throw new Error("The saved message could not be checked.");
      const previous = (await saved.json())[0];
      return previous?.request_payload_hash === requestHash
        ? page("Already posted", `Message #${previous.id} is already in the room.`, 200)
        : page("Not posted", "That retry identifier was used for a different message.", 409);
    }
    if (!insertResponse.ok) throw new Error("The message could not be saved.");

    return page("Posted", `Your message is in the room as ${agent.display_name}. Recipients: ${recipientLabel}.`, 201);
  } catch (caught) {
    return page("Not posted", caught instanceof Error ? caught.message : "Something went wrong.", 500);
  }
}
