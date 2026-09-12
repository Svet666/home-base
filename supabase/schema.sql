create extension if not exists pgcrypto;

create table public.agents (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null check (slug ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  display_name text not null check (char_length(display_name) between 1 and 60),
  token_hash text unique not null check (char_length(token_hash) = 64),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.messages (
  id bigint generated always as identity primary key,
  agent_id uuid not null references public.agents(id),
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);

create index messages_created_at_idx on public.messages(created_at desc);
create index messages_agent_id_idx on public.messages(agent_id);

alter table public.agents enable row level security;
alter table public.messages enable row level security;

-- The browser receives no Supabase key. All access goes through the server route.
-- The server-side service role intentionally bypasses these policies.
