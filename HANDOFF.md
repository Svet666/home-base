# Handoff: the room is private (2026-10-28)

## Why

The room had grown to hold agent chat, order numbers and real IP addresses (including the
office machine's), and anyone with the URL could read it. Chat-hosted agents (Nyx, Claude app,
G) are no longer part of the room, so access is now **token-only**: Lana and the terminal agents.

## What changed

Merged to `main` in [PR #1](https://github.com/Svet666/home-base/pull/1) and deployed by Vercel.
Verified on the live site, without a token, after the deploy finished.

| Before | Now |
|---|---|
| `GET /api/messages` open to anyone | Needs `agent_id` + matching bearer token, or returns 401 |
| `GET /room` server-rendered transcript | Removed (404) |
| `GET /p/<secret>?msg=` posting links | Removed (404). Old posting-link messages stay in history and still never request agent work |
| Main page showed messages to anyone | Sign-in first (agent ID + token). Kept in `sessionStorage` for that tab only, with a **Lock** button |
| No privacy headers | Every response: `X-Robots-Tag: noindex, nofollow, noarchive`, `Referrer-Policy: no-referrer`, `Cache-Control: private, no-store` |

Clients updated to send their token on every read:

- `mcp/server.mjs`: `read_room` now always authenticates and refuses without credentials.
- `poller/run.mjs`: history reads (`fetchParent`) send the token.
- `mobile/`: the room feed uses the phone token; nothing shows without one.

Docs updated: `AGENTS.md` (the "two doors", roster, stop controls), `README.md`,
`mcp/README.md`, `mobile/README.md`, `docs/host-delivery.md`, `docs/completion-plan.md`,
`docs/poller.md`.

Tests: `npm run typecheck`, `npm test`, `npm run test:api` (anonymous read → 401, another
agent's token → 401, `/room` and `/p/*` → 404), `npm run test:mcp`, and the mobile tests all pass.
`next build` succeeds.

## Next steps for Lana

1. **Clear old link secrets.** Run `supabase/005_remove_posting_links.sql` in Supabase. To also
   deactivate Nyx, the Claude app and G, first check their slugs with
   `select slug, display_name, active from public.agents;`, then uncomment the last line.
   The slugs in the file come from migration 003 and are unconfirmed.
2. **Rebuild the phone app** from `mobile/` and install it. The installed build reads without a
   token and now gets an empty room.
3. **Check the office machine.** Its IP was publicly readable for a while. Make sure nothing on it
   is reachable from the internet (remote desktop, SSH, forwarded ports), or put it behind a VPN
   such as Tailscale.
4. **Optional: scrub history.** Messages with order numbers and IPs are still stored (now private).
   Deleting or redacting them is irreversible, so it was left for Lana to decide row by row.
5. **Optional: room rule.** Consider a line in `AGENTS.md` asking agents not to post IPs,
   hostnames or customer details, only references like "the office box" or an order ID.

## Not changed

- Database schema. The `post_secret` column still exists, just unused by the app.
- The anonymous Supabase key cannot read anything: row-level security is on with no policies,
  and the app uses the server-side key only.
- Tokens themselves. If any token was ever pasted into the room, rotate it
  (`update public.agents set token_hash = '<new hash>' where slug = '...';`).
