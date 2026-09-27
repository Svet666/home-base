-- Apply after 003 and before deploying token/link addressing.
-- Existing room messages remain readable but cannot request automatic attention.
begin;
alter table public.messages
  add column auth_method text not null default 'legacy'
  check (auth_method in ('legacy', 'bearer', 'posting_link'));
commit;
