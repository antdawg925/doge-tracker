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
  XBT: 'XBTUSD',
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
  polkadot: 'DOTUSD',
  DOT: 'DOTUSD',
  chainlink: 'LINKUSD',
  LINK: 'LINKUSD',
  'avalanche-2': 'AVAXUSD',
  AVAX: 'AVAXUSD',
  'matic-network': 'POLUSD',
  MATIC: 'POLUSD',
  POL: 'POLUSD',
};

/** Resolve a Kraken USD pair for a crypto asset, or null if unknown. */
export function krakenPairFor(asset) {
  if (!asset) return null;
  if (asset.id && KRAKEN_PAIRS[asset.id]) return KRAKEN_PAIRS[asset.id];
  const sym = String(asset.symbol || '').toUpperCase();
  return KRAKEN_PAIRS[sym] || null;
}

function krakenCandidateUrls(pair, endpoint = 'OHLC') {
  const path =
    endpoint === 'Ticker'
      ? `/0/public/Ticker?pair=${encodeURIComponent(pair)}`
      : `/0/public/OHLC?pair=${encodeURIComponent(pair)}&interval=1440`;
  return [`${KRAKEN_PROXY}${path}`, `${KRAKEN_DIRECT}${path}`];
}

/**
 * Normalize Kraken OHLC rows:
 * `[time, open, high, low, close, vwap, volume, count]`
 * where `time` is unix **seconds** into chart bars (`t` in ms).
 */
export function normalizeKrakenOhlc(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => {
      if (!Array.isArray(row) || row.length < 5) return null;
      const [timeSec, openRaw, highRaw, lowRaw, closeRaw, , volumeRaw] = row;
      const close = Number(closeRaw);
      const open = Number(openRaw);
      const high = Number(highRaw);
      const low = Number(lowRaw);
      const volume = Number(volumeRaw);
      if (!Number.isFinite(close) || !Number.isFinite(timeSec)) return null;
      const t = Number(timeSec) * 1000;
      return {
        t,
        date: new Date(t).toISOString().slice(0, 10),
        open: Number.isFinite(open) ? open : close,
        high: Number.isFinite(high) ? high : close,
        low: Number.isFinite(low) ? low : close,
        close,
        volume: Number.isFinite(volume) && volume >= 0 ? volume : null,
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

/**
 * Spot from Kraken public Ticker.
 * Returns `{ price, change24h, source: 'kraken' }`.
 */
export async function fetchKrakenSpot(pair, { signal } = {}) {
  if (!pair) throw new Error('No Kraken pair');
  const urls = krakenCandidateUrls(pair, 'Ticker');
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
      const result = data?.result;
      if (!result || typeof result !== 'object') {
        lastErr = new Error('Kraken ticker empty');
        continue;
      }
      let ticker = null;
      for (const [key, value] of Object.entries(result)) {
        if (key === 'last') continue;
        if (value && typeof value === 'object') {
          ticker = value;
          break;
        }
      }
      if (!ticker) {
        lastErr = new Error('Kraken ticker missing pair row');
        continue;
      }
      const last = Number(Array.isArray(ticker.c) ? ticker.c[0] : ticker.c);
      const open = Number(ticker.o);
      if (!Number.isFinite(last)) {
        lastErr = new Error('Kraken ticker has no last price');
        continue;
      }
      let change24h = null;
      if (Number.isFinite(open) && open > 0) {
        change24h = ((last - open) / open) * 100;
      }
      return { price: last, change24h, source: 'kraken' };
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      lastErr = err;
    }
  }

  throw lastErr || new Error('Kraken ticker fetch failed');
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
    const bars = aggregateMarketChartToDaily(
      data?.prices,
      data?.total_volumes,
    );
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
      return {
        bars,
        source: 'coingecko',
        warning:
          'Volume unavailable from this history source — price candles only',
      };
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

/** Multi-TF lookbacks used for resistance (chart may stay shorter). */
export const TF_LOOKBACKS = {
  '6m': { key: '6m', days: 180, shortLabel: '6M', name: '6 months' },
  '1y': { key: '1y', days: 365, shortLabel: '1Y', name: '1 year' },
  '5y': { key: '5y', days: 1825, shortLabel: '5Y+', name: '5 years+' },
};

export const TF_ORDER = ['6m', '1y', '5y'];

/** Keep last N calendar-ish bars (bars are daily). */
export function sliceBarsLastDays(bars, days) {
  if (!bars?.length) return [];
  const n = Math.max(1, Number(days) || 1);
  return bars.slice(-n);
}

/** Honest label when API returned fewer days than the 5Y ask. */
export function describeHistorySpan(actualDays, requestedDays = 1825) {
  const d = Math.max(0, Math.round(Number(actualDays) || 0));
  const years = d / 365;
  if (d >= Math.min(requestedDays, 1500)) {
    return { shortLabel: '5Y+', name: '5 years+', approxYears: years, capped: false };
  }
  const yLabel = years >= 1.5 ? `~${Math.round(years)}y` : `~${years.toFixed(1)}y`;
  return {
    shortLabel: `Max (${yLabel})`,
    name: `max available (${yLabel})`,
    approxYears: years,
    capped: true,
  };
}

function barsSpanDays(bars) {
  if (!bars?.length) return 0;
  if (bars.length === 1) return 1;
  const first = bars[0].t;
  const last = bars[bars.length - 1].t;
  if (!Number.isFinite(first) || !Number.isFinite(last)) return bars.length;
  return Math.max(1, Math.round((last - first) / 86_400_000) + 1);
}

/**
 * Fetch the longest practical daily history for resistance math.
 * Stocks: Yahoo 5y. Crypto: CoinGecko (days=max / 1825) then Kraken (~720d max).
 * Returns { bars, source, warning?, actualDays, spanMeta }.
 */
export async function fetchLongDailyBars(asset, signal) {
  if (!asset) throw new Error('No asset selected');

  if (asset.type === 'stock') {
    const { bars } = await fetchYahooChart(asset.symbol, '5y', { signal });
    if (!bars.length) throw new Error('No Yahoo history for symbol');
    const actualDays = barsSpanDays(bars);
    return {
      bars,
      source: 'yahoo',
      actualDays,
      spanMeta: describeHistorySpan(actualDays, 1825),
    };
  }

  // Crypto — gather candidates; prefer the longest series.
  const coinId = asset.id || 'dogecoin';
  const candidates = [];
  let lastErr = null;
  let rateLimited = false;

  // CoinGecko: try max, then 365 (demo tier often caps ~1y)
  for (const daysParam of ['max', '1825', '365']) {
    try {
      const { data } = await fetchCoinGeckoJson(
        `/coins/${encodeURIComponent(coinId)}/market_chart?vs_currency=usd&days=${daysParam}`,
        { signal, maxRetries: 2 },
      );
      const bars = aggregateMarketChartToDaily(
        data?.prices,
        data?.total_volumes,
      );
      if (bars.length) {
        candidates.push({ bars, source: 'coingecko', note: `days=${daysParam}` });
        // max / 1825 success is enough; still try Kraken for possibly longer
        if (daysParam !== '365') break;
      }
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      lastErr = err;
      if (err?.rateLimited || /429/.test(err?.message || '')) rateLimited = true;
    }
  }

  const pair = krakenPairFor(asset);
  if (pair) {
    try {
      // Request more than Kraken returns; API caps ~720 daily bars
      const bars = await fetchKrakenDailyBars(pair, 2000, signal);
      if (bars.length) {
        candidates.push({
          bars,
          source: 'kraken',
          note: rateLimited
            ? 'Kraken (CoinGecko rate-limited)'
            : 'Kraken OHLC',
        });
      }
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      lastErr = err;
    }
  }

  if (!candidates.length) {
    const wrapped = new Error(formatHistoryError(lastErr));
    wrapped.rateLimited = rateLimited;
    throw wrapped;
  }

  candidates.sort((a, b) => b.bars.length - a.bars.length);
  const best = candidates[0];
  const actualDays = barsSpanDays(best.bars);
  const spanMeta = describeHistorySpan(actualDays, 1825);

  let warning = null;
  if (spanMeta.capped) {
    warning = `Long history capped at ${spanMeta.name} via ${best.source} (5Y+ not available on free APIs for this asset)`;
  } else if (best.source === 'kraken' && rateLimited) {
    warning = 'Long history via Kraken (CoinGecko rate-limited)';
  } else if (best.source === 'kraken') {
    warning = 'Long history via Kraken';
  }

  return {
    bars: best.bars,
    source: best.source,
    actualDays,
    spanMeta,
    warning,
  };
}

/**
 * Slice one long series into 6M / 1Y / 5Y+ (or max) buckets.
 */
export function buildTfBarSets(longBars, spanMeta) {
  const sets = {};
  for (const key of TF_ORDER) {
    const tf = TF_LOOKBACKS[key];
    let bars = sliceBarsLastDays(longBars, tf.days);
    let label = { shortLabel: tf.shortLabel, name: tf.name, capped: false };
    if (key === '5y' && spanMeta) {
      label = {
        shortLabel: spanMeta.shortLabel,
        name: spanMeta.name,
        capped: Boolean(spanMeta.capped),
      };
      // Use all available bars for the long bucket
      bars = longBars || [];
    }
    // If long series is shorter than the TF ask, still use what we have
    if (key !== '5y' && longBars?.length && bars.length < Math.min(tf.days, longBars.length)) {
      bars = sliceBarsLastDays(longBars, tf.days);
    }
    sets[key] = {
      key,
      bars,
      days: bars.length,
      shortLabel: label.shortLabel,
      name: label.name,
      capped: label.capped,
    };
  }
  return sets;
}
