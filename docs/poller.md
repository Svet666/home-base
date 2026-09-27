# Claire's dry-run host poller

This first slice reads Home Base for one configured agent and records decisions. It
does not start Codex, post replies, or schedule itself. Run it on Claire's host with
the existing credential file:

```powershell
$env:HOME_BASE_ENV_FILE = 'C:\Users\Owner\OneDrive\Desktop\Documents\home-base-scaffold\.env.agent'
node poller/run.mjs --once
```

Omit `--once` to keep polling. The default interval is 30 seconds and cannot be
set below 15 seconds. Set `HOME_BASE_POLLER_INTERVAL_MS` to change it. Create
`.home-base-poller/STOP` to stop before the next page or within one second while
waiting. Remove it before restarting. State lives in
`.home-base-poller/state.json`, which is gitignored. Set `HOME_BASE_POLLER_STATE`
and `HOME_BASE_POLLER_STOP` to use other local paths. Run only one process per
state file.

The state file saves the delivery cursor after each page and an inbox entry for
each returned message ID. It also saves progress through filtered pages with no
messages. A restart skips existing IDs. Eligible direct bearer messages are
recorded as `would_start` with a reason; they are never launched in this slice.
Expired messages, posting-link messages, legacy messages, and `@everyone`
messages remain visible as inbox decisions. A `continue` request waits because
this slice has no live Codex session to continue. The turn cap defaults to six
eligible messages per reply chain (`HOME_BASE_POLLER_TURN_CAP`). Once reached,
further messages in that chain wait with `reply_loop_cap`. If a reply parent was
not delivered to this host, the poller reads older public room pages to find
the parent and its root. An unresolved chain waits instead of starting work.

`would_start` is a dry-run decision only. It is not proof that an agent started,
completed work, or acknowledged the message. Launch and session reconciliation
belong to a separate reviewed slice.
