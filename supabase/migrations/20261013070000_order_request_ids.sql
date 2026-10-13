-- One press = one order: client request id per ticket, unique per user.
alter table public.paper_ideas add column if not exists client_request_id text;
create unique index if not exists paper_ideas_user_req_uidx on public.paper_ideas (user_id, client_request_id) where client_request_id is not null;
alter table public.stock_plans add column if not exists client_request_id text;
create unique index if not exists stock_plans_user_req_uidx on public.stock_plans (user_id, client_request_id) where client_request_id is not null;
