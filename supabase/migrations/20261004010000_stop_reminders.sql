-- Notification cooldowns (missing-stop reminders, buy-order coaching) and per-symbol
-- "remind me" toggles for missing-stop reminders (TSLA excluded by default in code).
create table if not exists public.notify_cooldowns (
  user_id  uuid not null references auth.users (id) on delete cascade,
  key      text not null check (length(key) <= 200),
  sent_at  timestamptz not null default now(),
  primary key (user_id, key)
);
alter table public.notify_cooldowns enable row level security;
drop policy if exists notify_cooldowns_read_own on public.notify_cooldowns;
create policy notify_cooldowns_read_own on public.notify_cooldowns for select to authenticated using (user_id = auth.uid());

create table if not exists public.stop_reminder_prefs (
  user_id    uuid not null references auth.users (id) on delete cascade,
  symbol     text not null check (symbol ~ '^[A-Z][A-Z0-9.\-]{0,11}$'),
  remind     boolean not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, symbol)
);
alter table public.stop_reminder_prefs enable row level security;
drop policy if exists stop_reminder_prefs_own on public.stop_reminder_prefs;
create policy stop_reminder_prefs_own on public.stop_reminder_prefs for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
