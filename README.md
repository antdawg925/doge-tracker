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
| `/scanner` | Placeholder (Milestone 2 — % change / RVOL scan) |
| `/alerts` | Placeholder (Milestone 2 — price / stage / RVOL alerts) |

Shared chrome: `AppLayout` (brand **Trade Desk** + nav). Desk workspace: left **Watchlist** (persisted), center analysis widgets, right position summary/editor.

### VS Code / editor notes

Deep links like `/home` work with Vite’s SPA history fallback. For production hosts, configure an SPA rewrite so unknown paths serve `index.html`. Prefer `npm run dev` over opening `dist/index.html` as a file.

### Deploy note (SPA)

When you deploy `dist/` later, configure your host for SPA fallback (e.g. Netlify `_redirects` `/* /index.html 200`, nginx `try_files $uri /index.html`). **This repo does not auto-deploy for Milestone 1.**

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
    Scanner.jsx        # M2 placeholder
    Alerts.jsx         # M2 placeholder
  hooks/               # useAssetPrice, useAssetHistory, useLongHistory
  lib/                 # assets, defaults, levels, volume, marketStage, …
```

## Milestone 2 (planned)

- **Scanner**: % change + RVOL scan over watchlist / liquid names
- **Alerts**: price, stage, and RVOL thresholds with notifications

## License

Personal / educational scaffold — use at your own risk.
