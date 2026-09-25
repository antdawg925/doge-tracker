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
| `/scanner` | Signed in | **Scanner** — Momentum / Investable stock lanes (5M+ volume) |
| `/short-kings` | Signed in | **Short Kings** — My Shorts + Hunt (float / short interest) |
| `/alerts` | Trade Smart Bot | **Alerts** — the user's own DOGE plan (core trailing stop + trading slice), ATR(14) 4h ratcheting stop, plan history, in-browser crossing alerts. Members without bot access see a locked screen with an access-key box (`/alerts?key=TS-XXXX-XXXX` prefills it) |
| `/access-keys` | Owner | **Access keys** — create / copy / deactivate keys, see uses and who redeemed |

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
3. Clears shares / avg cost / target when the asset key changes (fresh research form)
4. Refetches spot + history and recomputes S/R / stops

Watchlist + positions persist in `localStorage` key `doge-tracker-state-v2` (`selected`, `positions`, `watchlist`).

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
- Position editor clears on symbol change

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
    Alerts.jsx         # M2 placeholder
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


## Alerts — DOGE plan & ATR trailing stop

- **Math** (`src/lib/atr.js`, pure): Kraken `XDGUSD` 4h candles → true range → ATR(14) Wilder (EWM α = 1/14). Staged stop:
  - **Stage 1** (before breakout): effective stop = manual floor (0.079). ATR shown for reference only.
  - **Stage 2** (first *completed* 4h candle since the plan anchor that closes above the breakout level, 0.104): floor → floor after breakout (0.090) and trail = highest high since the breakout candle − 2.5×ATR (1.75× once price > tighten reference × 1.15; reference defaults to the breakout level → ~0.1196).
  - Effective stop = max(floor, every trail value since breakout, stored stop) — never moves down. Stored stop memory carries `rulesVersion`; stale versions are discarded and recomputed.
- **Alerts** (`src/lib/alertRules.js`): sell, breakout, high/low zone, buy-back and effective-stop crossings. Fire once per crossing, re-arm after price pulls back 0.5% past the level. Polling every 90s runs app-wide (`DogePlanProvider` in `AppLayout`) while Trade Smart is open; system notifications via the Notification API (+ `public/alerts-sw.js` for Android Chrome).
- **Storage** (`src/lib/planStore.js`): async API over one document (`plan`, `history`, `stop`, `alerts`) with a swappable backend. For Trade Smart Bot accounts, `DogePlanProvider` plugs in `src/lib/planStoreSupabase.js`, which splits it across per-user Supabase tables (`doge_plans`, `plan_history`, `stop_memory` with the rules version, `alert_state`, `alert_log`). The first time an account with no stored plan signs in, a pre-login localStorage plan (`trade-smart-doge-plan-v1`) + history + stop memory + alert log are imported once (flag `trade-smart-doge-plan-imported`). Plans load once per session and later writes only send what changed. localStorage stays the default backend for scripts.
- **Checks**: `npm run check:atr` (fixtures + live Kraken numbers) and `npm run check:alerts`.


## Accounts & login (Supabase)

Auth + per-user storage run on Supabase (Postgres + Auth). Anyone can create a free account with email + password; email confirmation is off (Supabase's built-in mailer only delivers to project team members), so signup signs you straight in. A trigger on `auth.users` creates each profile as `member` without bot access.

### Tiers

| Tier | How | Gets |
| --- | --- | --- |
| Signed out | — | Home only; other tabs redirect to `/login` and come back after sign-in |
| Member (free) | Sign up | Research, Scanner, Short Kings |
| Trade Smart Bot | Redeem an access key (`profiles.bot_access = true`) | + Alerts: own DOGE plan, staged ATR stop, alerts, plan history (future Telegram/bot alerts) |
| Owner | Redeem an owner key (`role = 'owner'`, always has bot access) | + Access keys page; Kraken / bot account connection next |

### Environment variables

| Name | Where | Secret? | Purpose |
| --- | --- | --- | --- |
| `VITE_SUPABASE_URL` | Vercel (Prod + Preview), `.env.local` | No (public) | Project URL for the browser client |
| `VITE_SUPABASE_ANON_KEY` | Vercel (Prod + Preview), `.env.local` | No (public) | Publishable / anon key; data is protected by RLS |
| `SUPABASE_URL` | Vercel (Prod + Preview) | Server only | Project URL for `/api` functions |
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel (Prod + Preview), **sensitive** | **Yes** | Secret key used by `/api/redeem-key` (bypasses RLS). Never `VITE_`-prefix it and never ship it to the client |
| `KRAKEN_API_KEY` / `KRAKEN_API_SECRET` | Vercel, sensitive | **Yes** | Read-only Kraken keys for the upcoming owner-only route |

Local dev (Windows or Linux): `cp .env.example .env.local` (PowerShell: `Copy-Item .env.example .env.local`) and fill in the two `VITE_` values from Supabase → Project Settings → API. That's enough to sign up, sign in and use your plan locally (`http://localhost:5173` is an allowed redirect URL). To test key redemption locally too, add `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` to `.env.local`; the Vite dev server then serves `/api/redeem-key` with the same handler as Vercel (use Node 22+, supabase-js needs a native WebSocket server-side). Restart `npm run dev` after editing env files. `.env.local` is gitignored; only `.env.example` (placeholders) is committed.

### Access keys

- Format `TS-XXXX-XXXX` (no 0/O/1/I/L). The owner creates **member** keys on `/access-keys` (label + max uses), copies the key or a prefilled `/alerts?key=` link, sees uses and who redeemed, and can deactivate / reactivate. Owner keys can only be minted with SQL.
- `POST /api/redeem-key` (`api/redeem-key.js`) verifies the caller's Supabase JWT, checks the key with the service key, and calls `redeem_access_key()`, which takes one use (never past `max_uses`, even with concurrent redemptions), sets `bot_access` (and `role = 'owner'` for owner keys) and logs the redemption in one transaction. Already-unlocked accounts don't burn a use. Clear errors for unknown / deactivated / used-up keys; best-effort rate limit (10 tries / 10 min / user).

### Database

Schema lives in `supabase/migrations/` (applied to the hosted project; CLI-compatible). Every table has RLS on:

| Table | Access |
| --- | --- |
| `profiles` | Read own row (owner reads all). Users can update only `display_name` (column grant); `role` / `bot_access` change only via `redeem_access_key()` |
| `access_keys`, `access_key_redemptions` | Owner only (select; insert member keys; update). Redeemed server-side |
| `doge_plans`, `plan_history`, `stop_memory`, `alert_state`, `alert_log` | Read own rows; insert / update / delete own rows only with bot access (`has_bot_access()`) |

Signed-out (`anon`) requests have no table grants at all. Deleting an auth user cascades to all of their rows.

### Owner-only / bot-tier API routes (next step)

`api/_supabase.js` exports `requireUser(req, res, { role, bot })`. A route such as a Kraken balance proxy does:

```js
import { requireUser, sendJson } from './_supabase.js'

export default async function handler(req, res) {
  const who = await requireUser(req, res, { role: 'owner' }) // or { bot: true }; 401 / 403 sent for you
  if (!who) return
  // ... use process.env.KRAKEN_API_KEY / KRAKEN_API_SECRET here, server-side only
}
```

The browser calls it with `Authorization: Bearer ${session.access_token}` (from `supabase.auth.getSession()`). Add a matching entry before the `/api/:path*` catch-all in `vercel.json` `rewrites` (see `/api/redeem-key`).

### Limitations

- Supabase free-plan projects pause after about a week without activity; open the dashboard to restore.
- No password reset / email change flow yet, and emails aren't verified (confirmation is off). Both need a custom SMTP sender in Supabase Auth. The owner can reset a password from the Supabase dashboard.
- Open signup has only Supabase's built-in rate limits; add CAPTCHA (Supabase Auth → Bot protection) if spam signups show up.
- Research watchlist / positions are still per-browser localStorage (`doge-tracker-state-v2`).
- Plan data loads once per session; edits made on another device show up after a reload.
