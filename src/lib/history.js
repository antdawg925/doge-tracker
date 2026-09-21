/** Daily OHLC history: CoinGecko / Kraken for crypto, Yahoo for stocks. */

import {
  aggregateMarketChartToDaily,
  fetchCoinGeckoJson,
  normalizeOhlc,
} from './coingecko.js';
import { daysToYahooRange, fetchYahooChart } from './yahoo.js';

const KRAKEN_PROXY = '/api/kraken';
const KRAKEN_DIRECT = 'https://api.kraken.com';

/** Common CoinGecko id / symbol → Kraken USD pair. */
const KRAKEN_PAIRS = {
  dogecoin: 'DOGEUSD',
  DOGE: 'DOGEUSD',
  bitcoin: 'XBTUSD',
  BTC: 'XBTUSD',
  ethereum: 'ETHUSD',
  ETH: 'ETHUSD',
  solana: 'SOLUSD',
  SOL: 'SOLUSD',
  ripple: 'XRPUSD',
  XRP: 'XRPUSD',
  cardano: 'ADAUSD',
  ADA: 'ADAUSD',
  litecoin: 'LTCUSD',
  LTC: 'LTCUSD',
};

function krakenPairFor(asset) {
  if (!asset) return null;
  if (asset.id && KRAKEN_PAIRS[asset.id]) return KRAKEN_PAIRS[asset.id];
  const sym = String(asset.symbol || '').toUpperCase();
  return KRAKEN_PAIRS[sym] || null;
}

function krakenCandidateUrls(pair) {
  const path = `/0/public/OHLC?pair=${encodeURIComponent(pair)}&interval=1440`;
  return [`${KRAKEN_PROXY}${path}`, `${KRAKEN_DIRECT}${path}`];
}

/**
 * Normalize Kraken OHLC rows `[time, open, high, low, close, ...]`
 * where `time` is unix **seconds** into chart bars (`t` in ms).
 */
export function normalizeKrakenOhlc(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => {
      if (!Array.isArray(row) || row.length < 5) return null;
      const [timeSec, openRaw, highRaw, lowRaw, closeRaw] = row;
      const close = Number(closeRaw);
      const open = Number(openRaw);
      const high = Number(highRaw);
      const low = Number(lowRaw);
      if (!Number.isFinite(close) || !Number.isFinite(timeSec)) return null;
      const t = Number(timeSec) * 1000;
      return {
        t,
        date: new Date(t).toISOString().slice(0, 10),
        open: Number.isFinite(open) ? open : close,
        high: Number.isFinite(high) ? high : close,
        low: Number.isFinite(low) ? low : close,
        close,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.t - b.t);
}

function pickKrakenPairRows(result) {
  if (!result || typeof result !== 'object') return null;
  for (const [key, value] of Object.entries(result)) {
    if (key === 'last') continue;
    if (Array.isArray(value)) return value;
  }
  return null;
}

export async function fetchKrakenDailyBars(pair, days, signal) {
  const urls = krakenCandidateUrls(pair);
  let lastErr = null;

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        signal,
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        lastErr = new Error(`Kraken HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      if (Array.isArray(data?.error) && data.error.length) {
        lastErr = new Error(`Kraken: ${data.error.join(', ')}`);
        continue;
      }
      const rows = pickKrakenPairRows(data?.result);
      const bars = normalizeKrakenOhlc(rows);
      if (!bars.length) {
        lastErr = new Error('Kraken returned empty OHLC');
        continue;
      }
      const n = Math.max(1, Number(days) || 90);
      return bars.slice(-n);
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      lastErr = err;
    }
  }

  throw lastErr || new Error('Kraken OHLC fetch failed');
}

function formatHistoryError(err) {
  if (!err) return 'Failed to load history';
  if (err.rateLimited || /429/.test(err.message || '')) {
    return err.message || 'HTTP 429 (rate limited)';
  }
  const msg = err.message || String(err);
  if (/failed to fetch/i.test(msg)) {
    return 'Network/CORS error (Failed to fetch)';
  }
  return msg;
}

async function fetchCryptoDailyBars(asset, days, signal) {
  const coinId = asset.id || 'dogecoin';
  const chartDays = days >= 90 ? Math.max(days, 91) : days;
  let lastErr = null;

  try {
    const { data } = await fetchCoinGeckoJson(
      `/coins/${encodeURIComponent(coinId)}/market_chart?vs_currency=usd&days=${chartDays}`,
      { signal, maxRetries: 3 },
    );
    const bars = aggregateMarketChartToDaily(data?.prices);
    if (bars.length) {
      return { bars: bars.slice(-days), source: 'coingecko' };
    }
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    lastErr = err;
  }

  try {
    const { data } = await fetchCoinGeckoJson(
      `/coins/${encodeURIComponent(coinId)}/ohlc?vs_currency=usd&days=${days}`,
      { signal, maxRetries: 2 },
    );
    const bars = normalizeOhlc(data);
    if (bars.length) {
      return { bars, source: 'coingecko' };
    }
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    lastErr = err;
  }

  const pair = krakenPairFor(asset);
  if (pair) {
    try {
      const bars = await fetchKrakenDailyBars(pair, days, signal);
      const limited = Boolean(
        lastErr?.rateLimited || /429/.test(lastErr?.message || ''),
      );
      return {
        bars,
        source: 'kraken',
        warning: limited
          ? `History via Kraken (CoinGecko rate-limited)`
          : `History via Kraken (CoinGecko unavailable)`,
      };
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      const cg = formatHistoryError(lastErr);
      const kr = err?.message || 'Kraken failed';
      const wrapped = new Error(`${cg}; Kraken fallback failed (${kr})`);
      wrapped.rateLimited = Boolean(
        lastErr?.rateLimited || /429/.test(lastErr?.message || ''),
      );
      throw wrapped;
    }
  }

  const wrapped = new Error(formatHistoryError(lastErr));
  wrapped.rateLimited = Boolean(
    lastErr?.rateLimited || /429/.test(lastErr?.message || ''),
  );
  throw wrapped;
}

async function fetchStockDailyBars(asset, days, signal) {
  const range = daysToYahooRange(days);
  const { bars } = await fetchYahooChart(asset.symbol, range, { signal });
  if (!bars.length) throw new Error('No Yahoo history for symbol');
  return {
    bars: bars.slice(-Math.max(1, days)),
    source: 'yahoo',
  };
}

/**
 * Fetch daily bars for any asset.
 * Returns `{ bars, source, warning? }`.
 */
export async function fetchDailyBars(asset, days, signal) {
  if (!asset) throw new Error('No asset selected');
  if (asset.type === 'stock') {
    return fetchStockDailyBars(asset, days, signal);
  }
  return fetchCryptoDailyBars(asset, days, signal);
}

/** @deprecated DOGE-only entry — kept for any lingering imports */
export async function fetchDailyBarsDoge(days, signal) {
  return fetchDailyBars(
    { symbol: 'DOGE', name: 'Dogecoin', type: 'crypto', id: 'dogecoin' },
    days,
    signal,
  );
}

export { formatHistoryError };
