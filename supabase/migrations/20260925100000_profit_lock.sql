-- TSB Profit lock + Pause (per user, per symbol). Rule: the bot must never leave a user
-- below their starting amount while unattended.
--   baseline = shares × avg cost (paper book: paper shares × plan avg cost)
--   max_loss_usd ("willing to lose" line, default $1, user-set via /api/bot/guard/max-loss)
--   after every fill: book = cash + holdings at the fill price;
--   book < baseline − max_loss_usd → locked
--   locked / paused → no trades (the bot keeps watching: stops, prices, alerts)
-- Only the server writes (service role). Unlock / pause go through /api/bot/guard/*,
-- authenticated as the user themselves (the owner can't unlock someone else).

create table if not exists public.bot_guard (
  user_id           uuid not null references auth.users (id) on delete cascade,
  symbol            text not null default 'DOGE',
  locked            boolean not null default false,
  locked_at         timestamptz,
  lock_reason       text,
  paused            boolean not null default false,
  paused_at         timestamptz,
  paused_by         uuid,
  unlocked_at       timestamptz,
  unlocked_by       uuid,
  baseline_value    numeric,          -- starting amount ($)
  baseline_shares   numeric,
  baseline_avg_cost numeric,          -- plan avg cost; price at re-authorization after an unlock
  baseline_source   text check (baseline_source in ('plan_cost', 'reauthorized')),
  baseline_set_at   timestamptz,
  realized_pnl      numeric not null default 0,  -- cumulative, average-cost accounting
  max_loss_usd      numeric not null default 1 check (max_loss_usd >= 0),
  data              jsonb not null default '{}'::jsonb,  -- cost_units, cost_value, last_blocked, last_fill_book
  updated_at        timestamptz not null default now(),
  primary key (user_id, symbol)
);
alter table public.bot_guard add column if not exists max_loss_usd numeric not null default 1;
alter table public.bot_guard drop constraint if exists bot_guard_max_loss_nonneg;
alter table public.bot_guard add constraint bot_guard_max_loss_nonneg check (max_loss_usd >= 0);
create index if not exists bot_guard_locked_idx on public.bot_guard (locked) where locked;

alter table public.bot_guard enable row level security;
drop policy if exists "read own" on public.bot_guard;
create policy "read own" on public.bot_guard
  for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "owner reads all" on public.bot_guard;
create policy "owner reads all" on public.bot_guard
  for select to authenticated using ((select public.is_owner()));
revoke all on public.bot_guard from anon, authenticated;
grant select on public.bot_guard to authenticated;

-- New run decisions.
alter table public.bot_runs drop constraint if exists bot_runs_decision_check;
alter table public.bot_runs add constraint bot_runs_decision_check check (decision in (
  'hold', 'would_sell_slice', 'would_buy_back', 'would_exit_core', 'stop_raised', 'error',
  'locked', 'blocked_locked', 'blocked_paused', 'blocked_below_baseline'
));
