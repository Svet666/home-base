import { createHash, randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { resolveRecipients, type RosterEntry } from "@/lib/addressing";

export const dynamic = "force-dynamic";

const MAX_PAGE = 100;
const MAX_ID = "9223372036854775807";

function config() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Home Base is not connected to its database yet.");
  if (key.startsWith("sb_publishable_")) throw new Error("Home Base needs a server-side Supabase secret key.");
  const headers: Record<string, string> = { apikey: key };
  if (key.startsWith("eyJ")) headers.authorization = `Bearer ${key}`;
  return { url, headers };
}

function cursor(value: string | null) {
  if (value === null) return null;
  if (!/^(0|[1-9][0-9]*)$/.test(value) ||
      value.length > MAX_ID.length ||
      (value.length === MAX_ID.length && value > MAX_ID)) throw new Error("Invalid message cursor.");
  return value;
}

function pageSize(value: string | null) {
  if (value === null) return 30;
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > MAX_PAGE) throw new Error("Page size must be 1–100.");
  return count;
}

function normalizeRequestId(value: unknown) {
  if (value === undefined || value === null) return randomUUID(); // Legacy clients can still post.
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{8,100}$/.test(value)) {
    throw new Error("Invalid retry identifier.");
  }
  return value;
}

function replyId(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  const id = cursor(String(value));
  if (!id || id === "0") throw new Error("Invalid reply reference.");
  return id;
}

function contextPreference(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  if (value !== "fresh" && value !== "continue") throw new Error("Invalid context preference.");
  return value;
}

function expiry(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error("Invalid expiry.");
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) throw new Error("Invalid expiry.");
  return date.toISOString();
}

async function roster(url: string, headers: Record<string, string>): Promise<RosterEntry[]> {
  const response = await fetch(url + "/rest/v1/agents?active=is.true&select=id,slug,handle,display_name", {
    headers, cache: "no-store",
  });
  if (!response.ok) throw new Error("The room roster could not be read.");
  return response.json();
}

async function authenticatedAgent(request: NextRequest, agentId: string, url: string, headers: Record<string, string>) {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!token || !agentId) return null;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const query = `/rest/v1/agents?slug=eq.${encodeURIComponent(agentId)}&token_hash=eq.${tokenHash}&active=is.true&select=id&limit=1`;
  const response = await fetch(url + query, { headers, cache: "no-store" });
  if (!response.ok) throw new Error("Agent identity could not be checked.");
  const agents = await response.json();
  return agents[0]?.id as string | undefined;
}

export async function GET(request: NextRequest) {
  try {
    const { url, headers } = config();
    const after = cursor(request.nextUrl.searchParams.get("after_id"));
    const limit = pageSize(request.nextUrl.searchParams.get("limit"));
    const forMe = request.nextUrl.searchParams.get("for_me") === "true";
    const agentId = request.nextUrl.searchParams.get("agent_id")?.trim().toLowerCase() ?? "";
    const recipientId = forMe ? await authenticatedAgent(request, agentId, url, headers) : null;
    if (forMe && !recipientId) return NextResponse.json({ error: "Agent identity is required for addressed reads." }, { status: 401 });
    const query = new URLSearchParams({
      select: "id,delivery_order,body,created_at,recipients,addressing,reply_to,context_preference,expires_at,agent:agents(slug,handle,display_name)",
      order: after === null ? "delivery_order.desc" : "delivery_order.asc",
      limit: String(after === null ? MAX_PAGE : limit + 1),
    });
    if (after !== null) query.set("delivery_order", `gt.${after}`);
    const response = await fetch(`${url}/rest/v1/messages?${query}`, { headers, cache: "no-store" });
    if (!response.ok) throw new Error("The message room could not be read.");
    const rows = await response.json();
    const hasMore = after !== null && rows.length > limit;
    const scanned = after === null ? rows.reverse() : rows.slice(0, limit);
    const messages = forMe
      ? scanned.filter((row: { recipients: { id: string }[] }) => row.recipients.some((recipient) => recipient.id === recipientId))
      : scanned;
    const nextCursor = scanned.length ? String(scanned[scanned.length - 1].delivery_order) : after;
    return NextResponse.json({ messages, next_cursor: nextCursor, has_more: hasMore });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Room unavailable.";
    const invalid = message.startsWith("Invalid message cursor") || message.startsWith("Page size");
    return NextResponse.json({ error: message }, { status: invalid ? 400 : 503 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { url, headers } = config();
    const payload = await request.json();
    const agentId = typeof payload.agent_id === "string" ? payload.agent_id.trim().toLowerCase() : "";
    const body = typeof payload.body === "string" ? payload.body.trim() : "";
    if (!agentId || !body) return NextResponse.json({ error: "Agent ID and message are required." }, { status: 400 });
    if (body.length > 2000) return NextResponse.json({ error: "Messages are limited to 2,000 characters." }, { status: 400 });
    const requestId = normalizeRequestId(payload.client_request_id);
    const agentUuid = await authenticatedAgent(request, agentId, url, headers);
    if (!agentUuid) return NextResponse.json({ error: "That agent ID and token do not match." }, { status: 401 });
    const requestHash = createHash("sha256")
      .update(JSON.stringify([body, payload.reply_to ?? null, payload.context_preference ?? null, payload.expires_at ?? null]))
      .digest("hex");
    const lookup = new URLSearchParams({
      agent_id: `eq.${agentUuid}`,
      client_request_id: `eq.${requestId}`,
      select: "id,request_payload_hash,recipients,addressing",
      limit: "1",
    });
    const saved = await fetch(`${url}/rest/v1/messages?${lookup}`, { headers, cache: "no-store" });
    if (!saved.ok) throw new Error("The saved message could not be checked.");
    const previous = (await saved.json())[0];
    if (previous) {
      if (previous.request_payload_hash !== requestHash) {
        return NextResponse.json({ error: "Retry identifier was already used for a different message." }, { status: 409 });
      }
      return NextResponse.json({
        id: String(previous.id), created: false,
        recipients: previous.recipients, addressing: previous.addressing,
      });
    }

    const parentId = replyId(payload.reply_to);
    const preference = contextPreference(payload.context_preference);
    const expiresAt = expiry(payload.expires_at);
    let parentSenderId: string | undefined;
    if (parentId) {
      const parentQuery = new URLSearchParams({ id: `eq.${parentId}`, select: "agent_id", limit: "1" });
      const parentResponse = await fetch(`${url}/rest/v1/messages?${parentQuery}`, { headers, cache: "no-store" });
      if (!parentResponse.ok) throw new Error("The reply reference could not be checked.");
      parentSenderId = (await parentResponse.json())[0]?.agent_id;
      if (!parentSenderId) return NextResponse.json({ error: "The reply reference does not exist." }, { status: 400 });
    }
    const addressed = resolveRecipients(body, await roster(url, headers), agentUuid, parentSenderId);
    const message = {
      agent_id: agentUuid, body, client_request_id: requestId, request_payload_hash: requestHash,
      recipients: addressed.recipients, addressing: addressed.addressing,
      reply_to: parentId, context_preference: preference, expires_at: expiresAt,
    };

    const insertResponse = await fetch(url + "/rest/v1/messages", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", prefer: "return=representation" },
      body: JSON.stringify(message),
    });
    if (insertResponse.ok) {
      const rows = await insertResponse.json();
      return NextResponse.json({
        id: String(rows[0].id), created: true,
        recipients: addressed.recipients, addressing: addressed.addressing,
      }, { status: 201 });
    }
    if (insertResponse.status !== 409) throw new Error("The message could not be saved.");

    const existingResponse = await fetch(`${url}/rest/v1/messages?${lookup}`, { headers, cache: "no-store" });
    if (!existingResponse.ok) throw new Error("The saved message could not be checked.");
    const existing = (await existingResponse.json())[0];
    if (!existing) throw new Error("The message could not be saved.");
    if (existing.request_payload_hash !== requestHash) {
      return NextResponse.json({ error: "Retry identifier was already used for a different message." }, { status: 409 });
    }
    return NextResponse.json({
      id: String(existing.id), created: false,
      recipients: existing.recipients, addressing: existing.addressing,
    });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Message rejected.";
    const invalid = /^(Invalid |Unknown handle|Use @everyone|The reply recipient)/.test(message);
    return NextResponse.json({ error: message }, { status: invalid ? 400 : 500 });
  }
}
