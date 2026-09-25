# Trade Desk (doge-tracker)

Vite + React **Trade Desk** — a StocksToTrade-lite workspace for researching crypto and stocks: momentum stage, candles + volume/RVOL, top support/resistance with why-notes, suggested stops, and a right-rail position editor.

Package name stays `doge-tracker`. Default symbol is **DOGE** (crypto). Search any crypto (CoinGecko) or stock/ETF (Yahoo).

Numbers are editable defaults for a personal plan — not a live brokerage feed.

## Quick start

```bash
cd /workspace/doge-tracker   # or clone https://github.com/antdawg925/doge-tracker
npm install
cp .env.example .env.local   # Windows PowerShell: Copy-Item .env.example .env.local
# fill in VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY (see "Accounts & login")
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`). `/` and `/home` are the landing page.

```bash
npm run build
npm run preview   # optional local preview of dist/
```

### Routes

| Path | Access | Page |
| --- | --- | --- |
| `/`, `/home` | Public | **Home** — landing / capability overview + Sign in |
| `/login` | Public | Email + password sign-in |
| `/signup` | Public | Free account: name + email + password |
| `/research` | Signed in | **Research** — watchlist + analysis workstation |
| `/positions` | Signed in | **Positions** — your holdings (one row per symbol): live price, day %, value, gain/loss + totals; click a symbol to open it in Research |
| `/scanner` | Signed in | **Scanner** — Momentum / Investable stock lanes (5M+ volume) |
| `/short-kings` | Signed in | **Short Kings** — My Shorts + Hunt (float / short interest) |
| `/bot` | Trade Smart Bot | **Trade Smart Bot** — the user's own DOGE plan (core trailing stop + trading slice), ATR(14) 4h ratcheting stop, server bot status + decision log + paper results (checked every 5 min on the server), plan history, in-browser crossing alerts. Members without bot access see a locked Trade Smart Bot screen with **Request access** |
| `/alerts` | Redirect | Legacy path that redirects to `/bot` |
| `/admin/users` · `/admin/beta` · `/admin/system` | Owner | **Admin** — Users (requests, tier, activity, grant / revoke bot, delete), Beta feature flags, System status |

Signed-out visits to protected paths redirect to `/login` and return to the page after sign-in.

Shared chrome: `AppLayout` (brand **Trade Desk** + nav). Research workspace: left **Watchlist** (persisted), center analysis widgets, right position summary/editor.

### VS Code / editor notes

Deep links like `/home` work with Vite’s SPA history fallback. For production hosts, configure an SPA rewrite so unknown paths serve `index.html`. Prefer `npm run dev` over opening `dist/index.html` as a file.

### Deploy note (SPA)

Production target is **Vercel**. `vercel.json` SPA-rewrites unknown paths to `index.html`. Serverless routes under `api/` proxy Yahoo / CoinGecko / Kraken the same way the Vite dev proxy does.

## Symbol search & watchlist

Type a ticker or name, then press **Enter** or click **Search**. Selecting a symbol:

1. Loads `{ symbol, name, type: 'crypto'|'stock', id? }`
2. Auto-adds it to the **Watchlist** (left rail) if missing
3. Loads shares / avg cost for that symbol from your Positions (Supabase); target resets per symbol
4. Refetches spot + history and recomputes S/R / stops

Selection, watchlist and per-symbol **target price** persist in `localStorage` key `doge-tracker-state-v2`. Holdings (shares + avg cost) live in the Supabase `positions` table (one row per user + symbol, RLS own rows only; migration `20260925080000_positions.sql`) and are shared by Research's rail and the Positions tab. On first load after sign-in, any holdings saved in this browser's localStorage are imported once (flag `trade-smart-positions-imported-v1`; untouched demo DOGE numbers are skipped, existing DB rows win), then localStorage is no longer used for holdings.

### How symbol resolution works

| Type | Search | Spot | History |
| --- | --- | --- | --- |
| **Crypto** | CoinGecko `/search` | CoinGecko → Kraken → Yahoo `SYMBOL-USD` | CoinGecko / Kraken (+ long TF for resistance) |
| **Stock** | Yahoo search | Yahoo chart meta | Yahoo chart ranges |

Vite proxies: `/api/coingecko/*`, `/api/kraken/*`, `/api/yahoo/*`, `/api/yahoo-search/*`.

### Free-tier rate limits (429)

CoinGecko often returns **HTTP 429**. Spot limits retries and falls back to Kraken/Yahoo. Soft warning, keep last good cache. Wait before hammering Search.

## Position model (three inputs)

Right-side editor:

| Field | Meaning |
| --- | --- |
| **Holding** | Units owned (coins or shares) |
| **Average cost** | $ per unit paid |
| **Target price** | Take-profit idea ($ per unit) |

## Features (Research / V1)

- Live spot + 24h change
- Daily **candlestick** chart (30d / 90d) + volume / **RVOL** strip
- **Momentum / pattern stage** box (estimated 1–7 — pattern context only; no vendor names in UI)
- **Suggested stops** aligned with top supports
- **Support** / **Resistance** — Top 5 with why-notes
- Watchlist (add / remove / click to load), persisted
- Position editor prefills from your Positions and saves edits back (debounced)

## Project layout

```
src/
  App.jsx              # Router + AppLayout routes
  components/
    AppLayout.jsx      # Trade Desk chrome + NavLink
    Watchlist.jsx      # Left rail
    Header.jsx         # Refresh / last updated toolbar
    SymbolSearch, StageBox, PriceCard, PriceChart,
    SuggestedStops, SupportPanel, ResistancePanel,
    PositionSummary, PositionEditor
  pages/
    Home.jsx           # Landing
    Research.jsx       # Research workstation
    Scanner.jsx        # Momentum / Investable scanner + preview pane
    NewsPanel.jsx       # Shared Yahoo news + significance badges
    ScannerChart.jsx    # Compact 1M/1Y/5Y candles
    ScannerPreview.jsx  # Scanner right rail (chart + news)
    Alerts.jsx         # Trade Smart Bot page
  hooks/               # useAssetPrice, useAssetHistory, useLongHistory
  lib/                 # assets, defaults, scanner, news, newsSignificance, levels, …
```

## Scanner (Milestone 2)

`/scanner` replaces the placeholder with two Yahoo-backed stock lanes (crypto skipped):

| Tab | Intent | Sort |
| --- | --- | --- |
| **Momentum** | Volatile / quick-trade | Relative volume ↓, then \|% change\| ↓ (lower float when Yahoo provides it) |
| **Investable** | Quality / longer horizon | Market cap ↓, then price ↓ among liquid names |

**Liquidity floor:** prefer **average daily volume (3-month ADV) ≥ 5,000,000**; if ADV is missing, today's volume ≥ 5M also passes. Micros under **$0.50** need **≥ 10M** day volume or they are dropped. Float often shows **—** on free Yahoo screeners — rows still rank by volume / RVOL / % change.

Data: Yahoo predefined screeners (`day_gainers`, `day_losers`, `most_actives`, `small_cap_gainers`, `undervalued_large_caps`, `growth_technology_stocks`) via `/api/yahoo` → client filter/sort. Soft-handles **429**s with warnings. Click a row to **preview** chart/news; **Open** to save `{ type: 'stock', symbol, name }` into `doge-tracker-state-v2` and navigate to **Research** (`/research`).

Logic lives in `src/lib/scanner.js`; UI in `src/pages/Scanner.jsx`.


## Symbol preview & news (Scanner + Research)

Shared **news** pipeline for Scanner preview and Research:

| Piece | Role |
| --- | --- |
| `src/lib/news.js` | Yahoo Finance search (`newsCount`) via `/api/yahoo-search` |
| `src/lib/newsSignificance.js` | Heuristic keyword scorer → `significant` / `watch` / `low` |
| `src/components/NewsPanel.jsx` | Shared UI: badges, summary line, low-signal collapsed by default |

### Scanner preview

- Click a table row to **select** it (highlight). Does **not** navigate away.
- **Open** still loads the symbol onto Research (`/research`) as before.
- Right-hand **preview pane**: compact candle chart (`1M` / `1Y` / `5Y`, default `1Y`) + `NewsPanel`.
- Chart ranges map to Yahoo daily bars: `1M→1mo`, `1Y→1y`, `5Y→5y` (`ScannerChart` + `fetchYahooChart`).
- Empty state: “Select a symbol to preview chart & news.”

### Research

- `NewsPanel` sits in the main column under the price chart for the selected symbol (stocks and crypto via Yahoo `SYMBOL-USD` when needed).

### Significance scoring (v1, no LLM)

- **Significant**: earnings/EPS/revenue beat-miss, guidance changes, FDA, clinical trials, dilution/ATM/offering, bankruptcy, M&A, C-suite exits, halts, SEC/DOJ probes, splits, buybacks, PT moves, material contracts, delisting.
- **Watch**: partnership, expansion, insider activity, initiations, conferences, plain upgrades/downgrades, dividends.
- **Low**: top-movers lists, generic “shares rise/fall”, market wraps, SEO spam — hidden behind “Show low-signal” by default.
- Summary line e.g. `2 significant items — dilution/offering + earnings beat/miss`.

### Limitations

- Yahoo search news quality varies; many items are low-signal aggregators.
- Free Yahoo endpoints can **429**; news failures show a soft warning and do not break the scanner table or Research chart.
- Heuristic scorer can miss nuance / non-English headlines; no LLM in v1.

### Still planned

- **Alerts**: price, stage, and RVOL thresholds with notifications

## License

Personal / educational scaffold — use at your own risk.


### View on your phone (same Wi‑Fi)

`vite.config.js` sets `server.host: true` so the dev server listens on your LAN.

1. On your PC: `npm run dev`
2. Note the Network URL Vite prints (e.g. `http://10.0.0.238:5173`)
3. On your phone (same Wi‑Fi), open that URL
4. If it fails, allow **Node.js** / port **5173** through Windows Firewall (Private networks)

This is **not** public internet hosting — only devices on your home network. Public deploy is on Vercel when linked; local LAN access still uses `npm run dev`.


## Trade Smart Bot — DOGE plan & ATR trailing stop

- **Math** (`src/lib/atr.js`, pure): Kraken `XDGUSD` 4h candles → true range → ATR(14) Wilder (EWM α = 1/14). Staged stop:
  - **Stage 1** (before breakout): effective stop = manual floor (0.079). ATR shown for reference only.
  - **Stage 2** (first *completed* 4h candle since the plan anchor that closes above the breakout level, 0.104): floor → floor after breakout (0.090) and trail = highest high since the breakout candle − 2.5×ATR (1.75× once price > tighten reference × 1.15; reference defaults to the breakout level → ~0.1196).
  - Effective stop = max(floor, every trail value since breakout, stored stop) — never moves down. Stored stop memory carries `rulesVersion`; stale versions are discarded and recomputed.
- **Alerts** (`src/lib/alertRules.js`): sell, breakout, high/low zone, buy-back and effective-stop crossings. Fire once per crossing, re-arm after price pulls back 0.5% past the level. Polling every 90s runs app-wide (`DogePlanProvider` in `AppLayout`) while Trade Smart is open; system notifications via the Notification API (+ `public/alerts-sw.js` for Android Chrome).
- **Storage** (`src/lib/planStore.js`): async API over one document (`plan`, `history`, `stop`, `alerts`) with a swappable backend. For Trade Smart Bot accounts, `DogePlanProvider` plugs in `src/lib/planStoreSupabase.js`, which splits it across per-user Supabase tables (`doge_plans`, `plan_history`, `stop_memory` with the rules version, `alert_state`, `alert_log`). The first time an account with no stored plan signs in, a pre-login localStorage plan (`trade-smart-doge-plan-v1`) + history + stop memory + alert log are imported once (flag `trade-smart-doge-plan-imported`). Plans load once per session and later writes only send what changed. localStorage stays the default backend for scripts.
- **Checks**: `npm run check:atr` (fixtures + live Kraken numbers), `npm run check:alerts`, and `npm run check:bot` (server run logic on fixture candles: stages, ratchet, decisions, paper trades).

## Server bot (watch-only, every 5 minutes)

DOGE is checked on the server every 5 minutes even with the app closed. **No orders are placed anywhere**; Kraken is only read (Balance + OpenOrders) with the owner's read-only key.

- **Scheduler**: Supabase `pg_cron` job `trade-smart-bot-run` (`*/5 * * * *`) calls `pg_net` → `POST https://trade-smart-app.vercel.app/api/bot/run` with header `x-bot-secret`. The secret lives in Supabase Vault (`bot_cron_secret`, read by the job from `vault.decrypted_secrets`, never in the job text) and in Vercel env `BOT_CRON_SECRET` (sensitive). Vercel Cron isn't used (Hobby = daily only). The pings also keep the free Supabase project from pausing. Rotate: generate a new value, `vercel env rm/add BOT_CRON_SECRET` (stdin) + `select vault.update_secret(id, '<new>')`, redeploy.
- **`/api/bot/run`** (`api/bot.js` → `api/_botRunner.js`): 401 without the right secret (or no auth), 403 for non-owner JWTs; the owner's JWT can trigger a manual run. Fetches Kraken 4h OHLC + ticker once, then for every user with bot access (or owner) **who has a saved `doge_plans` row**: computes the staged stop with the shared `shared/atr.js` (server is the source of truth for `stop_memory`; a DB trigger stops any writer from lowering it for the same rules version + anchor), evaluates `shared/alertRules.js` against `alert_state` (appends `alert_log`), steps the paper book, and writes one `bot_runs` row. Owner rows also carry the Kraken DOGE balance + open order count (errors are recorded, not fatal).
- **Shared code**: pure logic lives in `shared/` (`atr.js`, `alertRules.js`, `plan.js`, `kraken.js`, `paper.js`, `botEngine.js`, `format.js`); `src/lib/*` re-exports it so browser and server run the same math. Symbols are configured in `BOT_SYMBOLS` (`shared/botEngine.js`); new bot tables are keyed by `(user_id, symbol)`; per-user Kraken keys plug into `krakenCredsFor()` (`api/_kraken.js`).
- **Tables** (migrations `20260925090000_server_bot.sql`, `20260925100000_profit_lock.sql`, RLS: users read their own rows, owner reads all, only the server writes): `bot_runs` (price, ATR, stage, stop, trail, floor, highest high, `decision` = `hold` / `would_sell_slice` / `would_buy_back` / `would_exit_core` / `stop_raised` / `locked` / `blocked_locked` / `blocked_paused` / `blocked_below_baseline` / `error`, reason, owner Kraken balance + open orders, duration), `bot_heartbeat` (last run per symbol → Admin → System), `paper_state`, `paper_trades`. Retention: daily `trade-smart-bot-retention` job deletes `hold`/`error` rows older than 90 days; every real decision row is kept forever.
- **Paper test**: notional = your Positions DOGE shares, else (owner) Kraken DOGE balance, else 10,000 DOGE; split by the plan's core % / slice %. Slice sells at the sell level (once per cycle) and buys back at the buy-back level with its cash; core exits entirely at the effective stop and then stays in cash ("core stopped out"). Slice fills assume the level price; stop fills use the check price. My Bot shows paper value vs buy-and-hold and a **Restart paper test** button (`POST /api/bot/paper/restart`).
- **Browser**: My Bot re-reads the server's stop memory / alert state / alert log on every 90s tick (so the numbers match the server) and only evaluates crossings in memory for browser notifications while the app is open.

### TSB Profit lock, Max loss and Pause

Rule: **the bot must never leave a user below their starting amount while unattended.** Pure logic in `shared/guard.js`; state in `bot_guard` (one row per user + symbol; RLS: users read their own, the owner reads all, only the server writes).

- **Baseline (starting amount)** = shares × avg cost. For the paper book that is *paper shares (notional) × the plan's avg cost* (`baseline_shares`, `baseline_avg_cost`, `baseline_value`). A fresh paper book (first run or **Restart paper test**) gets a fresh baseline; lock / pause flags carry over.
- **Max loss** ("willing to lose" line): `max_loss_usd`, default **$1**, set by each user on My Bot (`POST /api/bot/guard/max-loss`, own JWT, validated ≥ 0). Lock line = baseline − max loss.
- **After every fill** (slice sell, buy-back, core stop) the book is valued as cash + holdings at the fill price. Book < lock line → `locked`, `locked_at`, `lock_reason` (e.g. "Stop filled at $0.08500; book $850.00 is below starting $900.00 − max loss $1.00"), a `locked` decision in `bot_runs`, an `alert_log` entry and a Telegram message (no-op until configured). Realized P&L is tracked cumulatively across all fills (average cost).
- **Before every fill**: locked → skipped (`blocked_locked`); paused → skipped (`blocked_paused`); a buy-back is also skipped when the current book is already below the lock line (`blocked_below_baseline`). A blocked situation is logged as a decision once (then "still blocked" in the hold reason) so the forever-kept decision log doesn't fill up every 5 minutes. While locked or paused the bot keeps running: stops, prices, alerts.
- **Unlock** only by the user: **Authorize next trade** on their own My Bot (`POST /api/bot/guard/unlock`, own JWT; a different `userId` → 403, even for the owner). It clears the lock and resets the baseline to the current book value (live Kraken price), recording `unlocked_at` / `unlocked_by`.
- **Pause / Resume**: `POST /api/bot/guard/pause { paused }` (own JWT). Paused = no trades, still watching.
- Paper fills: slice sell / buy-back at their levels; the core stop at the price the 5-minute check saw (≤ stop), so a gap through the stop fills lower.
- **Live orders (future)**: the order path must call `preTradeCheck()` before placing any order and `afterFill()` after each fill — the same functions paper trading uses.
- Admin → Users shows each bot user's TSB badge (Live / Paused / Locked with reason on hover / No plan), book − baseline ($ and %), max-loss line and last run (read-only). Admin → System shows the locked-user count.

### Telegram alerts (optional)

`api/_telegram.js` sends one message per run for alert firings and non-hold decisions — only when **both** exist; otherwise it silently skips:

1. Create a bot with [@BotFather](https://t.me/BotFather) and add its token as a **sensitive** Vercel env var: `printf '%s' '<token>' | vercel env add TELEGRAM_BOT_TOKEN production --sensitive --scope ant-dawg`, then redeploy.
2. Set the user's chat id in `profiles.telegram_chat_id` (server/SQL only for now — users can't write it, just like `role` / `bot_access`). A self-serve linking flow (e.g. `/start <code>` webhook) is a later step.


## Accounts & login (Supabase)

Auth + per-user storage run on Supabase (Postgres + Auth). Anyone can create a free account with email + password; email confirmation is off (Supabase's built-in mailer only delivers to project team members), so signup signs you straight in. A trigger on `auth.users` creates each profile as `member` without bot access.

### Tiers

| Tier | How | Gets |
| --- | --- | --- |
| Signed out | — | Home only; other tabs redirect to `/login` and come back after sign-in |
| Member (free) | Sign up | Research, Scanner, Short Kings |
| Trade Smart Bot | Owner grants it in Admin → Users (`profiles.bot_access = true`); members can hit **Request access** on the My Bot tab | + My Bot: own DOGE plan, staged ATR stop, alerts, plan history (future Telegram/bot alerts) |
| Owner | Promoted with `scripts/make-owner.mjs` / SQL (`role = 'owner'`, always has bot access) | + Admin (Users, Beta, System); Kraken / bot account connection next |

### Environment variables

| Name | Where | Secret? | Purpose |
| --- | --- | --- | --- |
| `VITE_SUPABASE_URL` | Vercel (Prod + Preview), `.env.local` | No (public) | Project URL for the browser client |
| `VITE_SUPABASE_ANON_KEY` | Vercel (Prod + Preview), `.env.local` | No (public) | Publishable / anon key; data is protected by RLS |
| `SUPABASE_URL` | Vercel (Prod + Preview) | Server only | Project URL for `/api` functions |
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel (Prod + Preview), **sensitive** | **Yes** | Secret key used by `/api/admin/*` and `scripts/make-owner.mjs` (bypasses RLS). Never `VITE_`-prefix it and never ship it to the client |
| `SUPABASE_REGION` | Vercel (Prod + Preview) | No | Shown on Admin → System |
| `BUILD_COMMIT` | `vercel --build-env` at deploy | No | Commit shown on Admin → System (falls back to `git rev-parse`) |
| `KRAKEN_API_KEY` / `KRAKEN_API_SECRET` | Vercel, sensitive | **Yes** | Owner's read-only Kraken key (query funds + orders); used by the server bot for balance / open orders |
| `BOT_CRON_SECRET` | Vercel (Prod), sensitive + Supabase Vault `bot_cron_secret` | **Yes** | Shared secret the pg_cron job sends as `x-bot-secret` to `/api/bot/run` |
| `TELEGRAM_BOT_TOKEN` | Vercel, sensitive (optional) | **Yes** | Enables Telegram alerts for users with `profiles.telegram_chat_id` |

Local dev (Windows or Linux): `cp .env.example .env.local` (PowerShell: `Copy-Item .env.example .env.local`) and fill in the two `VITE_` values from Supabase → Project Settings → API. That's enough to sign up, sign in and use your plan locally (`http://localhost:5173` is an allowed redirect URL). To use Admin locally (and `npm run make-owner`), add `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` to `.env.local`; the Vite dev server then serves `/api/admin/*` with the same handler as Vercel (use Node 22+, supabase-js needs a native WebSocket server-side). Restart `npm run dev` after editing env files. `.env.local` is gitignored; only `.env.example` (placeholders) is committed.

### Bot access requests

- On the locked My Bot screen a member clicks **Request access**, which calls the `request_bot_access()` SQL function (SECURITY DEFINER). It only stamps `profiles.bot_access_requested_at` for the caller; users still can't touch `role` or `bot_access`. The screen then shows **Request sent**.
- The owner sees pending requests at the top of Admin → Users (badge + date), a count on the **Admin** nav item and on System. Granting access clears the request (DB trigger).

### Making the owner

Sign up normally in the app, then promote that account once (needs `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` in `.env.local`, Node 20.6+):

```bash
npm run make-owner -- you@example.com
# same as: node --env-file=.env.local scripts/make-owner.mjs you@example.com
```

Or in Supabase → SQL editor: `update public.profiles set role = 'owner', bot_access = true where email = 'you@example.com';`

### Admin (owner only)

- **Users**: every account with name, email, signed-up / last sign-in time, role and bot access; pending requests first. Grant / revoke bot access; delete an account after typing its email (deletes the auth user; all their rows cascade). Owner accounts (including your own) can't be demoted or deleted here. Passwords are never shown or stored by the app; Supabase Auth keeps only bcrypt hashes.
- **Beta**: `feature_flags` (`key`, `description`, `enabled_for` = `owner` / `bot` / `everyone`). Pick each flag's audience; in code use `useFeature('kraken_panel')` (`src/hooks/featureFlags.js`). The owner always sees every flag. Add new flags with a migration.
- **System**: user / bot-access / pending-request counts, Supabase project ref + region, deploy commit + build time + deployment, Kraken "keys configured on server: yes/no" (presence check only, no Kraken calls, no values), bot last run placeholder.
- API: `api/admin.js` serves `GET /api/admin/users`, `PATCH|DELETE /api/admin/users/:id`, `GET /api/admin/system`. Each request verifies the Supabase JWT **and** `profiles.role = 'owner'` before touching the service key; everyone else gets 401 / 403.

### Database

Schema lives in `supabase/migrations/` (applied to the hosted project; CLI-compatible). Every table has RLS on:

| Table | Access |
| --- | --- |
| `profiles` | Read own row (owner reads all). Users can update only `display_name` (column grant); `role` / `bot_access` change only through the owner Admin API (service key) or SQL; `request_bot_access()` can only stamp the caller's request time |
| `feature_flags` | Signed-in users read all; signed-out read only `everyone` flags; only the owner can change `enabled_for` |
| `doge_plans`, `plan_history`, `stop_memory`, `alert_state`, `alert_log` | Read own rows; insert / update / delete own rows only with bot access (`has_bot_access()`) |

Signed-out (`anon`) requests have no table grants at all. Deleting an auth user cascades to all of their rows.

### Owner-only / bot-tier API routes

`api/_supabase.js` exports `requireUser(req, res, { role, bot })`. A route such as a Kraken balance proxy does:

```js
import { requireUser, sendJson } from './_supabase.js'

export default async function handler(req, res) {
  const who = await requireUser(req, res, { role: 'owner' }) // or { bot: true }; 401 / 403 sent for you
  if (!who) return
  // ... use process.env.KRAKEN_API_KEY / KRAKEN_API_SECRET here, server-side only
}
```

The browser calls it with `Authorization: Bearer ${session.access_token}` (from `supabase.auth.getSession()`). Add a matching entry before the `/api/:path*` catch-all in `vercel.json` `rewrites` (see `/api/admin`).

### Limitations

- Supabase free-plan projects pause after about a week without activity; the 5-minute bot pings keep it active (if it ever pauses, open the dashboard to restore).
- No password reset / email change flow yet, and emails aren't verified (confirmation is off). Both need a custom SMTP sender in Supabase Auth. The owner can reset a password from the Supabase dashboard.
- Open signup has only Supabase's built-in rate limits; add CAPTCHA (Supabase Auth → Bot protection) if spam signups show up.
- Research watchlist / positions are still per-browser localStorage (`doge-tracker-state-v2`).
- Plan edits load once per session (edits on another device show up after a reload); the server-owned stop memory / alert state / alert log refresh every 90s.
- Server bot: watch-only; checks are every 5 minutes, so paper fills (at level prices) can differ from what a live order would have done between checks. Only DOGE and only the owner's Kraken key today; the older per-user plan tables (`doge_plans`, `stop_memory`, `alert_state`) are DOGE-only and would need a symbol column before a second symbol.
