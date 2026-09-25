-- Drop access keys: bot access is granted only by the owner (Admin > Users).
-- Members can ask for it with request_bot_access().

drop function if exists public.redeem_access_key(text, uuid);
drop table if exists public.access_key_redemptions;
drop table if exists public.access_keys;
drop table if exists public.invites;

alter table public.profiles add column if not exists bot_access_requested_at timestamptz;

-- The only way a user can touch their own tier state: stamp a request (idempotent).
-- Column grants still limit direct profile updates to display_name.
create or replace function public.request_bot_access()
returns timestamptz
language sql
security definer
set search_path = ''
as $$
  update public.profiles
     set bot_access_requested_at = coalesce(bot_access_requested_at, now())
   where id = auth.uid() and not bot_access and role <> 'owner'
  returning bot_access_requested_at;
$$;
revoke execute on function public.request_bot_access() from public, anon;
grant execute on function public.request_bot_access() to authenticated;

-- Granting access (or promoting to owner) clears the pending request.
create or replace function public.clear_bot_request_on_grant()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.bot_access or new.role = 'owner') and new.bot_access_requested_at is not null then
    new.bot_access_requested_at := null;
  end if;
  return new;
end;
$$;
drop trigger if exists profiles_clear_bot_request on public.profiles;
create trigger profiles_clear_bot_request
  before update on public.profiles
  for each row execute function public.clear_bot_request_on_grant();

create index if not exists profiles_bot_requests_idx
  on public.profiles (bot_access_requested_at)
  where bot_access_requested_at is not null;
