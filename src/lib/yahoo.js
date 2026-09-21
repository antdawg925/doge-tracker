/** Yahoo Finance public chart / search helpers (via Vite proxy). */

const CHART_PROXY = '/api/yahoo';
const CHART_DIRECT = 'https://query1.finance.yahoo.com';
const SEARCH_PROXY = '/api/yahoo-search';
const SEARCH_DIRECT = 'https://query2.finance.yahoo.com';

const YAHOO_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function chartUrls(path) {
  const clean = path.startsWith('/') ? path : `/${path}`;
  return [`${CHART_PROXY}${clean}`, `${CHART_DIRECT}${clean}`];
}

function searchUrls(path) {
  const clean = path.startsWith('/') ? path : `/${path}`;
  return [`${SEARCH_PROXY}${clean}`, `${SEARCH_DIRECT}${clean}`];
}

async function fetchYahooJson(urls, { signal } = {}) {
  let lastErr = null;
  for (const url of urls) {
    try {
      const headers = { Accept: 'application/json' };
      // Direct calls need a browser-like UA; proxy injects its own.
      if (!url.startsWith('/')) {
        headers['User-Agent'] = YAHOO_UA;
      }
      const res = await fetch(url, { signal, headers });
      if (res.status === 429) {
        lastErr = new Error('HTTP 429 (Yahoo rate limited)');
        lastErr.rateLimited = true;
        continue;
      }
      if (!res.ok) {
        lastErr = new Error(`Yahoo HTTP ${res.status}`);
        continue;
      }
      return await res.json();
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      lastErr =
        err instanceof Error ? err : new Error(String(err?.message || err));
    }
  }
  throw lastErr || new Error('Yahoo fetch failed');
}

/**
 * Search equities / ETFs. Returns normalized stock hits.
 */
export async function searchYahoo(query, { signal, limit = 8 } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const path = `/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=${limit}&newsCount=0`;
  const data = await fetchYahooJson(searchUrls(path), { signal });
  const quotes = Array.isArray(data?.quotes) ? data.quotes : [];
  return quotes
    .filter((q) => {
      const t = (q.quoteType || q.typeDisp || '').toUpperCase();
      return (
        t === 'EQUITY' ||
        t === 'ETF' ||
        t === 'MUTUALFUND' ||
        t === 'INDEX' ||
        q.isYahooFinance
      );
    })
    .slice(0, limit)
    .map((q) => ({
      symbol: String(q.symbol || '').toUpperCase(),
      name: q.longname || q.shortname || q.symbol,
      type: 'stock',
      exchange: q.exchDisp || q.exchange || null,
      quoteType: q.quoteType || q.typeDisp || null,
    }))
    .filter((q) => q.symbol);
}

/**
 * Normalize Yahoo chart result into daily bars + spot meta.
 * `range`: '1mo' | '3mo' | '6mo' | '1y' | '2y' | '5y'
 */
export async function fetchYahooChart(symbol, range = '3mo', { signal } = {}) {
  const sym = encodeURIComponent(String(symbol || '').toUpperCase());
  const path = `/v8/finance/chart/${sym}?interval=1d&range=${encodeURIComponent(range)}`;
  const data = await fetchYahooJson(chartUrls(path), { signal });
  const result = data?.chart?.result?.[0];
  if (!result) {
    const errMsg = data?.chart?.error?.description || 'Symbol not found';
    throw new Error(errMsg);
  }

  const meta = result.meta || {};
  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const closes = quote.close || [];
  const highs = quote.high || [];
  const lows = quote.low || [];
  const opens = quote.open || [];

  const bars = [];
  for (let i = 0; i < timestamps.length; i += 1) {
    const close = closes[i];
    if (!Number.isFinite(close)) continue;
    const t = timestamps[i] * 1000;
    bars.push({
      t,
      date: new Date(t).toISOString().slice(0, 10),
      open: Number.isFinite(opens[i]) ? opens[i] : close,
      high: Number.isFinite(highs[i]) ? highs[i] : close,
      low: Number.isFinite(lows[i]) ? lows[i] : close,
      close,
    });
  }

  const spot =
    Number.isFinite(meta.regularMarketPrice)
      ? meta.regularMarketPrice
      : bars.length
        ? bars[bars.length - 1].close
        : null;

  const prev =
    Number.isFinite(meta.chartPreviousClose)
      ? meta.chartPreviousClose
      : Number.isFinite(meta.previousClose)
        ? meta.previousClose
        : null;

  let change24h = null;
  if (spot != null && prev != null && prev > 0) {
    change24h = ((spot - prev) / prev) * 100;
  }

  return {
    bars,
    spot,
    change24h,
    currency: meta.currency || 'USD',
    shortName: meta.shortName || meta.longName || symbol,
    symbol: meta.symbol || symbol,
  };
}

/** Map lookback days → Yahoo range string. */
export function daysToYahooRange(days) {
  const d = Number(days) || 90;
  if (d <= 35) return '1mo';
  if (d <= 100) return '3mo';
  if (d <= 200) return '6mo';
  if (d <= 400) return '1y';
  if (d <= 800) return '2y';
  return '5y';
}

/** Alias — same mapping as daysToYahooRange. */
export const yahooRangeForLookback = daysToYahooRange;
