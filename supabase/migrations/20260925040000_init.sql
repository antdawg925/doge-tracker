-- Trade Smart: auth profiles, invite-gated signup, per-user DOGE plan storage.
-- Every table has RLS on. Invite validation/consumption runs server-side
-- (/api/signup) with the service key via consume_invite()/release_invite().

-- ---------------------------------------------------------------- profiles
create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  email        text,
  display_name text,
  role         text not null default 'member' check (role in ('owner', 'member')),
  created_at   timestamptz not null default now()
);
alter table public.profiles enable row level security;

-- SECURITY DEFINER so policies can check the caller's role without RLS recursion.
create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and role = 'owner'
  );
$$;
revoke execute on function public.is_owner() from public, anon;
grant execute on function public.is_owner() to authenticated, service_role;

drop policy if exists "profiles: read own" on public.profiles;
create policy "profiles: read own" on public.profiles
  for select to authenticated using (id = (select auth.uid()));
drop policy if exists "profiles: owner reads all" on public.profiles;
create policy "profiles: owner reads all" on public.profiles
  for select to authenticated using ((select public.is_owner()));
-- No insert/update/delete policies: profiles are written by the server (service key) only,
-- so a member can never promote themselves.

-- ----------------------------------------------------------------- invites
create table if not exists public.invites (
  code         text primary key check (code ~ '^[A-Z0-9-]{6,40}$'),
  label        text,
  role         text not null default 'member' check (role in ('owner', 'member')),
  max_uses     int  not null default 1 check (max_uses >= 1),
  uses         int  not null default 0 check (uses >= 0),
  active       boolean not null default true,
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);
alter table public.invites enable row level security;

drop policy if exists "invites: owner select" on public.invites;
create policy "invites: owner select" on public.invites
  for select to authenticated using ((select public.is_owner()));
-- Owners create member codes from the UI; owner codes are only minted with SQL.
drop policy if exists "invites: owner insert" on public.invites;
create policy "invites: owner insert" on public.invites
  for insert to authenticated
  with check ((select public.is_owner()) and role = 'member' and uses = 0);
drop policy if exists "invites: owner update" on public.invites;
create policy "invites: owner update" on public.invites
  for update to authenticated
  using ((select public.is_owner()))
  with check ((select public.is_owner()));

-- Atomically take one use of a code. Returns the invite row, or no row when the
-- code is unknown / inactive / used up. Concurrent callers can't overshoot max_uses.
create or replace function public.consume_invite(p_code text)
returns setof public.invites
language sql
security definer
set search_path = ''
as $$
  update public.invites
     set uses = uses + 1, last_used_at = now()
   where code = upper(trim(p_code)) and active and uses < max_uses
  returning *;
$$;

-- Give a use back when account creation fails after consume_invite().
create or replace function public.release_invite(p_code text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.invites set uses = greatest(uses - 1, 0) where code = upper(trim(p_code));
$$;

revoke execute on function public.consume_invite(text) from public, anon, authenticated;
revoke execute on function public.release_invite(text) from public, anon, authenticated;
grant execute on function public.consume_invite(text) to service_role;
grant execute on function public.release_invite(text) to service_role;

-- ------------------------------------------------------- DOGE plan storage
create table if not exists public.doge_plans (
  user_id    uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  plan       jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.plan_history (
  id            text primary key default gen_random_uuid()::text,
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  saved_at      timestamptz not null default now(),
  plan          jsonb not null,
  note          text,
  price_at_save double precision,
  stop_at_save  double precision,
  market        jsonb -- full snapshot at save: { price, atr, atrPct, effectiveStop }
);
create index if not exists plan_history_user_saved_idx on public.plan_history (user_id, saved_at desc);

-- Ratchet memory. version = STOP_RULES_VERSION at write time; stale versions are discarded client-side.
create table if not exists public.stop_memory (
  user_id    uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  version    int not null,
  data       jsonb not null, -- { effectiveStop, anchorAt, updatedAt }
  updated_at timestamptz not null default now()
);

-- Per-rule arming state for crossing alerts.
create table if not exists public.alert_state (
  user_id    uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.alert_log (
  id       text primary key default gen_random_uuid()::text,
  user_id  uuid not null default auth.uid() references auth.users (id) on delete cascade,
  fired_at timestamptz not null default now(),
  kind     text,             -- rule id: sell, breakout, stop, ...
  level    double precision,
  price    double precision,
  title    text,
  message  text
);
create index if not exists alert_log_user_fired_idx on public.alert_log (user_id, fired_at desc);

-- Own-rows-only CRUD on every per-user table.
do $$
declare t text;
begin
  foreach t in array array['doge_plans', 'plan_history', 'stop_memory', 'alert_state', 'alert_log']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "own rows" on public.%I', t);
    execute format(
      'create policy "own rows" on public.%I for all to authenticated
         using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t);
  end loop;
end $$;

-- Signed-out (anon) clients get nothing at all, even before RLS.
revoke all on public.profiles, public.invites, public.doge_plans, public.plan_history,
  public.stop_memory, public.alert_state, public.alert_log from anon;
