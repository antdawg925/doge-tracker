-- Open email+password signup; access keys unlock the "Trade Smart Bot" tier.
--   member (free): Research, Scanner, Short Kings
--   bot tier (profiles.bot_access or owner): Alerts / DOGE plan storage
--   owner: access keys admin (and the Kraken/bot connection later)

-- ------------------------------------------------------------ profiles
alter table public.profiles add column if not exists bot_access boolean not null default false;

-- Every new auth user gets a member profile without bot access.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, display_name, role, bot_access)
  values (
    new.id,
    new.email,
    nullif(left(trim(coalesce(new.raw_user_meta_data ->> 'display_name', '')), 60), ''),
    'member',
    false
  )
  on conflict (id) do nothing;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Users may edit only their display name (column-level grant); role and
-- bot_access change only through redeem_access_key() / SQL.
revoke insert, update, delete on public.profiles from authenticated;
grant update (display_name) on public.profiles to authenticated;
drop policy if exists "profiles: update own" on public.profiles;
create policy "profiles: update own" on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

create or replace function public.has_bot_access()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
     where id = auth.uid() and (bot_access or role = 'owner')
  );
$$;
revoke execute on function public.has_bot_access() from public, anon;
grant execute on function public.has_bot_access() to authenticated, service_role;

-- ------------------------------------------------ invites -> access_keys
do $$
begin
  if to_regclass('public.access_keys') is null and to_regclass('public.invites') is not null then
    alter table public.invites rename to access_keys;
  end if;
end $$;

drop function if exists public.consume_invite(text);
drop function if exists public.release_invite(text);

drop policy if exists "invites: owner select" on public.access_keys;
drop policy if exists "invites: owner insert" on public.access_keys;
drop policy if exists "invites: owner update" on public.access_keys;
drop policy if exists "access_keys: owner select" on public.access_keys;
create policy "access_keys: owner select" on public.access_keys
  for select to authenticated using ((select public.is_owner()));
-- Owners mint member keys from the UI; owner keys only via SQL.
drop policy if exists "access_keys: owner insert" on public.access_keys;
create policy "access_keys: owner insert" on public.access_keys
  for insert to authenticated
  with check ((select public.is_owner()) and role = 'member' and uses = 0);
drop policy if exists "access_keys: owner update" on public.access_keys;
create policy "access_keys: owner update" on public.access_keys
  for update to authenticated
  using ((select public.is_owner()))
  with check ((select public.is_owner()));

-- Who redeemed what (owner can see it).
create table if not exists public.access_key_redemptions (
  id          bigint generated always as identity primary key,
  code        text not null references public.access_keys (code) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  redeemed_at timestamptz not null default now()
);
alter table public.access_key_redemptions enable row level security;
drop policy if exists "redemptions: owner select" on public.access_key_redemptions;
create policy "redemptions: owner select" on public.access_key_redemptions
  for select to authenticated using ((select public.is_owner()));

-- Atomically take one use of a key and grant the tier in the same transaction.
-- Returns the caller's new (role, bot_access), or no row when the key is unknown /
-- inactive / used up. Concurrent redemptions can't overshoot max_uses.
create or replace function public.redeem_access_key(p_code text, p_user uuid)
returns table (role text, bot_access boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  k public.access_keys;
begin
  update public.access_keys
     set uses = uses + 1, last_used_at = now()
   where code = upper(trim(p_code)) and active and uses < max_uses
  returning * into k;
  if not found then
    return;
  end if;

  update public.profiles p
     set bot_access = true,
         role = case when k.role = 'owner' then 'owner' else p.role end
   where p.id = p_user
  returning p.role, p.bot_access into role, bot_access;
  if not found then
    raise exception 'profile % not found', p_user; -- rolls back the use
  end if;

  insert into public.access_key_redemptions (code, user_id) values (k.code, p_user);
  return next;
end;
$$;
revoke execute on function public.redeem_access_key(text, uuid) from public, anon, authenticated;
grant execute on function public.redeem_access_key(text, uuid) to service_role;

-- --------------------------------------- bot-tier data: read own, write needs bot access
do $$
declare t text;
begin
  foreach t in array array['doge_plans', 'plan_history', 'stop_memory', 'alert_state', 'alert_log']
  loop
    execute format('drop policy if exists "own rows" on public.%I', t);
    execute format('drop policy if exists "own rows: read" on public.%I', t);
    execute format('drop policy if exists "own rows: write (bot tier)" on public.%I', t);
    execute format(
      'create policy "own rows: read" on public.%I for select to authenticated
         using (user_id = (select auth.uid()))', t);
    execute format(
      'create policy "own rows: write (bot tier)" on public.%I for all to authenticated
         using (user_id = (select auth.uid()) and (select public.has_bot_access()))
         with check (user_id = (select auth.uid()) and (select public.has_bot_access()))', t);
  end loop;
end $$;

revoke all on public.profiles, public.access_keys, public.access_key_redemptions,
  public.doge_plans, public.plan_history, public.stop_memory, public.alert_state,
  public.alert_log from anon;
