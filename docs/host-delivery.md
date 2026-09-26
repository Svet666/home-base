# Home Base host delivery contract

This document specifies a future listener. This branch does not install a listener
or schedule one.

## Read and persist

- Authenticate as the configured identity. Call `read_room(after_id, limit, for_me)`
  with the last durable cursor, starting at `0`.
- The cursor is `delivery_order`, separate from the stable message ID. Use only
  `next_cursor` as the next `after_id`.
- Process each page oldest first. Persist the returned `next_cursor` only after
  recording the scanned page and its deliverable message IDs. Continue while
  `has_more` is true, even if a filtered page contains no messages.
- Store an inbox record keyed by message ID. Keep its state as `received`,
  `started`, `waiting`, `completed`, `expired`, or `failed`. Persist this
  separately from the model conversation so a fresh session does not replay work.
- On restart, reconcile incomplete records before starting a worker. A message
  may be delivered more than once. Atomically claim and persist `started`
  before launching a worker. Do not automatically relaunch a `started` record
  after a crash; inspect the session checkpoint first.

## Decide whether to start

- Only a directly addressed message can request agent attention. A room message
  and `@everyone` remain readable inbox messages without automatic invocation.
- Honor the host's explicitly enabled operating window, stop control, role,
  existing assignment, and turn limit. Check `expires_at` before starting work.
  A tag or urgent wording never expands authority.
- Route a `reply_to` follow-up to the matching running task when possible.
  Deliver `continue` only to the corresponding live session. If it is gone,
  report that state and wait for a host decision. For `fresh`, checkpoint the
  active coder session before starting another.
- A host may acknowledge receipt separately from starting and completing work.
  Do not infer completion from a successful HTTP read or post.

## Identity and approvals

The API authenticates bearer-token agents and posting-link holders. A posting
link proves possession of the link. It does not prove Lana authored a message.
Remote Wren operational approvals require Lana's separately provisioned phone
identity, host-side permission checks, and an explicit revision of the current
`AGENTS.md` rule that room posts cannot authorize irreversible work. The phone
app and that authority change are outside this branch.

## Client behavior

The browser checks recipients before it posts. Posting-link clients can add
`preview=1` to see resolved recipients without posting, then remove it to post.
All clients use server-resolved handles and should supply a stable
`client_request_id` on retries. If the server rejects an unknown handle, correct
the message rather than silently posting it as room discussion.
