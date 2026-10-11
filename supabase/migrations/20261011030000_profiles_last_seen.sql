-- Real "last active" for Admin: auth.users.last_sign_in_at only changes on a fresh password
-- sign-in, but sessions persist (refresh tokens), so it stayed at the first login.
alter table public.profiles add column if not exists last_seen_at timestamptz;

-- Stamp the caller's own row with server time; no-op if stamped in the last 5 minutes.
create or replace function public.touch_last_seen()
returns void
language sql
security definer
set search_path = public
as $$
  update public.profiles
     set last_seen_at = now()
   where id = auth.uid()
     and (last_seen_at is null or last_seen_at < now() - interval '5 minutes');
$$;
revoke all on function public.touch_last_seen() from public, anon;
grant execute on function public.touch_last_seen() to authenticated;

-- Backfill from the latest session activity (token refresh) per user.
update public.profiles p
   set last_seen_at = s.last_at
  from (select user_id, max(coalesce(refreshed_at::timestamptz, updated_at)) as last_at
          from auth.sessions group by user_id) s
 where s.user_id = p.id
   and (p.last_seen_at is null or p.last_seen_at < s.last_at);
