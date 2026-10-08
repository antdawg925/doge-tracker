-- Engine uses status 'stopped' after a bottom-stop fill (legacy alias 'ended' still accepted).
-- Without 'stopped' in the check, saves failed after fills and Telegram re-alerted every cron.
alter table public.doge_live_plans drop constraint if exists doge_live_plans_status_check;
alter table public.doge_live_plans
  add constraint doge_live_plans_status_check check (status in ('active', 'ended', 'stopped'));
