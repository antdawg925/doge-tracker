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

Then open the URL Vite prints (usually `http://localhost:5173`).

```bash
npm run build
npm run preview   # optional local preview of dist/
```

## Symbol search

Type a ticker or name, then press **Enter** or click **Search** (lookup does not run on hover or while typing alone). Results are labeled **Crypto** vs **Stock**. Selecting one:

1. Stores `{ symbol, name, type: 'crypto'|'stock', id? }` (`id` = CoinGecko coin id for crypto)
2. Refetches live spot + daily history
3. Recomputes support / resistance / suggested stops
4. Loads that symbol’s saved position fields from `localStorage` (or sensible defaults)

### How symbol resolution works

| Type | Search | Spot | History |
| --- | --- | --- | --- |
| **Crypto** | CoinGecko `/search?query=` | CoinGecko `/simple/price?ids=` | Short chart: CoinGecko `market_chart` / `ohlc`; **Kraken** fallback. Long resistance: CoinGecko `days=max`/`365` + Kraken (~720d) — see Multi-timeframe resistance |
| **Stock** | Yahoo `/v1/finance/search?q=` | Yahoo chart meta (`regularMarketPrice` + previous close → 24h %) | Yahoo chart `range=1mo\|3mo` (display); `6mo\|1y\|5y` for multi-TF resistance |

Vite proxies (CORS + Yahoo User-Agent):

- `/api/coingecko/*` → `api.coingecko.com/api/v3/*`
- `/api/kraken/*` → `api.kraken.com/*`
- `/api/yahoo/*` → `query1.finance.yahoo.com/*`
- `/api/yahoo-search/*` → `query2.finance.yahoo.com/*`

On HTTP 429 / network errors: soft warning, keep last good cache, slower poll. **Refresh** retries spot + history.

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
- **Support** panel — **Top 5** floors with a one-sentence why each (nearest structural, 20d/50d-ish, 6M / 1Y / max lows when available)
- **Resistance** panel — **Top 5** ceilings with a one-sentence why each, mixed from long history (6M / 1Y / max):
  - Condensed list (not a dump of every TF row)
  - Each level: price, % above spot, $ upside vs spot & cost, brief significance note
  - Optional secondary comparison of 6M / 1Y / 5Y+ period highs
  - Primary **trim zone** weighted toward longer TF significance (1Y / 5Y+)
  - Clear note when spot is near ATH / top of available history
- Plain-language copy — not a pro terminal

## How stops are chosen

1. Same **Top 5 supports** as the Support panel — not every statistical line.
2. Prefer familiar markers across timeframes (swing low, 20d/50d, 6M / 1Y / max lows); **≤5** levels, deduped.
3. **Primary stop** = closest support at least ~**3%** below spot when available.
4. Each card: price, % below spot, $ risk vs spot and vs cost (plus the same one-line why when available).


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
  App.jsx
  components/   # Header, SymbolSearch, StageBox, PriceCard, PositionSummary, PositionEditor,
                # PriceChart, SuggestedStops, SupportPanel, ResistancePanel, Disclaimer
  hooks/        # useAssetPrice, useAssetHistory, useLongHistory
  lib/          # assets, defaults, format, math, levels, volume, marketStage, coingecko,
                # yahoo, history, price, search
```

## License

Personal / educational scaffold — use at your own risk.
