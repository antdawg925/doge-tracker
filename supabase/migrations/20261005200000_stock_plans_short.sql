-- Sell highs short plans: allow side='short' (SELL_SHORT limit, BUY_TO_COVER stop above).
alter table public.stock_plans drop constraint if exists stock_plans_side_check;
alter table public.stock_plans add constraint stock_plans_side_check check (side in ('long', 'short'));
alter table public.stock_plans drop constraint if exists stock_plans_check;
alter table public.stock_plans drop constraint if exists stock_plans_stop_side_check;
alter table public.stock_plans add constraint stock_plans_stop_side_check check (
  (side = 'long' and stop_price < limit_price) or (side = 'short' and stop_price > limit_price)
);
-- Risk-based sizing for shorts ($100 default); null for amount-sized longs.
alter table public.stock_plans add column if not exists risk_usd numeric check (risk_usd is null or risk_usd > 0);
comment on column public.stock_plans.risk_usd is 'Dollar risk the plan was sized for (shorts default $100).';
