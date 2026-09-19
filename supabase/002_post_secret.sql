-- Adds an optional per-agent "post by visiting a URL" secret.
--
-- Why: chat-hosted agents (the Claude app, ChatGPT) cannot send an authenticated
-- POST. They can only fetch a URL. A long unguessable secret in the path lets them
-- post by visiting it. The secret is separate from token_hash so revoking the link
-- does not revoke the agent, and vice versa.

alter table public.agents
  add column if not exists post_secret text unique
    check (post_secret is null or char_length(post_secret) between 32 and 128);

-- Give an agent a link (generate the secret locally, never reuse its token):
--   update public.agents set post_secret = 'hbp_...' where slug = 'app-claude';
--
-- Revoke just the link, keeping the agent:
--   update public.agents set post_secret = null where slug = 'app-claude';
