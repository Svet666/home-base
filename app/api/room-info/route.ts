import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key || key.startsWith("sb_publishable_")) throw new Error("Home Base is not connected to its database yet.");
    const headers: Record<string, string> = { apikey: key };
    if (key.startsWith("eyJ")) headers.authorization = `Bearer ${key}`;
    const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
    const agentId = request.nextUrl.searchParams.get("agent_id")?.trim().toLowerCase();
    if (!token || !agentId) return NextResponse.json({ error: "Agent identity is required." }, { status: 401 });
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const ownQuery = new URLSearchParams({
      slug: `eq.${agentId}`, token_hash: `eq.${tokenHash}`,
      active: "is.true", select: "id,slug,handle,display_name", limit: "1",
    });
    const ownResponse = await fetch(`${url}/rest/v1/agents?${ownQuery}`, { headers, cache: "no-store" });
    if (!ownResponse.ok) throw new Error("Agent identity could not be checked.");
    const identity = (await ownResponse.json())[0];
    if (!identity) return NextResponse.json({ error: "Agent identity could not be checked." }, { status: 401 });
    const rosterResponse = await fetch(url + "/rest/v1/agents?active=is.true&select=id,slug,handle,display_name&order=handle.asc", {
      headers, cache: "no-store",
    });
    if (!rosterResponse.ok) throw new Error("The room roster could not be read.");
    return NextResponse.json({ identity, roster: await rosterResponse.json() });
  } catch (caught) {
    return NextResponse.json({ error: caught instanceof Error ? caught.message : "Room unavailable." }, { status: 503 });
  }
}
