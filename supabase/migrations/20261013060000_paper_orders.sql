-- Paper limit orders: Paper buy / Paper short from Buy dips / Sell highs rest as a pending GTC limit
-- at the Target price. The server runner fills them when price trades through the limit (bars since
-- the order), then exits automatically at the sell / cover target (win) or the stop (loss).
alter table public.paper_ideas drop constraint if exists paper_ideas_status_check;
alter table public.paper_ideas add constraint paper_ideas_status_check check (status in ('pending', 'open', 'closed', 'cancelled'));
alter table public.paper_ideas add column if not exists limit_price numeric check (limit_price is null or limit_price > 0);
alter table public.paper_ideas add column if not exists time_in_force text not null default 'GTC' check (time_in_force in ('GTC', 'DAY'));
alter table public.paper_ideas add column if not exists placed_at timestamptz;
alter table public.paper_ideas add column if not exists filled_at timestamptz;
alter table public.paper_ideas add column if not exists auto_exit boolean not null default false;
alter table public.paper_ideas add column if not exists exit_reason text check (exit_reason is null or exit_reason in ('target', 'stop', 'manual'));
alter table public.paper_ideas add column if not exists realized_pnl numeric;
create index if not exists paper_ideas_work_idx on public.paper_ideas (status) where status = 'pending' or (status = 'open' and auto_exit);
alter table public.paper_ideas drop constraint if exists paper_ideas_closed_has_exit;
alter table public.paper_ideas add constraint paper_ideas_closed_has_exit check (status <> 'closed' or (exit_price is not null and closed_at is not null));
