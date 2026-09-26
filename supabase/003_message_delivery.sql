-- Apply during an attended database release, before deploying the new API.
-- A sender can reuse a request ID only for the same message.
begin;
lock table public.messages in access exclusive mode;

alter table public.agents
  add column handle text;

update public.agents
set handle = case slug
  when 'claire-codex' then 'claire'
  when 'andrew-claude' then 'andrew'
  when 'wren-actex' then 'wren'
  when 'chatty-openai' then 'chatty'
  when 'app-claude' then 'claude-app'
  when 'g-gemini' then 'g'
  when 'lana' then 'lana'
  else slug
end;

alter table public.agents
  alter column handle set not null,
  add constraint agents_handle_format check (handle ~ '^[a-z0-9][a-z0-9-]{0,39}$' and handle <> 'everyone');

create unique index agents_handle_lower_idx on public.agents (lower(handle));

alter table public.messages
  add column client_request_id text
    check (client_request_id is null or char_length(client_request_id) between 8 and 100),
  add column request_payload_hash text
    check (request_payload_hash is null or char_length(request_payload_hash) = 64),
  add column delivery_order bigint,
  add column recipients jsonb not null default '[]'::jsonb
    check (jsonb_typeof(recipients) = 'array'),
  add column addressing text not null default 'none'
    check (addressing in ('none', 'direct', 'everyone')),
  add column reply_to bigint references public.messages(id),
  add column context_preference text
    check (context_preference in ('fresh', 'continue')),
  add column expires_at timestamptz;

create unique index messages_sender_request_id_idx
  on public.messages(agent_id, client_request_id);

-- Serialize delivery-order assignment across all posting clients. Message IDs
-- can be allocated before commit; delivery_order follows commit order because
-- the advisory transaction lock is held until the inserting transaction ends.
update public.messages set delivery_order = id;
create sequence public.message_delivery_order_seq;
select setval(
  'public.message_delivery_order_seq',
  greatest(coalesce((select max(delivery_order) from public.messages), 0), 1),
  exists(select 1 from public.messages)
);

create function public.assign_message_delivery_order()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform pg_advisory_xact_lock(260926, 1);
  new.delivery_order := nextval('public.message_delivery_order_seq');
  return new;
end;
$$;

create trigger messages_delivery_order_before_insert
before insert on public.messages
for each row execute function public.assign_message_delivery_order();

alter table public.messages
  alter column delivery_order set not null;

create unique index messages_delivery_order_idx
  on public.messages(delivery_order);
commit;
