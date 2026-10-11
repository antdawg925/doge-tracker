-- Paper ideas: simulated trades tracked next to real holdings. Separate table so a row is
-- unambiguously paper or real (public.positions = real money only, existing rows unchanged),
-- paper never feeds Research's real holding / real totals, and an idea can be long or short,
-- repeat a symbol, and be closed with an exit price + time to score the outcome.
create table if not exists public.paper_ideas (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  symbol text not null,
  asset_type text not null default 'stock' check (asset_type in ('stock', 'crypto')),
  asset_id text,
  name text,
  side text not null default 'long' check (side in ('long', 'short')),
  qty numeric not null check (qty > 0),
  entry_price numeric not null check (entry_price > 0),
  stop_price numeric,
  target_price numeric,
  source text not null default 'manual',
  notes text,
  status text not null default 'open' check (status in ('open', 'closed')),
  opened_at timestamptz not null default now(),
  exit_price numeric,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint paper_ideas_closed_has_exit check (status = 'open' or (exit_price is not null and closed_at is not null))
);
create index if not exists paper_ideas_user_idx on public.paper_ideas (user_id, status, opened_at desc);
alter table public.paper_ideas enable row level security;
drop policy if exists "paper_ideas: own rows" on public.paper_ideas;
create policy "paper_ideas: own rows" on public.paper_ideas for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select, insert, update, delete on public.paper_ideas to authenticated;
