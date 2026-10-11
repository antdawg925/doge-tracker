-- Per-position emergency Risk cap (kill switch), separate from the stop price.
-- risk_cap_usd: arbitrary $ typed per position (null = no cap). If the open (unrealized) loss exceeds it,
-- the position is halted: risk_tripped_at set, the bot places/moves/cancels nothing more for it.
-- Never carries over: new rows start null, and the fields are cleared when a position closes.
do $$
declare t text;
begin
  foreach t in array array['positions', 'paper_ideas', 'stock_plans'] loop
    execute format('alter table public.%I add column if not exists risk_cap_usd numeric', t);
    execute format('alter table public.%I add column if not exists risk_tripped_at timestamptz', t);
    execute format('alter table public.%I add column if not exists risk_trip_loss numeric', t);
    execute format('alter table public.%I drop constraint if exists %I', t, t || '_risk_cap_pos');
    execute format('alter table public.%I add constraint %I check (risk_cap_usd is null or risk_cap_usd > 0)', t, t || '_risk_cap_pos');
  end loop;
end $$;

comment on column public.stock_plans.risk_cap_usd is 'Emergency kill switch: halt the bot for this plan when open loss > this $. Not a stop. Null = no cap.';

-- Clear on close so a cap never carries into the next position.
create or replace function public.risk_cap_clear_on_close() returns trigger language plpgsql as $$
begin
  if (tg_table_name = 'paper_ideas' and new.status = 'closed' and old.status is distinct from 'closed')
     or (tg_table_name = 'stock_plans' and new.status not in ('pending', 'working', 'filled') and old.status in ('pending', 'working', 'filled')) then
    new.risk_cap_usd = null;
    new.risk_tripped_at = null;
    new.risk_trip_loss = null;
  end if;
  return new;
end $$;
drop trigger if exists paper_ideas_risk_cap_clear on public.paper_ideas;
create trigger paper_ideas_risk_cap_clear before update on public.paper_ideas
  for each row execute function public.risk_cap_clear_on_close();
drop trigger if exists stock_plans_risk_cap_clear on public.stock_plans;
create trigger stock_plans_risk_cap_clear before update on public.stock_plans
  for each row execute function public.risk_cap_clear_on_close();
-- RLS: existing own-row policies on positions / paper_ideas / stock_plans cover the new columns.
