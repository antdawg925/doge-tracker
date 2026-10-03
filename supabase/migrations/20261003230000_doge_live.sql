-- DOGE live plan on Kraken (Round 4 rules). DRY-RUN by default: the bot computes and logs the
-- exact orders it would place; it places nothing until a trade-enabled key exists in Vercel env
-- (KRAKEN_TRADE_KEY / KRAKEN_TRADE_SECRET) AND the user turns the Live switch on.
--   doge_live_plans  one row per user: config (start value/date, pot, zones, params), engine
--                    state (HWM, lock, pot, resting orders), last snapshot for the UI, Live and
--                    kill switches, a run lease (no two runs act on one plan at once).
--   doge_live_log    every intended (dry) or placed (live) order action, fill and refusal.
-- Clients only READ their own rows; every write goes through /api/bot/doge-live/* (service role).

create table if not exists public.doge_live_plans (
  user_id         uuid primary key references auth.users (id) on delete cascade,
  config          jsonb not null default '{}'::jsonb,
  state           jsonb,
  snapshot        jsonb,
  status          text not null default 'active' check (status in ('active', 'ended')),
  live_enabled    boolean not null default false,
  live_enabled_at timestamptz,
  kill_switch     boolean not null default false,
  kill_switch_at  timestamptz,
  lease_until     timestamptz,
  last_run_at     timestamptz,
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
alter table public.doge_live_plans enable row level security;
drop policy if exists "read own" on public.doge_live_plans;
drop policy if exists "owner reads all" on public.doge_live_plans;
create policy "read own" on public.doge_live_plans for select to authenticated using (user_id = (select auth.uid()));
create policy "owner reads all" on public.doge_live_plans for select to authenticated using ((select public.is_owner()));
revoke all on public.doge_live_plans from anon, authenticated;
grant select on public.doge_live_plans to authenticated;

create table if not exists public.doge_live_log (
  id         bigserial primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  plan_id    text,
  at         timestamptz not null default now(),
  mode       text not null check (mode in ('dry', 'live')),
  role       text,          -- stop | zone | pot | plan
  action     text not null, -- place | amend | cancel | fill | flag | config | ...
  status     text not null, -- would_place | placed | refused | error | dry_fill | filled | ...
  side       text,
  ordertype  text,
  price      double precision,
  qty        double precision,
  reason     text,
  txid       text,
  cl_ord_id  text,
  details    jsonb not null default '{}'::jsonb
);
create index if not exists doge_live_log_user_idx on public.doge_live_log (user_id, at desc);
alter table public.doge_live_log enable row level security;
drop policy if exists "read own" on public.doge_live_log;
drop policy if exists "owner reads all" on public.doge_live_log;
create policy "read own" on public.doge_live_log for select to authenticated using (user_id = (select auth.uid()));
create policy "owner reads all" on public.doge_live_log for select to authenticated using ((select public.is_owner()));
revoke all on public.doge_live_log from anon, authenticated;
grant select on public.doge_live_log to authenticated;
