-- Stock PAPER trading (simulated protective stop orders moved by the bot) + a separate
-- stocks Profit lock / Pause guard. Server writes only; users read their own rows, the
-- owner reads all. DOGE tables (bot_guard etc.) are untouched: a DOGE lock never freezes
-- stocks and vice versa.

-- One simulated stop order per stock position (the broker adapter's state).
create table if not exists public.stock_paper_orders (
  position_id     uuid primary key references public.stock_positions (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  symbol          text not null,
  position_side   text not null check (position_side in ('long', 'short')),
  order_side      text not null check (order_side in ('sell', 'buy')),
  qty             numeric not null,
  entry_price     numeric not null,
  stop_price      double precision,
  status          text not null check (status in ('working', 'filled', 'closed', 'blocked')),
  anchor          text not null,           -- side|entry|date|shares; a change = re-entry
  broker          text not null default 'paper',
  broker_order_id text,
  placed_at       timestamptz,
  modified_at     timestamptz,
  filled_at       timestamptz,
  fill_price      double precision,
  realized_pnl    double precision,
  last_price      double precision,
  last_price_at   timestamptz,
  data            jsonb not null default '{}'::jsonb,  -- prior_realized, prior_hold, gap, last_check_day, blocked_reason
  updated_at      timestamptz not null default now()
);
create index if not exists stock_paper_orders_user_idx on public.stock_paper_orders (user_id);

-- Order log: placed / modified / filled / closed / blocked (old → new price). Kept forever.
create table if not exists public.stock_paper_events (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  position_id uuid references public.stock_positions (id) on delete cascade,
  symbol      text not null,
  at          timestamptz not null default now(),
  kind        text not null check (kind in ('placed', 'modified', 'filled', 'closed', 'blocked')),
  old_price   double precision,
  new_price   double precision,
  fill_price  double precision,
  qty         numeric,
  pnl         double precision,
  reason      text,
  guard_note  text,
  run_id      uuid
);
create index if not exists stock_paper_events_user_idx on public.stock_paper_events (user_id, at desc);
create index if not exists stock_paper_events_pos_idx on public.stock_paper_events (position_id, at desc);

-- Stocks Profit lock / Max loss / Pause, keyed (user_id, book). Same columns as bot_guard.
create table if not exists public.stock_guard (
  user_id           uuid not null references auth.users (id) on delete cascade,
  book              text not null default 'stocks' check (book = 'stocks'),
  locked            boolean not null default false,
  locked_at         timestamptz,
  lock_reason       text,
  paused            boolean not null default false,
  paused_at         timestamptz,
  paused_by         uuid,
  unlocked_at       timestamptz,
  unlocked_by       uuid,
  baseline_value    numeric,          -- Σ entry basis of active positions (+ P/L at last authorize)
  baseline_shares   numeric,
  baseline_avg_cost numeric,
  baseline_source   text,
  baseline_set_at   timestamptz,
  realized_pnl      numeric not null default 0,
  max_loss_usd      numeric not null default 1 check (max_loss_usd >= 0),
  data              jsonb not null default '{}'::jsonb,  -- reauth_pnl, last_fill_book
  updated_at        timestamptz not null default now(),
  primary key (user_id, book)
);

do $$
declare t text;
begin
  foreach t in array array['stock_paper_orders', 'stock_paper_events', 'stock_guard']
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
