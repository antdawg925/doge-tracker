-- Schwab connection (server-only tokens) + LIVE protective stop orders.
--   broker_connections  one row per user+broker. Encrypted OAuth tokens (AES-GCM, key only in
--                       Vercel env). NO client access at all (RLS on, no policies, privileges
--                       revoked); the app reads status/expiry via /api/schwab/status.
--   broker_oauth_pending  code-exchange results waiting for the signed-in user to confirm
--                       (binds the Schwab login to the Supabase user that started it). Server-only.
--   stock_live_orders   the bot's real stop order per position (order id, stop, qty, flags,
--                       your own stops detected). Users read their own rows; server writes.
--   stock_positions.live  per-position "Live" toggle (default off).
--   stock_paper_events  + live kinds and a data column (LIVE log: request/response summaries).

create table if not exists public.broker_connections (
  user_id            uuid not null references auth.users (id) on delete cascade,
  broker             text not null default 'schwab' check (broker in ('schwab')),
  status             text not null default 'connected' check (status in ('connected', 'expired', 'error', 'disconnected')),
  enc_access         text,
  enc_refresh        text,
  access_expires_at  timestamptz,
  refresh_expires_at timestamptz,
  connected_at       timestamptz,
  accounts           jsonb not null default '[]'::jsonb,   -- [{ hash, last4 }]
  account_hash       text,
  account_last4      text,
  live_enabled       boolean not null default false,
  live_enabled_at    timestamptz,
  kill_switch        boolean not null default false,
  kill_switch_at     timestamptz,
  last_error         text,
  data               jsonb not null default '{}'::jsonb,   -- reminders sent, action counter per ET day
  updated_at         timestamptz not null default now(),
  primary key (user_id, broker)
);
alter table public.broker_connections enable row level security;
revoke all on public.broker_connections from anon, authenticated;

create table if not exists public.broker_oauth_pending (
  nonce_hash  text primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  broker      text not null default 'schwab',
  enc_access  text not null,
  enc_refresh text not null,
  access_expires_at  timestamptz not null,
  refresh_expires_at timestamptz not null,
  accounts    jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now()
);
alter table public.broker_oauth_pending enable row level security;
revoke all on public.broker_oauth_pending from anon, authenticated;

alter table public.stock_positions add column if not exists live boolean not null default false;

create table if not exists public.stock_live_orders (
  position_id       uuid primary key references public.stock_positions (id) on delete cascade,
  user_id           uuid not null references auth.users (id) on delete cascade,
  symbol            text not null,
  position_side     text not null check (position_side in ('long', 'short')),
  instruction       text not null check (instruction in ('SELL', 'BUY_TO_COVER')),
  order_id          text,
  status            text not null default 'none' check (status in ('none', 'working', 'filled', 'gone')),
  stop_price        double precision,
  qty               numeric,
  held_qty          numeric,
  adopted           boolean not null default false,
  placed_at         timestamptz,
  last_modified_day date,
  last_checked_at   timestamptz,
  fill_price        double precision,
  filled_at         timestamptz,
  flag              jsonb,                                  -- { code, message, at }
  foreign_stops     jsonb not null default '[]'::jsonb,     -- your own stop orders for this symbol
  data              jsonb not null default '{}'::jsonb,
  updated_at        timestamptz not null default now()
);
create index if not exists stock_live_orders_user_idx on public.stock_live_orders (user_id);
alter table public.stock_live_orders enable row level security;
drop policy if exists "read own" on public.stock_live_orders;
drop policy if exists "owner reads all" on public.stock_live_orders;
create policy "read own" on public.stock_live_orders for select to authenticated using (user_id = (select auth.uid()));
create policy "owner reads all" on public.stock_live_orders for select to authenticated using ((select public.is_owner()));
revoke all on public.stock_live_orders from anon, authenticated;
grant select on public.stock_live_orders to authenticated;

alter table public.stock_paper_events add column if not exists data jsonb;
alter table public.stock_paper_events drop constraint if exists stock_paper_events_kind_check;
alter table public.stock_paper_events add constraint stock_paper_events_kind_check check (kind in (
  'placed', 'modified', 'filled', 'closed', 'blocked',
  'live_request', 'live_placed', 'live_modified', 'live_canceled', 'live_filled', 'live_flag', 'live_error', 'live_adopted', 'live_setting'
));

-- "Live" is only set through /api/schwab/position-live (confirm + immediate check), never by a client write.
revoke insert on public.stock_positions from authenticated;
grant insert (id, user_id, symbol, side, shares, entry_price, entry_date, risk_usd, status, notes, closed_at, created_at, updated_at)
  on public.stock_positions to authenticated;
