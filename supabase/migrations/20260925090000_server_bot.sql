-- Server-side, WATCH-ONLY Trade Smart Bot.
--   pg_cron (every 5 min) → pg_net POST https://trade-smart-app.vercel.app/api/bot/run
--   with header x-bot-secret read from Supabase Vault (secret name 'bot_cron_secret').
--   The secret itself is created out-of-band with vault.create_secret(); it is never
--   stored in this file or in the cron job definition.
-- No orders are placed anywhere. Kraken is read (Balance / OpenOrders) for the owner only.
--
-- New tables are keyed by (user_id, symbol) so more symbols / users plug in later.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- ------------------------------------------------------------ bot_runs
create table if not exists public.bot_runs (
  id             bigint generated always as identity primary key,
  run_id         uuid,
  user_id        uuid not null references auth.users (id) on delete cascade,
  symbol         text not null default 'DOGE',
  ran_at         timestamptz not null default now(),
  source         text,                      -- cron | manual | paper_restart
  price          double precision,
  atr            double precision,
  atr_pct        double precision,
  stage          smallint,
  effective_stop double precision,
  trail_level    double precision,
  floor          double precision,
  highest_high   double precision,
  decision       text not null default 'hold'
                 check (decision in ('hold', 'would_sell_slice', 'would_buy_back', 'would_exit_core', 'stop_raised', 'error')),
  reason         text,
  kraken_balance numeric,                   -- owner only (read-only key)
  open_orders    int,                       -- owner only
  error          text,
  duration_ms    int,
  details        jsonb                      -- alerts fired, paper snapshot, kraken detail
);
create index if not exists bot_runs_user_ran_idx on public.bot_runs (user_id, ran_at desc);
create index if not exists bot_runs_decision_idx on public.bot_runs (user_id, ran_at desc) where decision <> 'hold';
create index if not exists bot_runs_ran_idx on public.bot_runs (ran_at);

-- ------------------------------------------------------- bot_heartbeat
create table if not exists public.bot_heartbeat (
  symbol          text primary key,
  last_run_at     timestamptz,
  last_source     text,
  run_id          uuid,
  users_processed int not null default 0,
  errors          int not null default 0,       -- errors in the last run
  last_error      text,
  duration_ms     int,
  updated_at      timestamptz not null default now()
);

-- ------------------------------------------------------------ paper trading
create table if not exists public.paper_state (
  user_id        uuid not null references auth.users (id) on delete cascade,
  symbol         text not null default 'DOGE',
  started_at     timestamptz not null default now(),
  start_price    double precision not null,
  core_units     double precision not null default 0,
  slice_units    double precision not null default 0,
  cash           double precision not null default 0,
  last_action_at timestamptz,
  data           jsonb not null default '{}'::jsonb,  -- notional, source, slice_cash, core_cash, core_stopped, cycles
  updated_at     timestamptz not null default now(),
  primary key (user_id, symbol)
);

create table if not exists public.paper_trades (
  id      bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  symbol  text not null default 'DOGE',
  at      timestamptz not null default now(),
  side    text not null check (side in ('buy', 'sell')),
  units   double precision not null,
  price   double precision not null,
  reason  text
);
create index if not exists paper_trades_user_idx on public.paper_trades (user_id, symbol, at desc);

-- RLS: users read their own rows; the owner reads all. Writes: server (service role) only.
do $$
declare t text;
begin
  foreach t in array array['bot_runs', 'paper_state', 'paper_trades']
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

alter table public.bot_heartbeat enable row level security;
drop policy if exists "owner reads" on public.bot_heartbeat;
create policy "owner reads" on public.bot_heartbeat
  for select to authenticated using ((select public.is_owner()));
revoke all on public.bot_heartbeat from anon, authenticated;
grant select on public.bot_heartbeat to authenticated;

-- ------------------------------------------------ Telegram (optional, later)
-- Server-written only: column grants still let users update display_name alone,
-- so a user can't set role / bot_access (or this) directly.
alter table public.profiles add column if not exists telegram_chat_id text;

-- ------------------------------------------------ stop_memory ratchet guard
-- The server bot is the source of truth for stop_memory, but the browser may
-- still write it (plan save / restart). For the same rules version + anchor the
-- stored stop can never move down, whoever writes.
create or replace function public.stop_memory_ratchet()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  old_stop double precision := nullif(old.data ->> 'effectiveStop', '')::double precision;
  new_stop double precision := nullif(new.data ->> 'effectiveStop', '')::double precision;
begin
  if new.version = old.version
     and (new.data ->> 'anchorAt') is not distinct from (old.data ->> 'anchorAt')
     and old_stop is not null
     and (new_stop is null or new_stop < old_stop) then
    new.data := jsonb_set(new.data, '{effectiveStop}', to_jsonb(old_stop));
  end if;
  return new;
end;
$$;
drop trigger if exists stop_memory_ratchet on public.stop_memory;
create trigger stop_memory_ratchet before update on public.stop_memory
  for each row execute function public.stop_memory_ratchet();

-- ------------------------------------------------ retention
-- Keep 90 days of 'hold' (and failed-run 'error') rows; every real decision
-- (would_sell_slice, would_buy_back, would_exit_core, stop_raised) is kept forever.
create or replace function public.bot_runs_retention()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.bot_runs
   where ran_at < now() - interval '90 days' and decision in ('hold', 'error');
  delete from cron.job_run_details where end_time < now() - interval '14 days';
$$;
revoke execute on function public.bot_runs_retention() from public, anon, authenticated;

-- ------------------------------------------------ schedules
select cron.schedule(
  'trade-smart-bot-run',
  '*/5 * * * *',
  $job$
  select net.http_post(
    url := 'https://trade-smart-app.vercel.app/api/bot/run',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-bot-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'bot_cron_secret' limit 1)
    ),
    body := '{"source":"cron"}'::jsonb,
    timeout_milliseconds := 55000
  );
  $job$
);

select cron.schedule('trade-smart-bot-retention', '17 11 * * *', $job$ select public.bot_runs_retention(); $job$);
