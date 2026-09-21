/** Daily OHLC history: CoinGecko first, then Kraken public OHLC fallback. */

import {
  aggregateMarketChartToDaily,
  fetchCoinGeckoJson,
  normalizeOhlc,
} from './coingecko.js';

const KRAKEN_PROXY = '/api/kraken';
const KRAKEN_DIRECT = 'https://api.kraken.com';
const KRAKEN_OHLC_PATH = '/0/public/OHLC?pair=DOGEUSD&interval=1440';

function krakenCandidateUrls() {
  return [`${KRAKEN_PROXY}${KRAKEN_OHLC_PATH}`, `${KRAKEN_DIRECT}${KRAKEN_OHLC_PATH}`];
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

/**
 * Fetch daily bars from Kraken (proxy first, then direct).
 * Returns bars already sliced to the last `days` entries.
 */
export async function fetchKrakenDailyBars(days, signal) {
  const urls = krakenCandidateUrls();
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
  if (!err) return 'Failed to load DOGE history';
  if (err.rateLimited || /429/.test(err.message || '')) {
    return 'HTTP 429 (CoinGecko rate limited)';
  }
  const msg = err.message || String(err);
  if (/failed to fetch/i.test(msg)) {
    return 'Network/CORS error (Failed to fetch)';
  }
  return msg;
}

/**
 * CoinGecko market_chart → CoinGecko ohlc → Kraken daily OHLC.
 * Returns `{ bars, source: 'coingecko' | 'kraken', warning?: string }`.
 */
export async function fetchDailyBars(days, signal) {
  const chartDays = days >= 90 ? Math.max(days, 91) : days;
  let lastErr = null;

  try {
    const { data } = await fetchCoinGeckoJson(
      `/coins/dogecoin/market_chart?vs_currency=usd&days=${chartDays}`,
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
      `/coins/dogecoin/ohlc?vs_currency=usd&days=${days}`,
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

  try {
    const bars = await fetchKrakenDailyBars(days, signal);
    const limited = Boolean(
      lastErr?.rateLimited || /429/.test(lastErr?.message || ''),
    );
    return {
      bars,
      source: 'kraken',
      warning: limited
        ? 'History via Kraken (CoinGecko rate-limited)'
        : 'History via Kraken (CoinGecko unavailable)',
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

export { formatHistoryError };
