-- Per-user Telegram linking: one-time deep-link tokens (stored hashed, ~15 min).
-- Server (service role) inserts / consumes; users can only read their own rows.
create table if not exists public.telegram_link_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  chat_id text,
  created_at timestamptz not null default now()
);
create index if not exists telegram_link_tokens_user_idx on public.telegram_link_tokens (user_id, created_at desc);
alter table public.telegram_link_tokens enable row level security;
drop policy if exists "telegram_link_tokens: read own" on public.telegram_link_tokens;
create policy "telegram_link_tokens: read own" on public.telegram_link_tokens for select to authenticated using (user_id = (select auth.uid()));
revoke insert, update, delete on public.telegram_link_tokens from anon, authenticated;

-- One Trade Smart account per Telegram chat (alerts and commands never cross accounts).
create unique index if not exists profiles_telegram_chat_id_key on public.profiles (telegram_chat_id) where telegram_chat_id is not null;
