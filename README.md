# Trade Desk (doge-tracker)

Vite + React **Trade Desk** — a StocksToTrade-lite workspace for researching crypto and stocks: momentum stage, candles + volume/RVOL, top support/resistance with why-notes, suggested stops, and a right-rail position editor.

Package name stays `doge-tracker`. Default symbol is **DOGE** (crypto). Search any crypto (CoinGecko) or stock/ETF (Yahoo).

**Not investment advice.** Numbers are editable defaults for a personal plan — **not** live brokerage positions.

## Quick start

```bash
cd /workspace/doge-tracker   # or clone https://github.com/antdawg925/doge-tracker
npm install
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`). `/` redirects to `/home`.

```bash
npm run build
npm run preview   # optional local preview of dist/
```

### Routes

| Path | Page |
| --- | --- |
| `/` | Redirects to `/home` |
| `/home` | **Desk** — watchlist + analysis workspace |
| `/scanner` | **Scanner** — Momentum / Investable stock lanes (5M+ volume) |
| `/alerts` | Placeholder (Milestone 2 — price / stage / RVOL alerts) |

Shared chrome: `AppLayout` (brand **Trade Desk** + nav). Desk workspace: left **Watchlist** (persisted), center analysis widgets, right position summary/editor.

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

## Features (Desk / V1)

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
    PositionSummary, PositionEditor, Disclaimer
  pages/
    Home.jsx           # Desk workspace
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

Data: Yahoo predefined screeners (`day_gainers`, `day_losers`, `most_actives`, `small_cap_gainers`, `undervalued_large_caps`, `growth_technology_stocks`) via `/api/yahoo` → client filter/sort. Soft-handles **429**s with warnings. Click a row to **preview** chart/news; **Open** to save `{ type: 'stock', symbol, name }` into `doge-tracker-state-v2` and navigate to **Desk** (`/home`).

Logic lives in `src/lib/scanner.js`; UI in `src/pages/Scanner.jsx`.


## Symbol preview & news (Scanner + Desk)

Shared **news** pipeline for Scanner preview and Desk:

| Piece | Role |
| --- | --- |
| `src/lib/news.js` | Yahoo Finance search (`newsCount`) via `/api/yahoo-search` |
| `src/lib/newsSignificance.js` | Heuristic keyword scorer → `significant` / `watch` / `low` |
| `src/components/NewsPanel.jsx` | Shared UI: badges, summary line, low-signal collapsed by default |

### Scanner preview

- Click a table row to **select** it (highlight). Does **not** navigate away.
- **Open** still loads the symbol onto Desk (`/home`) as before.
- Right-hand **preview pane**: compact candle chart (`1M` / `1Y` / `5Y`, default `1Y`) + `NewsPanel`.
- Chart ranges map to Yahoo daily bars: `1M→1mo`, `1Y→1y`, `5Y→5y` (`ScannerChart` + `fetchYahooChart`).
- Empty state: “Select a symbol to preview chart & news.”

### Desk

- `NewsPanel` sits in the main column under the price chart for the selected symbol (stocks and crypto via Yahoo `SYMBOL-USD` when needed).

### Significance scoring (v1, no LLM)

- **Significant**: earnings/EPS/revenue beat-miss, guidance changes, FDA, clinical trials, dilution/ATM/offering, bankruptcy, M&A, C-suite exits, halts, SEC/DOJ probes, splits, buybacks, PT moves, material contracts, delisting.
- **Watch**: partnership, expansion, insider activity, initiations, conferences, plain upgrades/downgrades, dividends.
- **Low**: top-movers lists, generic “shares rise/fall”, market wraps, SEO spam — hidden behind “Show low-signal” by default.
- Summary line e.g. `2 significant items — dilution/offering + earnings beat/miss`.

### Limitations

- Yahoo search news quality varies; many items are low-signal aggregators.
- Free Yahoo endpoints can **429**; news failures show a soft warning and do not break the scanner table or Desk chart.
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

