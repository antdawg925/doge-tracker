-- B12: plan rows are written by the server API / runner only (service role). The browser can read
-- its own plans but can no longer insert / update / delete them directly (e.g. lower last_stop_price).
drop policy if exists stock_plans_bot_insert on public.stock_plans;
drop policy if exists stock_plans_bot_update on public.stock_plans;
drop policy if exists stock_plans_bot_delete on public.stock_plans;
revoke insert, update, delete on public.stock_plans from authenticated;
revoke all on public.stock_plans from anon;

-- Stops only tighten (long: up, short: down), for every role, like stock_stops.
create or replace function public.stock_plans_stop_tighten_only() returns trigger language plpgsql as $$
begin
  if old.last_stop_price is not null and new.last_stop_price is not null then
    if new.side = 'short' and new.last_stop_price > old.last_stop_price then
      raise exception 'stock_plans: short stop can only move down (% → %)', old.last_stop_price, new.last_stop_price;
    elsif new.side <> 'short' and new.last_stop_price < old.last_stop_price then
      raise exception 'stock_plans: stop can only move up (% → %)', old.last_stop_price, new.last_stop_price;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists stock_plans_stop_tighten_only on public.stock_plans;
create trigger stock_plans_stop_tighten_only before update of last_stop_price on public.stock_plans
  for each row execute function public.stock_plans_stop_tighten_only();
