-- Real holdings: optional stop + hard $ risk cap (display/tracking only; no broker orders).
-- Shares stay final; Risk $ edits move stop = avg_cost - risk / shares (long holdings).
alter table public.positions add column if not exists stop_price numeric;
alter table public.positions add column if not exists risk_usd numeric;
