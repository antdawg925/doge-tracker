-- Positions: one holding per (user, symbol). Available to every signed-in member
-- (not bot-gated). Research's position rail reads/writes the same row.
create table if not exists public.positions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  symbol     text not null check (symbol = upper(symbol) and length(symbol) between 1 and 24),
  asset_type text not null check (asset_type in ('stock', 'crypto')),
  asset_id   text,          -- CoinGecko id for crypto (e.g. dogecoin); null for stocks
  name       text,          -- display name at time of entry
  shares     numeric not null default 0 check (shares >= 0),
  avg_cost   numeric check (avg_cost is null or avg_cost >= 0),
  notes      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, symbol)
);
create index if not exists positions_user_idx on public.positions (user_id);

create or replace function public.positions_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists positions_touch on public.positions;
create trigger positions_touch before update on public.positions
  for each row execute function public.positions_touch_updated_at();

alter table public.positions enable row level security;
drop policy if exists "own rows" on public.positions;
create policy "own rows" on public.positions for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

revoke all on public.positions from anon;
grant select, insert, update, delete on public.positions to authenticated;
