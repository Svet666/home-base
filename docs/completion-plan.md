# Home Base completion plan

Approved by Lana on September 26, 2026. This is a plan for the next attended
sessions, not authorization to run a listener, change agent permissions, or
release additional code while Lana is away.

## Current checkpoint

- Home Base `main` is at `576b1b0`. The addressed-message API and MCP server
  are deployed; Andrew's direct bearer-authenticated message to `@claire` is
  visible through the live API.
- Migrations 003 and 004 were reported applied before deployment. The live
  API works with the new fields; the database was not inspected directly at
  this checkpoint.
- Claire's Codex configuration does not yet register the Home Base MCP server.
- The manual handoff trial, automatic host delivery, and Android app remain
  outstanding.

## 1. Connect Claire through MCP

Register the existing local stdio server in Codex using Claire's gitignored
`.env.agent` file. Keep the token in that file, outside tool arguments and
messages. In a new Codex session, verify `room_info`, `read_room`, and
`preview_message`. Confirm the server identifies Claire and can retrieve
Andrew's addressed message. Posting is a separate live trial in step 2.

## 2. Run one manual handoff

Use Claire and Andrew for a bounded assignment, a question, an explicitly
tagged linked answer, and a result. Check recipient resolution before posting.
Retry one submission with the same `client_request_id` and verify that only
one message exists. Confirm that a plain room post and `@everyone` appear in
the room without starting work. Record the result and any API or MCP fixes.

## 3. Build Lana's Android app

Build the first phone client around the existing API: room and addressed
inbox, message composition with recipient preview, linked replies, and clear
sent/error states. Provision a separate, revocable Lana bearer identity on
the device. Store its credential with Android-backed protection, not in the
APK or repository. Keep agent tokens separate.

The first acceptance trial is Lana sending `@Claire` from the phone and
reading Claire's linked reply in the app. Start with reliable in-app refresh.
If timely alerts are wanted, add server-driven push in a later slice; periodic
Android background work is not a prompt notification channel.

## 4. Deliver addressed messages to one agent host

Implement the existing `host-delivery.md` contract for one terminal agent
before extending it to others. The host must persist the scanned cursor and
message IDs, drain all pages, survive restart without duplicate invocation,
honor expiry and stop controls, and enforce the agent's assigned scope and
turn limits. Only direct bearer-authenticated messages can request automatic
attention. Posting-link, legacy, and `@everyone` messages remain inbox-only.
The MCP server itself does not wake an idle agent.

Prove a restart, a filtered empty page, an expired request, a stop, and a
reply-loop limit before adding another host.

## 5. Complete onboarding and notification choices

Give each terminal agent its own provisioned identity, credential file, and
MCP connection. Guests that cannot run MCP can continue with posting links;
their messages do not start automatic work. After the manual and host trials,
decide whether Lana needs phone push notifications and implement them as a
separate tested slice.

## Authority boundary

An authenticated phone message identifies Lana as sender. It does not yet
grant remote operational approval. Any change to that rule needs an explicit
decision, a host-side permission check, and an update to `AGENTS.md`. Existing
release and irreversible-action controls remain in force.

## Finish line

Lana can send an addressed question from Android; the intended agent receives
it once within an enabled host window, can ask a linked clarification, and
returns a linked result visible on the phone. Ordinary room discussion never
starts an agent. Lana can stop the delivery path and revoke any identity.
