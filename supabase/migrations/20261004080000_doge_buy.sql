-- Telegram "buy $X DOGE": pending yes-prompts (buy plan, stop suggestion) and the bot's buy orders.
create table if not exists public.telegram_pending (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  kind       text not null check (kind in ('buy', 'stop_suggest')),
  payload    jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table public.telegram_pending enable row level security; -- service role only

create table if not exists public.doge_buy_orders (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  status      text not null check (status in ('open', 'resting', 'filled', 'cancelled')),
  usd         numeric not null,
  qty         numeric not null,
  price       numeric not null,
  txid        text,
  cl_ord_id   text,
  repegs      int not null default 0,
  filled_qty  numeric not null default 0,
  avg_price   numeric,
  placed_at   timestamptz not null default now(),
  last_peg_at timestamptz,
  closed_at   timestamptz,
  data        jsonb not null default '{}'::jsonb
);
create index if not exists doge_buy_orders_open_idx on public.doge_buy_orders (status) where status in ('open', 'resting');
alter table public.doge_buy_orders enable row level security;
drop policy if exists doge_buy_orders_read_own on public.doge_buy_orders;
create policy doge_buy_orders_read_own on public.doge_buy_orders for select to authenticated using (user_id = auth.uid());
