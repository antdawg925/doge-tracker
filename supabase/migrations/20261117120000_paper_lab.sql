-- Stock Bot PAPER LAB (paper money only; no broker, no orders). Written by POST /api/bot/paper-lab/ingest
-- (service role, x-paper-lab-secret). Read by bot-tier users and the owner only.
create table if not exists public.paper_lab_trades (
  id text primary key,                 -- strategy|symbol|signal_bar_epoch
  mode text not null default 'prospective' check (mode in ('prospective','retrospective_replay')),
  strategy_id text not null,
  version text not null,
  symbol text not null,
  side text not null check (side in ('long','short')),
  horizon text not null,
  status text not null check (status in ('open','closed')),
  entry_at timestamptz,
  exit_at timestamptz,
  entry numeric, exit numeric, stop numeric, target numeric, shares numeric,
  pnl numeric, r numeric, exit_reason text, reason text,
  regime text, vix numeric, regime_detail jsonb,
  updated_at timestamptz not null default now()
);
create table if not exists public.paper_lab_signals (
  id text primary key,
  mode text not null default 'prospective',
  strategy_id text not null,
  version text not null,
  symbol text not null,
  side text not null,
  decided_at timestamptz not null,
  stop numeric, target numeric, entry_ref numeric, reason text, regime text,
  created_at timestamptz not null default now()
);
create table if not exists public.paper_lab_daily (
  id text primary key,                 -- mode|date|strategy
  mode text not null default 'prospective',
  day date not null,
  strategy_id text not null,
  version text,
  equity numeric, realized numeric, pnl_total numeric, open_count integer,
  updated_at timestamptz not null default now()
);
create table if not exists public.paper_lab_status (
  mode text primary key,
  ticked_at timestamptz,
  regime jsonb,
  accounts jsonb,
  counts jsonb,
  updated_at timestamptz not null default now()
);
create index if not exists paper_lab_trades_mode_idx on public.paper_lab_trades (mode, status, entry_at desc);
create index if not exists paper_lab_signals_mode_idx on public.paper_lab_signals (mode, decided_at desc);
create index if not exists paper_lab_daily_idx on public.paper_lab_daily (mode, day desc);

do $$ declare t text; begin
  foreach t in array array['paper_lab_trades','paper_lab_signals','paper_lab_daily','paper_lab_status'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_bot_read', t);
    execute format($p$create policy %I on public.%I for select to authenticated using (
      exists (select 1 from public.profiles p where p.id = auth.uid() and (p.bot_access or p.role = 'owner')))$p$, t || '_bot_read', t);
  end loop;
end $$;
-- No insert/update/delete policies: only the service role (server) writes.
