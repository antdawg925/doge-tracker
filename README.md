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

Type a ticker or name in the search box at the top (debounced). Results are labeled **Crypto** vs **Stock**. Selecting one:

1. Stores `{ symbol, name, type: 'crypto'|'stock', id? }` (`id` = CoinGecko coin id for crypto)
2. Refetches live spot + daily history
3. Recomputes support / resistance / suggested stops
4. Loads that symbol’s saved position fields from `localStorage` (or sensible defaults)

### How symbol resolution works

| Type | Search | Spot | History |
| --- | --- | --- | --- |
| **Crypto** | CoinGecko `/search?query=` | CoinGecko `/simple/price?ids=` | CoinGecko `market_chart` → `ohlc`; **Kraken** daily OHLC fallback for common pairs (DOGE, BTC, ETH, SOL, XRP, ADA, LTC) |
| **Stock** | Yahoo `/v1/finance/search?q=` | Yahoo chart meta (`regularMarketPrice` + previous close → 24h %) | Yahoo `/v8/finance/chart/{SYM}?interval=1d&range=1mo\|3mo` |

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
- Daily chart (30d / 90d) with key S/R markers (recharts)
- **Suggested stop losses** from supports below spot (own section)
- **Support** panel — levels below spot
- **Resistance** panel — richer upside / trim detail above spot:
  - price, % above spot, $ upside vs spot and vs avg cost
  - labels (nearest, swing high, p75, rolling highs…)
  - primary **trim zone** (nearest meaningful resistance, steered toward your target when set)
  - note relating your target to nearest resistances
- Plain-language copy — not a pro terminal

## How stops are chosen

1. Statistical supports from daily history that sit **below** spot.
2. Prefer familiar markers (swing low, 25th pct, median, 20d/50d lows…); up to ~4 levels.
3. **Primary stop** = closest support at least ~**3%** below spot when available.
4. Each card: price, % below spot, $ risk vs spot and vs cost.

## Project layout

```
src/
  App.jsx
  components/   # Header, SymbolSearch, PriceCard, PositionSummary, PositionEditor,
                # PriceChart, SuggestedStops, SupportPanel, ResistancePanel, Disclaimer
  hooks/        # useAssetPrice, useAssetHistory
  lib/          # assets, defaults, format, math, levels, coingecko, yahoo,
                # history, price, search
```

## License

Personal / educational scaffold — use at your own risk.
