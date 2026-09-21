# DOGE Position Tracker

A small Vite + React planning dashboard for a Dogecoin book: live spot from CoinGecko, daily price chart, support/resistance sell estimates, editable account/core/sleeve inputs, buy ladder, vol-sleeve rules, and mark-to-market P&amp;L scenarios.

**Not investment advice.** Numbers shipped as editable defaults for a personal plan (~$15k account, ~$1.8k DOGE, ~$10k target book). They are **not** live brokerage positions.

## Quick start

```bash
cd /workspace/doge-tracker
npm install
npm run dev
```

Then open the URL Vite prints (usually `http://localhost:5173`).

Production build:

```bash
npm run build
npm run preview   # optional local preview of dist/
```

## Features

- Live DOGE/USD + 24h change via CoinGecko public API (no API key)
- **Daily price chart** (30d / 90d) with area of closes, high/low in tooltip, and key S/R markers (recharts)
- **Support & resistance table** — median, percentiles, swing / rolling highs & lows, mean ± 1σ — plus **sell estimates** (profit $ / % vs avg cost and vs current spot) for the full editable DOGE book
- Position inputs persisted in `localStorage`
- Core vs vol sleeve split and progress toward a $10k DOGE target
- Buy ladder with distance %, planned $, estimated coins
- Vol sleeve sell / rebuy / invalidation cheat-sheet
- P&amp;L scenario table at spot and key levels

## CoinGecko / rate limits

Hooks prefer the Vite proxy, then the public URL:

- Spot: `/api/coingecko/simple/price?...` → `https://api.coingecko.com/api/v3/simple/price?...`
- History: `market_chart` first, then CoinGecko OHLC, then **Kraken daily OHLC** (`DOGEUSD`, interval 1440) when CoinGecko is rate-limited or unreachable

Vite also proxies `/api/kraken/*` → `https://api.kraken.com/*` (tried before the direct Kraken URL for CORS safety).

On **HTTP 429**, requests use exponential backoff, keep the **last good** spot/history in memory + `localStorage`, show a soft warning (UI does not go blank), and slow spot polling to ~120s. Chart history may show **“History via Kraken (CoinGecko rate-limited)”** when the Kraken fallback succeeds. Use **Refresh** for an immediate retry of spot + history.

## Project layout

```
src/
  App.jsx                 # layout only
  main.jsx
  index.css
  components/             # Header, PriceCard, PriceChart, SupportResistance, …
  hooks/{useDogePrice,useDogeHistory}.js
  lib/{defaults,format,math,levels,coingecko,history}.js
```

## License

Personal / educational scaffold — use at your own risk.
