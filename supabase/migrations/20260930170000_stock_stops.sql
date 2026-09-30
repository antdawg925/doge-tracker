-- Watch-only stock stop manager + short assist (Trade Smart Bot tier).
-- Nothing places orders: the server computes where the user should move their stop at
-- Schwab and alerts them. DOGE tables are untouched.
--
--   stock_positions    user-entered positions (own rows; write needs bot access)
--   stock_stops        versioned stop memory per position (server writes; monotonic trigger)
--   stock_alert_state  per-position alert de-dup state (server writes)
--   stock_alert_log    fired stock alerts (server writes)
--   stock_runs         one row per position per server run (server writes; 90-day 'hold' retention)
--   stock_symbol_info  server-only cache of Yahoo short interest / earnings (6 h)

-- ------------------------------------------------------------ stock_positions
create table if not exists public.stock_positions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  symbol      text not null check (symbol ~ '^[A-Z][A-Z0-9.\-]{0,9}$'),
  side        text not null check (side in ('long', 'short')),
  shares      numeric not null check (shares > 0),
  entry_price numeric not null check (entry_price > 0),
  entry_date  date not null default ((now() at time zone 'America/New_York')::date),
  risk_usd    numeric not null default 100 check (risk_usd >= 0),
  status      text not null default 'active' check (status in ('active', 'closed')),
  closed_at   timestamptz,
  notes       text check (notes is null or length(notes) <= 500),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists stock_positions_user_idx on public.stock_positions (user_id, status);
create index if not exists stock_positions_active_idx on public.stock_positions (status) where status = 'active';

create or replace function public.stock_positions_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  if new.status = 'closed' and old.status is distinct from 'closed' then
    new.closed_at := coalesce(new.closed_at, now());
  elsif new.status = 'active' then
    new.closed_at := null;
  end if;
  return new;
end;
$$;
drop trigger if exists stock_positions_touch on public.stock_positions;
create trigger stock_positions_touch before update on public.stock_positions
  for each row execute function public.stock_positions_touch();

-- ------------------------------------------------------------ stock_stops
-- anchor = side|entry_price|entry_date. Same version + anchor: a long stop can only move
-- up, a short buy-stop only down, whoever writes. A new version or anchor starts over.
create table if not exists public.stock_stops (
  position_id  uuid primary key references public.stock_positions (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  symbol       text not null,
  side         text not null check (side in ('long', 'short')),
  version      int not null,
  anchor       text not null,
  stop         double precision not null check (stop > 0),
  initial_stop double precision,
  data         jsonb not null default '{}'::jsonb,  -- latest snapshot: price, ATR, flags, size, P/L
  updated_at   timestamptz not null default now()
);
create index if not exists stock_stops_user_idx on public.stock_stops (user_id);

create or replace function public.stock_stops_ratchet()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.version = old.version and new.anchor = old.anchor and new.side = old.side then
    if new.side = 'long' and new.stop < old.stop then
      new.stop := old.stop;
    elsif new.side = 'short' and new.stop > old.stop then
      new.stop := old.stop;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists stock_stops_ratchet on public.stock_stops;
create trigger stock_stops_ratchet before update on public.stock_stops
  for each row execute function public.stock_stops_ratchet();

-- ------------------------------------------------------------ alerts
create table if not exists public.stock_alert_state (
  position_id uuid primary key references public.stock_positions (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

create table if not exists public.stock_alert_log (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  position_id uuid references public.stock_positions (id) on delete cascade,
  symbol      text not null,
  fired_at    timestamptz not null default now(),
  kind        text not null,   -- stop_set | raise_stop | lower_stop | near_stop | stop_hit | squeeze_warning | earnings_soon
  level       double precision,
  price       double precision,
  title       text,
  message     text
);
create index if not exists stock_alert_log_user_idx on public.stock_alert_log (user_id, fired_at desc);

-- ------------------------------------------------------------ stock_runs
create table if not exists public.stock_runs (
  id          bigint generated always as identity primary key,
  run_id      uuid,
  user_id     uuid not null references auth.users (id) on delete cascade,
  position_id uuid references public.stock_positions (id) on delete cascade,
  symbol      text not null,
  side        text,
  ran_at      timestamptz not null default now(),
  source      text,            -- cron | manual
  pass        text,            -- intraday | close | manual
  price       double precision,
  atr         double precision,
  stop        double precision,
  prev_stop   double precision,
  decision    text not null default 'hold' check (decision in (
                'hold', 'stop_set', 'stop_raised', 'stop_lowered', 'near_stop', 'stop_hit',
                'squeeze_warning', 'earnings_soon', 'error')),
  reason      text,
  error       text,
  duration_ms int,
  details     jsonb
);
create index if not exists stock_runs_pos_idx on public.stock_runs (position_id, ran_at desc);
create index if not exists stock_runs_user_idx on public.stock_runs (user_id, ran_at desc);
create index if not exists stock_runs_decision_idx on public.stock_runs (position_id, ran_at desc) where decision <> 'hold';
create index if not exists stock_runs_ran_idx on public.stock_runs (ran_at);

-- ------------------------------------------------------------ symbol info cache (server only)
create table if not exists public.stock_symbol_info (
  symbol     text primary key,
  data       jsonb not null default '{}'::jsonb,  -- shortPercentOfFloat, shortRatio, earningsAt
  error      text,
  fetched_at timestamptz not null default now()
);

-- ------------------------------------------------------------ RLS
-- stock_positions: read own (owner reads all); insert/update/delete own rows only with bot access.
alter table public.stock_positions enable row level security;
drop policy if exists "read own" on public.stock_positions;
create policy "read own" on public.stock_positions for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists "owner reads all" on public.stock_positions;
create policy "owner reads all" on public.stock_positions for select to authenticated
  using ((select public.is_owner()));
drop policy if exists "bot users insert own" on public.stock_positions;
create policy "bot users insert own" on public.stock_positions for insert to authenticated
  with check (user_id = (select auth.uid()) and (select public.has_bot_access()));
drop policy if exists "bot users update own" on public.stock_positions;
create policy "bot users update own" on public.stock_positions for update to authenticated
  using (user_id = (select auth.uid()) and (select public.has_bot_access()))
  with check (user_id = (select auth.uid()) and (select public.has_bot_access()));
drop policy if exists "bot users delete own" on public.stock_positions;
create policy "bot users delete own" on public.stock_positions for delete to authenticated
  using (user_id = (select auth.uid()) and (select public.has_bot_access()));
revoke all on public.stock_positions from anon, authenticated;
grant select, insert, delete on public.stock_positions to authenticated;
-- user_id / timestamps are not user-updatable.
grant update (symbol, side, shares, entry_price, entry_date, risk_usd, status, notes) on public.stock_positions to authenticated;

-- Server-written tables: users read their own rows, the owner reads all.
do $$
declare t text;
begin
  foreach t in array array['stock_stops', 'stock_alert_state', 'stock_alert_log', 'stock_runs']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "read own" on public.%I', t);
    execute format('drop policy if exists "owner reads all" on public.%I', t);
    execute format(
      'create policy "read own" on public.%I for select to authenticated
         using (user_id = (select auth.uid()))', t);
    execute format(
      'create policy "owner reads all" on public.%I for select to authenticated
         using ((select public.is_owner()))', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

alter table public.stock_symbol_info enable row level security;
revoke all on public.stock_symbol_info from anon, authenticated;

-- ------------------------------------------------------------ retention
-- 90 days of 'hold' / 'error' rows; real decisions are kept forever. Alert log: 1 year.
create or replace function public.stock_runs_retention()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.stock_runs
   where ran_at < now() - interval '90 days' and decision in ('hold', 'error');
  delete from public.stock_alert_log where fired_at < now() - interval '365 days';
$$;
revoke execute on function public.stock_runs_retention() from public, anon, authenticated;

select cron.schedule('trade-smart-stocks-retention', '27 11 * * *', $job$ select public.stock_runs_retention(); $job$);
