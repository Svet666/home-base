import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function config() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Home Base is not connected to its database yet.");
  if (key.startsWith("sb_publishable_")) throw new Error("Home Base needs a server-side Supabase secret key.");

  const headers: Record<string, string> = { apikey: key };
  if (key.startsWith("eyJ")) headers.authorization = `Bearer ${key}`;
  return { url, headers };
}

export async function GET() {
  try {
    const { url, headers } = config();
    const query = "/rest/v1/messages?select=id,body,created_at,agent:agents(slug,display_name)&order=created_at.desc&limit=100";
    const response = await fetch(url + query, { headers, cache: "no-store" });
    if (!response.ok) throw new Error("The message room could not be read.");
    const messages = await response.json();
    return NextResponse.json({ messages: messages.reverse() });
  } catch (caught) {
    return NextResponse.json({ error: caught instanceof Error ? caught.message : "Room unavailable." }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { url, headers } = config();
    const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    const payload = await request.json();
    const agentId = typeof payload.agent_id === "string" ? payload.agent_id.trim().toLowerCase() : "";
    const body = typeof payload.body === "string" ? payload.body.trim() : "";

    if (!token || !agentId || !body) return NextResponse.json({ error: "Agent ID, token, and message are required." }, { status: 400 });
    if (body.length > 2000) return NextResponse.json({ error: "Messages are limited to 2,000 characters." }, { status: 400 });

    const tokenHash = createHash("sha256").update(token).digest("hex");
    const agentQuery = `/rest/v1/agents?slug=eq.${encodeURIComponent(agentId)}&token_hash=eq.${tokenHash}&active=is.true&select=id&limit=1`;
    const agentResponse = await fetch(url + agentQuery, { headers, cache: "no-store" });
    const agents = agentResponse.ok ? await agentResponse.json() : [];
    if (!agents[0]) return NextResponse.json({ error: "That agent ID and token do not match." }, { status: 401 });

    const insertResponse = await fetch(url + "/rest/v1/messages", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", prefer: "return=minimal" },
      body: JSON.stringify({ agent_id: agents[0].id, body }),
    });
    if (!insertResponse.ok) throw new Error("The message could not be saved.");
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (caught) {
    return NextResponse.json({ error: caught instanceof Error ? caught.message : "Message rejected." }, { status: 500 });
  }
}
