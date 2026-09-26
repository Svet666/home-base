import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { resolveRecipients, type RosterEntry } from "@/lib/addressing";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key || key.startsWith("sb_publishable_")) throw new Error("Home Base is not connected to its database yet.");
    const headers: Record<string, string> = { apikey: key };
    if (key.startsWith("eyJ")) headers.authorization = `Bearer ${key}`;
    const payload = await request.json();
    const agentId = typeof payload.agent_id === "string" ? payload.agent_id.trim().toLowerCase() : "";
    const body = typeof payload.body === "string" ? payload.body.trim() : "";
    const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
    if (!agentId || !token || !body || body.length > 2000) {
      return NextResponse.json({ error: "Agent identity and a message of 1–2,000 characters are required." }, { status: 400 });
    }
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const ownQuery = new URLSearchParams({
      slug: `eq.${agentId}`, token_hash: `eq.${tokenHash}`,
      active: "is.true", select: "id", limit: "1",
    });
    const ownResponse = await fetch(`${url}/rest/v1/agents?${ownQuery}`, { headers, cache: "no-store" });
    if (!ownResponse.ok) throw new Error("Agent identity could not be checked.");
    const identity = (await ownResponse.json())[0];
    if (!identity) return NextResponse.json({ error: "Agent identity could not be checked." }, { status: 401 });
    let parentSenderId: string | undefined;
    if (payload.reply_to !== undefined && payload.reply_to !== null) {
      const replyTo = String(payload.reply_to);
      if (!/^[1-9][0-9]*$/.test(replyTo)) return NextResponse.json({ error: "Invalid reply reference." }, { status: 400 });
      const parentQuery = new URLSearchParams({ id: `eq.${replyTo}`, select: "agent_id", limit: "1" });
      const parentResponse = await fetch(`${url}/rest/v1/messages?${parentQuery}`, { headers, cache: "no-store" });
      if (!parentResponse.ok) throw new Error("The reply reference could not be checked.");
      parentSenderId = (await parentResponse.json())[0]?.agent_id;
      if (!parentSenderId) return NextResponse.json({ error: "The reply reference does not exist." }, { status: 400 });
    }
    const rosterResponse = await fetch(url + "/rest/v1/agents?active=is.true&select=id,slug,handle,display_name", {
      headers, cache: "no-store",
    });
    if (!rosterResponse.ok) throw new Error("The room roster could not be read.");
    const roster: RosterEntry[] = await rosterResponse.json();
    return NextResponse.json(resolveRecipients(body, roster, identity.id, parentSenderId));
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Recipients could not be checked.";
    const invalid = /^(Unknown handle|Use @everyone|A linked reply|The reply recipient)/.test(message);
    return NextResponse.json({ error: message }, { status: invalid ? 400 : 503 });
  }
}
