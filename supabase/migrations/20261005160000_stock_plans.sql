-- Dip-buy plans: pending Schwab limit buys that become a protective stop once filled.
-- Never touches TSLA. Default dry_run = true; live only when the user opts in (and Schwab Live is on).
create table if not exists public.stock_plans (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  symbol          text not null check (symbol = upper(symbol) and symbol <> 'TSLA' and length(symbol) between 1 and 10),
  side            text not null default 'long' check (side = 'long'),
  shares          integer not null check (shares > 0),
  amount_usd      numeric(14, 2),
  limit_price     numeric(14, 6) not null check (limit_price > 0),
  stop_price      numeric(14, 6) not null check (stop_price > 0),
  t1_price        numeric(14, 6),
  status          text not null default 'pending'
                    check (status in ('pending', 'working', 'filled', 'stopped', 'closed', 'cancelled', 'expired')),
  dry_run         boolean not null default true,
  cancel_days     integer not null default 10 check (cancel_days between 1 and 60),
  buy_order_id    text,
  stop_order_id   text,
  filled_at       timestamptz,
  filled_price    numeric(14, 6),
  filled_shares   integer,
  last_stop_price numeric(14, 6),
  ladder          jsonb not null default '[]'::jsonb,
  next_rung       jsonb,
  last_error      text,
  notes           text not null default '',
  data            jsonb not null default '{}'::jsonb,
  check (stop_price < limit_price)
);
create index if not exists stock_plans_user_status_idx on public.stock_plans (user_id, status);
create index if not exists stock_plans_active_idx on public.stock_plans (status) where status in ('pending', 'working', 'filled');
create or replace function public.stock_plans_touch() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists stock_plans_touch on public.stock_plans;
create trigger stock_plans_touch before update on public.stock_plans
  for each row execute function public.stock_plans_touch();

alter table public.stock_plans enable row level security;
drop policy if exists stock_plans_read_own on public.stock_plans;
drop policy if exists stock_plans_owner_all on public.stock_plans;
drop policy if exists stock_plans_bot_insert on public.stock_plans;
drop policy if exists stock_plans_bot_update on public.stock_plans;
drop policy if exists stock_plans_bot_delete on public.stock_plans;
create policy stock_plans_read_own on public.stock_plans for select to authenticated
  using (user_id = auth.uid() or (select public.is_owner()));
create policy stock_plans_bot_insert on public.stock_plans for insert to authenticated
  with check (user_id = auth.uid() and (select public.has_bot_access()));
create policy stock_plans_bot_update on public.stock_plans for update to authenticated
  using (user_id = auth.uid() and (select public.has_bot_access()))
  with check (user_id = auth.uid());
create policy stock_plans_bot_delete on public.stock_plans for delete to authenticated
  using (user_id = auth.uid() and (select public.has_bot_access()));
revoke all on public.stock_plans from anon;
grant select, insert, update, delete on public.stock_plans to authenticated;

-- Per-user stocks live switch for dip-buy plans (separate from broker_connections.live_enabled for existing stops).
alter table public.profiles add column if not exists stocks_live boolean not null default false;
