-- Per-user Telegram quiet hours + the queue of held (non-urgent) messages for the morning digest.
create table if not exists public.notify_prefs (
  user_id       uuid primary key references auth.users (id) on delete cascade,
  quiet_enabled boolean not null default true,
  quiet_start   smallint not null default 21 check (quiet_start between 0 and 23),
  quiet_end     smallint not null default 6 check (quiet_end between 0 and 23),
  tz            text not null default 'America/Los_Angeles',
  updated_at    timestamptz not null default now()
);
alter table public.notify_prefs enable row level security;
drop policy if exists notify_prefs_own on public.notify_prefs;
create policy notify_prefs_own on public.notify_prefs for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create table if not exists public.notify_queue (
  id         bigserial primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  text       text not null,
  created_at timestamptz not null default now(),
  sent_at    timestamptz
);
create index if not exists notify_queue_pending_idx on public.notify_queue (user_id) where sent_at is null;
alter table public.notify_queue enable row level security;
drop policy if exists notify_queue_read_own on public.notify_queue;
create policy notify_queue_read_own on public.notify_queue for select to authenticated using (user_id = auth.uid());

