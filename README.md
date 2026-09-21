# DOGE Position Tracker

A small Vite + React dashboard for sharing a **simple Dogecoin position** with non-traders: what you hold, what you paid, where you’d take profit, and where you’d set a stop based on support.

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

## Shareable model (three inputs)

Right-side editor only:

| Field | Meaning |
| --- | --- |
| **DOGE holding** | Coins owned |
| **Average cost** | $/DOGE paid |
| **Target price** | Take-profit idea ($/DOGE) |

Derived from those + live spot: position value, cost basis, unrealized P&L, and value/P&L if the target hits. Persisted in `localStorage` (legacy `dogeValue` + `avgCost` migrates to `coins ≈ dogeValue / avgCost`).

## Features

- Live DOGE/USD + 24h change (CoinGecko; soft cache on rate limits)
- Daily price chart (30d / 90d) with key S/R markers (recharts)
- **Suggested stop losses** from support levels below spot (nearest / stronger supports, $ risk vs spot and vs cost, one primary recommendation)
- Support & resistance table with sell estimates for the holding
- Plain-language copy aimed at explaining the plan — not a pro terminal

## How stops are chosen

1. Take statistical supports from daily history (percentiles, swing low, rolling lows, mean − 1σ, etc.) that sit **below** spot.
2. Prefer familiar markers (swing low, 25th pct, median, 20d/50d lows…); show up to ~4 distinct levels.
3. **Primary stop** = closest support at least ~**3%** below spot when available (so noise doesn’t stop you out); otherwise the nearest support.
4. Each card shows price, % below spot, and $ risk if stopped (vs spot and vs avg cost).

## CoinGecko / rate limits

- Spot: `/api/coingecko/simple/price?...` → CoinGecko public API
- History: CoinGecko `market_chart` / OHLC, then **Kraken daily OHLC** (`DOGEUSD`) when CoinGecko is rate-limited
- Vite proxies `/api/coingecko/*` and `/api/kraken/*`
- On HTTP 429: backoff, keep last good data, soft warning, slower poll. **Refresh** retries spot + history.

## Project layout

```
src/
  App.jsx
  components/   # Header, PriceCard, PositionSummary, PositionEditor,
                # PriceChart, SuggestedStops, SupportResistance, Disclaimer
  hooks/        # useDogePrice, useDogeHistory
  lib/          # defaults (+ migration), format, math, levels, coingecko, history
```

## License

Personal / educational scaffold — use at your own risk.
