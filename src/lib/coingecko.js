/** CoinGecko fetch helpers: proxy-first, backoff, localStorage cache. */

const PROXY_BASE = '/api/coingecko';
const DIRECT_BASE = 'https://api.coingecko.com/api/v3';

const PRICE_CACHE_KEY = 'doge-tracker-price-cache-v1';
const HISTORY_CACHE_KEY = 'doge-tracker-history-cache-v2';

export function loadJsonCache(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function saveJsonCache(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota / private mode */
  }
}

export { PRICE_CACHE_KEY, HISTORY_CACHE_KEY };

/**
 * Build candidate URLs: Vite proxy first, then direct CoinGecko.
 * `path` is like `/simple/price?...` or `/coins/dogecoin/ohlc?...`
 */
export function candidateUrls(path) {
  const clean = path.startsWith('/') ? path : `/${path}`;
  return [`${PROXY_BASE}${clean}`, `${DIRECT_BASE}${clean}`];
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch JSON trying each URL. Retries on 429 with exponential backoff.
 * Returns { data, fromCache: false } or throws last error.
 */
export async function fetchCoinGeckoJson(path, { signal, maxRetries = 3 } = {}) {
  const urls = candidateUrls(path);
  let lastErr = null;
  let rateLimited = false;

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    for (const url of urls) {
      try {
        const res = await fetch(url, {
          signal,
          headers: { Accept: 'application/json' },
        });
        if (res.status === 429) {
          rateLimited = true;
          lastErr = new Error('HTTP 429 (CoinGecko rate limited)');
          continue;
        }
        if (!res.ok) {
          lastErr = new Error(`HTTP ${res.status}`);
          continue;
        }
        const data = await res.json();
        return { data, rateLimited: false };
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        // Prefer known 429 over a later generic network/"Failed to fetch" error
        if (!rateLimited) {
          const msg = err?.message || String(err);
          lastErr = /failed to fetch/i.test(msg)
            ? new Error('Network/CORS error (Failed to fetch)')
            : err instanceof Error
              ? err
              : new Error(msg);
        }
      }
    }
    if (rateLimited && attempt < maxRetries - 1) {
      const delay = Math.min(30_000, 1500 * 2 ** attempt);
      await sleep(delay);
    } else if (!rateLimited) {
      break;
    }
  }

  const err =
    lastErr ||
    new Error(
      rateLimited
        ? 'HTTP 429 (CoinGecko rate limited)'
        : 'CoinGecko fetch failed',
    );
  if (rateLimited && !/429/.test(err.message || '')) {
    err.message = 'HTTP 429 (CoinGecko rate limited)';
  }
  err.rateLimited = rateLimited;
  throw err;
}

/**
 * Normalize CoinGecko OHLC rows [[ts, o, h, l, c], ...] into daily bars.
 * Already daily for days=30/90 on the OHLC endpoint.
 */
export function normalizeOhlc(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => {
      if (!Array.isArray(row) || row.length < 5) return null;
      const [ts, open, high, low, close] = row;
      if (!Number.isFinite(close)) return null;
      return {
        t: ts,
        date: new Date(ts).toISOString().slice(0, 10),
        open,
        high: Number.isFinite(high) ? high : close,
        low: Number.isFinite(low) ? low : close,
        close,
      };
    })
    .filter(Boolean);
}

/**
 * Aggregate market_chart prices [[ts, price], ...] into daily OHLC.
 * Optional `volumes` [[ts, vol], ...] are summed per calendar day.
 */
export function aggregateMarketChartToDaily(prices, volumes) {
  if (!Array.isArray(prices)) return [];
  const byDay = new Map();
  for (const row of prices) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const [ts, price] = row;
    if (!Number.isFinite(price)) continue;
    const date = new Date(ts).toISOString().slice(0, 10);
    const prev = byDay.get(date);
    if (!prev) {
      byDay.set(date, {
        t: ts,
        date,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: 0,
        _hasVol: false,
      });
    } else {
      prev.high = Math.max(prev.high, price);
      prev.low = Math.min(prev.low, price);
      prev.close = price;
      prev.t = ts;
    }
  }

  if (Array.isArray(volumes)) {
    for (const row of volumes) {
      if (!Array.isArray(row) || row.length < 2) continue;
      const [ts, vol] = row;
      if (!Number.isFinite(vol) || vol < 0) continue;
      const date = new Date(ts).toISOString().slice(0, 10);
      const prev = byDay.get(date);
      if (!prev) continue;
      prev.volume += vol;
      prev._hasVol = true;
    }
  }

  return [...byDay.values()]
    .map(({ _hasVol, volume, ...rest }) => ({
      ...rest,
      volume: _hasVol ? volume : null,
    }))
    .sort((a, b) => a.t - b.t);
}
