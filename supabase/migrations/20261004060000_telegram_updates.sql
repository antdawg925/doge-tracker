-- Inbound Telegram webhook dedupe (Telegram retries until it gets a 200).
create table if not exists public.telegram_updates (
  update_id   bigint primary key,
  chat_id     text not null,
  user_id     uuid references auth.users (id) on delete cascade,
  text        text,
  received_at timestamptz not null default now()
);
alter table public.telegram_updates enable row level security; -- service role only
