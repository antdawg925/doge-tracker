-- Plan page: Anthony publishes the plan (videos, levels); every signed-in user reads it.
create table if not exists public.plan_posts (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  author_id   uuid references auth.users (id) on delete set null default auth.uid(),
  symbol      text not null default 'DOGE',
  title       text not null default '',
  video_url   text,
  note        text not null default '',
  bias        text not null default 'neutral' check (bias in ('bullish', 'neutral', 'cautious')),
  bias_reason text not null default '',
  levels      jsonb not null default '[]'::jsonb check (jsonb_typeof(levels) = 'array'),
  stop_note   text not null default ''
);
create index if not exists plan_posts_symbol_created_idx on public.plan_posts (symbol, created_at desc);
alter table public.plan_posts enable row level security;
drop policy if exists plan_posts_read on public.plan_posts;
drop policy if exists plan_posts_owner_insert on public.plan_posts;
drop policy if exists plan_posts_owner_update on public.plan_posts;
drop policy if exists plan_posts_owner_delete on public.plan_posts;
create policy plan_posts_read on public.plan_posts for select to authenticated using (true);
create policy plan_posts_owner_insert on public.plan_posts for insert to authenticated with check ((select public.is_owner()));
create policy plan_posts_owner_update on public.plan_posts for update to authenticated using ((select public.is_owner())) with check ((select public.is_owner()));
create policy plan_posts_owner_delete on public.plan_posts for delete to authenticated using ((select public.is_owner()));
revoke all on public.plan_posts from anon;
grant select, insert, update, delete on public.plan_posts to authenticated;

-- Seed: Anthony's 2026-10-03 video (once).
insert into public.plan_posts (created_at, author_id, symbol, title, video_url, note, bias, bias_reason, levels, stop_note)
select '2026-10-03T19:00:00-07:00', (select id from public.profiles where role = 'owner' order by created_at limit 1), 'DOGE',
  'DOGE plan: Oct 3 video', null,
  'Accumulate under $0.10 and buy dips in the 0.11–0.12 zone. Take some at 0.14 and ~20% at 0.175, re-buy at 0.15 with a stop near 0.13. At $0.20 profits are heavy (account doubled); from 0.25 and 0.30 keep stops tight, then let it run through 0.35–0.45. Far target ~0.70.',
  'bullish', 'Expect a 200–400% run over ~6 months; ~$0.30 likely.',
  '[
    {"price": 0.089, "label": "Bottom stop (only moves up)", "action": "stop"},
    {"price": 0.10,  "label": "Accumulate under", "action": "buy"},
    {"price": 0.115, "label": "Buy-dip zone 0.11–0.12", "action": "buy"},
    {"price": 0.13,  "label": "Stop after the 0.15 re-buy", "action": "stop"},
    {"price": 0.14,  "label": "Sell some", "action": "sell"},
    {"price": 0.15,  "label": "Re-buy (stop ~0.13)", "action": "buy"},
    {"price": 0.175, "label": "Sell ~20%", "action": "sell"},
    {"price": 0.20,  "label": "Heavy profits: account doubled", "action": "target"},
    {"price": 0.25,  "label": "Tight stops", "action": "tighten"},
    {"price": 0.30,  "label": "Tight stops (~$0.30 likely)", "action": "tighten"},
    {"price": 0.35,  "label": "Keep going", "action": "target"},
    {"price": 0.40,  "label": "Keep going", "action": "target"},
    {"price": 0.45,  "label": "Keep going", "action": "target"},
    {"price": 0.70,  "label": "Far target", "action": "target"}
  ]'::jsonb,
  'Bottom stop $0.089. It only moves up.'
where not exists (select 1 from public.plan_posts where title = 'DOGE plan: Oct 3 video');
