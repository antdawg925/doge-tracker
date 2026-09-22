# Position Tracker (crypto & stocks)

A small Vite + React dashboard for sharing a **simple position** with non-traders: what you hold, what you paid, where you’d take profit, where support/resistance sit, and where you’d set a stop.

Default symbol is **DOGE** (crypto). Search any crypto (CoinGecko) or stock/ETF (Yahoo) — e.g. BTC, ETH, AAPL, TSLA.

**Not investment advice.** Numbers are editable defaults for a personal plan — **not** live brokerage positions.

## Quick start

```bash
cd /workspace/doge-tracker
npm install
npm run dev
```

Then open the URL Vite prints (usually `http://localhost:5173`). The app redirects `/` → `/home`, so you can also open `http://localhost:5173/home` directly.

```bash
npm run build
npm run preview   # optional local preview of dist/
```

### Routes

| Path | Page |
| --- | --- |
| `/` | Redirects to `/home` |
| `/home` | Main position tracker (current UI) |

More pages can be added under `src/pages/` and wired in `src/App.jsx`.

### VS Code / editor notes

If you open deep links like `/home` while the Vite dev server is running, they work out of the box (Vite’s SPA history fallback). For production hosts, configure an SPA rewrite so unknown paths serve `index.html` (see Deploy note below). In VS Code Simple Browser or Live Preview, prefer the Vite URL (`npm run dev`) rather than opening `dist/index.html` as a file.

### Deploy note (SPA)

Vite’s dev server already falls back to `index.html` for client-side routes. When you deploy `dist/` later, configure your host the same way (e.g. Netlify `_redirects` `/* /index.html 200`, nginx `try_files $uri /index.html`, GitHub Pages 404.html trick, etc.) so `/home` and future routes load the app instead of a 404.

## Symbol search

Type a ticker or name, then press **Enter** or click **Search** (lookup does not run on hover or while typing alone). Results are labeled **Crypto** vs **Stock**. Selecting one:

1. Stores `{ symbol, name, type: 'crypto'|'stock', id? }` (`id` = CoinGecko coin id for crypto)
2. Refetches live spot + daily history
3. Recomputes support / resistance / suggested stops
4. Loads that symbol’s saved position fields from `localStorage` (or sensible defaults)

### How symbol resolution works

| Type | Search | Spot | History |
| --- | --- | --- | --- |
| **Crypto** | CoinGecko `/search?query=` | CoinGecko `/simple/price?ids=` → **Kraken** ticker (mapped pairs) → Yahoo `SYMBOL-USD` | Short chart: CoinGecko `market_chart` / `ohlc`; **Kraken** fallback. Long resistance: CoinGecko `days=max`/`365` + Kraken (~720d) — see Multi-timeframe resistance |
| **Stock** | Yahoo `/v1/finance/search?q=` | Yahoo chart meta only (`regularMarketPrice` + previous close → 24h %) — never CoinGecko | Yahoo chart `range=1mo\|3mo` (display); `6mo\|1y\|5y` for multi-TF resistance |

Vite proxies (CORS + Yahoo User-Agent):

- `/api/coingecko/*` → `api.coingecko.com/api/v3/*`
- `/api/kraken/*` → `api.kraken.com/*`
- `/api/yahoo/*` → `query1.finance.yahoo.com/*`
- `/api/yahoo-search/*` → `query2.finance.yahoo.com/*`

### Free-tier rate limits (429)

CoinGecko’s public/demo tier often returns **HTTP 429** when you scan many symbols. Spot fetch **limits CoinGecko retries (1–2 attempts)** and **falls back** to Kraken (when a USD pair is mapped: DOGE, BTC/XBT, ETH, SOL, …) then Yahoo crypto charts (`DOGE-USD`, `BTC-USD`, …). Stocks stay on Yahoo only.

On 429 / network errors: soft warning (not a hard crash), keep last good cache, slower poll. Successful fallbacks may show a brief “via Kraken/Yahoo” note. **Refresh** retries spot + history — if rate-limited, wait a minute or two before hammering Search again.

## Shareable model (three inputs)

Right-side editor (labels adapt to coins vs shares):

| Field | Meaning |
| --- | --- |
| **Holding** | Units owned (coins or shares) |
| **Average cost** | $ per unit paid |
| **Target price** | Take-profit idea ($ per unit) |

Derived: position value, cost basis, unrealized P&L, value/P&L if target hits.

### Persistence

`localStorage` key `doge-tracker-state-v2`:

```json
{
  "selected": { "symbol": "DOGE", "name": "Dogecoin", "type": "crypto", "id": "dogecoin" },
  "positions": {
    "crypto:dogecoin": { "coins": 24324, "avgCost": 0.074, "targetPrice": 0.2 },
    "stock:AAPL": { "coins": 10, "avgCost": 180, "targetPrice": 220 }
  }
}
```

Legacy `doge-tracker-position-v1` migrates into the DOGE entry automatically.

## Features

- Live spot + 24h change
- Daily **candlestick** chart (30d / 90d) with key S/R markers ([lightweight-charts](https://tradingview.github.io/lightweight-charts/))
- **Volume** histogram under the candles (green/red by candle direction) + optional **20-day average** line
- Dad-friendly **volume strip**: today’s volume, 20-day average, **RVOL** (Quiet / Normal / Elevated / Very high), and a short rising/fading hint
- Soft note when a crypto history source lacks volume (price candles still render)
- **Momentum / pattern stage box** near the top (estimated 1–7 stage, tradability hint, RVOL / structure chips) — pattern context only
- **Suggested stop losses** aligned with the same Top supports (own section)
- **Support** panel — **Top 5** floors with a one-sentence why each and **risk from here** (nearest structural, 20d/50d-ish, 6M / 1Y / max lows when available)
  - With a holding (qty + avg cost): **$ and % vs average cost** for the whole position
  - Researching only (no shares or no avg cost): **% below today** only — no invented dollars
- **Resistance** panel — **Top 5** ceilings with a one-sentence why each, mixed from long history (6M / 1Y / max):
  - Condensed list (not a dump of every TF row)
  - Each level: price, % above today, plus **Upside from here** (with a holding: $ and % vs average cost; otherwise % from today only)
  - Optional secondary comparison of 6M / 1Y / 5Y+ period highs
  - Primary **trim zone** weighted toward longer TF significance (1Y / 5Y+)
  - Clear note when spot is near ATH / top of available history
- Plain-language copy — not a pro terminal

## How stops are chosen

1. Same **Top 5 supports** as the Support panel — not every statistical line.
2. Prefer familiar markers across timeframes (swing low, 20d/50d, 6M / 1Y / max lows); **≤5** levels, deduped.
3. **Primary stop** = closest support at least ~**3%** below spot when available.
4. Each card: price, % below today, plus **Risk from here** — with a holding: $ and % **vs average cost**; researching only: % below today (no invented dollars). Same one-line why when available.


## Multi-timeframe resistance

Support / suggested stops still use the chart lookback (30d / 90d). **Resistance** loads a separate long daily series and slices it:

| Bucket | Target lookback | Typical source |
| --- | --- | --- |
| **6M** | ~180 trading days | Slice of long series |
| **1Y** | ~365 days | Slice of long series |
| **5Y+** | ~1825 days | Full long series (or max available) |

### API range limits (discovered)

| Asset type | Source | Practical max history |
| --- | --- | --- |
| **Stocks** | Yahoo `range=5y` | Full ~5 years (~1825 calendar days) |
| **Crypto** | CoinGecko `market_chart` (free / demo) | Often capped around **~365 days** (`days=max` / long ints may still truncate) |
| **Crypto** | Kraken public OHLC `interval=1440` | **~720 daily bars** (~2 years) — used when longer than CoinGecko or on 429 |

When 5 years isn’t available, the UI labels the long bucket honestly, e.g. **Max (~2y)**, with a soft warning. Rate limits (429) keep the last good long-history cache.

Hook: `useLongHistory` → `fetchLongDailyBars` → `buildTfBarSets` → `buildMultiTfResistance`.

## Chart library

Daily price view uses **TradingView [lightweight-charts](https://tradingview.github.io/lightweight-charts/)** candlesticks (OHLC) on the dark theme, with a synced **volume histogram** pane underneath. Hover shows open / high / low / close / volume. Day-range toggle remains **30d / 90d**.

Volume comes from Yahoo (stocks), CoinGecko `market_chart` `total_volumes` (crypto), or Kraken OHLC (crypto fallback). CoinGecko’s OHLC-only fallback has no volume — the UI notes that and still shows candles.

Helpers: `src/lib/volume.js` (`computeVolumeMetrics`, RVOL bands).

## Project layout

```
src/
  App.jsx       # BrowserRouter + routes (`/` → `/home`, `/home` → Home)
  main.jsx
  pages/        # Route pages (Home.jsx = current tracker; add more here)
  components/   # Header, SymbolSearch, StageBox, PriceCard, PositionSummary, PositionEditor,
                # PriceChart, SuggestedStops, SupportPanel, ResistancePanel, Disclaimer
  hooks/        # useAssetPrice, useAssetHistory, useLongHistory
  lib/          # assets, defaults, format, math, levels, volume, marketStage, coingecko,
                # yahoo, history, price, search
```

## License

Personal / educational scaffold — use at your own risk.
