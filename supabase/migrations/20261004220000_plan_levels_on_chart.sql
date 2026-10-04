-- Plan levels: on_chart (key resistance drawn on charts) vs list-only zones; plus a step-by-step ladder per post.
alter table public.plan_posts add column if not exists ladder jsonb not null default '[]'::jsonb;
do $$ begin
  alter table public.plan_posts add constraint plan_posts_ladder_array check (jsonb_typeof(ladder) = 'array');
exception when duplicate_object then null; end $$;

-- Every level gets on_chart (default false = list-only zone).
update public.plan_posts p
set levels = (
  select coalesce(jsonb_agg(l || jsonb_build_object('on_chart', coalesce((l->>'on_chart')::boolean, (l->>'price')::numeric in (0.14, 0.175, 0.2, 0.25, 0.3, 0.4) and p.title = 'DOGE plan: Oct 3 video')) order by ord), '[]'::jsonb)
  from jsonb_array_elements(p.levels) with ordinality as t(l, ord)
);

-- Ladder for the Oct 3 video post (from = price where the stage becomes current).
update public.plan_posts set ladder = '[
  {"from": 0,     "px": "< 0.10",    "text": "Accumulate",                       "sub": "Stop 0.089 (only moves up)"},
  {"from": 0.10,  "px": "0.14",      "text": "Sell some",                        "sub": "Buy the dip 0.11–0.12"},
  {"from": 0.14,  "px": "~0.175",    "text": "Sell ~20%",                        "sub": "Re-buy near 0.15 · stop ~0.13"},
  {"from": 0.175, "px": "0.20",      "text": "Heavy profits (account doubled)",  "sub": ""},
  {"from": 0.20,  "px": "0.25–0.30", "text": "Tight stops on the runner",        "sub": ""},
  {"from": 0.30,  "px": "0.35–0.45", "text": "Final runner",                     "sub": "Far target ~0.70"}
]'::jsonb
where title = 'DOGE plan: Oct 3 video' and ladder = '[]'::jsonb;
