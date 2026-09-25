-- Admin: feature flags (owner-first rollouts). User deletion cascades through
-- the existing ON DELETE CASCADE user FKs (profiles, doge_plans, plan_history,
-- stop_memory, alert_state, alert_log, access_key_redemptions); access_keys.created_by
-- is SET NULL so keys survive their creator.

create table if not exists public.feature_flags (
  key         text primary key check (key ~ '^[a-z0-9_]{2,40}$'),
  description text,
  enabled_for text not null default 'owner' check (enabled_for in ('owner', 'bot', 'everyone')),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users (id) on delete set null
);
alter table public.feature_flags enable row level security;

-- Signed-out visitors only see flags that are on for everyone; signed-in users read all
-- (the client decides per tier). Only the owner can change a flag's audience.
drop policy if exists "flags: public read (everyone)" on public.feature_flags;
create policy "flags: public read (everyone)" on public.feature_flags
  for select to anon using (enabled_for = 'everyone');
drop policy if exists "flags: signed-in read" on public.feature_flags;
create policy "flags: signed-in read" on public.feature_flags
  for select to authenticated using (true);
drop policy if exists "flags: owner update" on public.feature_flags;
create policy "flags: owner update" on public.feature_flags
  for update to authenticated
  using ((select public.is_owner()))
  with check ((select public.is_owner()));

revoke all on public.feature_flags from anon, authenticated;
grant select on public.feature_flags to anon, authenticated;
grant update (enabled_for, updated_at, updated_by) on public.feature_flags to authenticated;

insert into public.feature_flags (key, description, enabled_for)
values ('kraken_panel', 'Kraken account panel (read-only balances / positions)', 'owner')
on conflict (key) do nothing;
