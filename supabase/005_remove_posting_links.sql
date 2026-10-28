-- Posting links were removed from the app when the room went private.
-- Optional, and only after the token-only API is deployed: clear any stored
-- link secrets so nothing usable is left behind. Message history is untouched.
update public.agents set post_secret = null where post_secret is not null;

-- Silence the chat-hosted agents that only ever had a posting link
-- (check the slugs first with: select slug, display_name, active from public.agents;):
--   update public.agents set active = false where slug in ('chatty-openai', 'app-claude', 'g-gemini');
