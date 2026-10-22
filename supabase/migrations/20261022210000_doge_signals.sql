-- DOGE market signals (logged hourly by /api/bot/run). Read-only for signed-in users; server writes.
create table if not exists public.doge_futures_snapshots (
  id bigserial primary key,
  taken_at timestamptz not null default now(),
  price numeric,
  okx_funding_pct numeric,        -- per 8h, percent
  kraken_funding_rate numeric,    -- Kraken PF_DOGEUSD hourly rate (raw)
  okx_oi_usd numeric,
  kraken_oi_doge numeric,
  long_short_ratio numeric,       -- OKX accounts long/short
  liq_long_usd_4h numeric,
  liq_short_usd_4h numeric,
  raw jsonb
);
create table if not exists public.doge_hype_snapshots (
  id bigserial primary key,
  taken_at timestamptz not null default now(),
  source text not null default 'x',
  post_count_1h integer,
  post_count_24h integer,
  sentiment numeric,
  note text,
  raw jsonb
);
create table if not exists public.doge_whale_moves (
  id bigserial primary key,
  tx_hash text not null unique,
  tx_time timestamptz,
  amount_doge numeric,
  amount_usd numeric,
  output_count integer,
  source text default 'blockchair',
  created_at timestamptz not null default now()
);
create index if not exists doge_futures_taken_idx on public.doge_futures_snapshots (taken_at desc);
create index if not exists doge_hype_taken_idx on public.doge_hype_snapshots (taken_at desc);
create index if not exists doge_whale_time_idx on public.doge_whale_moves (tx_time desc);
do $$ declare t text; begin
  foreach t in array array['doge_futures_snapshots','doge_hype_snapshots','doge_whale_moves'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "%s: read" on public.%I', t, t);
    execute format('create policy "%s: read" on public.%I for select to authenticated using (true)', t, t);
    execute format('revoke insert, update, delete on public.%I from anon, authenticated', t);
  end loop;
end $$;
