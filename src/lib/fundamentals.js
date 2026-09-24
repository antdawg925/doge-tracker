/**
 * Stock fundamentals via Yahoo quoteSummary (v10), normalized for Desk / Scanner.
 * Soft-fails with nulls + warning — never throws for expected Yahoo gaps / 429.
 */

import { fetchYahooFinance } from './yahoo.js';

export const FUNDAMENTALS_MODULES = [
  'assetProfile',
  'summaryProfile',
  'summaryDetail',
  'defaultKeyStatistics',
  'financialData',
  'price',
  'calendarEvents',
].join(',');

const CACHE_TTL_MS = 20 * 60 * 1000; // 20 min
const memoryCache = new Map(); // symbol -> { at, data }
const STORAGE_KEY = 'doge-tracker-fundamentals-v1';

function now() {
  return Date.now();
}

function readSessionCache(symbol) {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const all = JSON.parse(raw);
    const entry = all?.[symbol];
    if (!entry || now() - entry.at > CACHE_TTL_MS) return null;
    return entry.data;
  } catch {
    return null;
  }
}

function writeSessionCache(symbol, data) {
  try {
    if (typeof sessionStorage === 'undefined') return;
    let all = {};
    try {
      all = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '{}') || {};
    } catch {
      all = {};
    }
    all[symbol] = { at: now(), data };
    // Bound size: keep ~80 freshest
    const keys = Object.keys(all);
    if (keys.length > 80) {
      keys
        .map((k) => ({ k, at: all[k]?.at || 0 }))
        .sort((a, b) => a.at - b.at)
        .slice(0, keys.length - 80)
        .forEach(({ k }) => delete all[k]);
    }
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* quota / private mode */
  }
}

export function getCachedFundamentals(symbol) {
  const sym = String(symbol || '').toUpperCase();
  if (!sym) return null;
  const mem = memoryCache.get(sym);
  if (mem && now() - mem.at <= CACHE_TTL_MS) return mem.data;
  const sess = readSessionCache(sym);
  if (sess) {
    memoryCache.set(sym, { at: now(), data: sess });
    return sess;
  }
  return null;
}

function putCache(symbol, data) {
  const sym = String(symbol || '').toUpperCase();
  memoryCache.set(sym, { at: now(), data });
  writeSessionCache(sym, data);
}

/** Prefer Yahoo `.raw` number; fall back to bare number. */
export function rawNum(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'object' && v.raw != null) {
    const n = Number(v.raw);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function strField(...candidates) {
  for (const c of candidates) {
    if (c == null) continue;
    const s = String(c).trim();
    if (s) return s;
  }
  return null;
}

/**
 * Compact USD for caps / cash / debt: $12.4M, $1.2B, …
 */
export function formatCompactUsd(n) {
  if (n == null || Number.isNaN(n)) return '—';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

/** Net cash positive → `$12.4M`; net debt → `−$8.1M` (or `($8.1M)`). */
export function formatNetCash(net) {
  if (net == null || Number.isNaN(net)) return '—';
  if (net < 0) return `(${formatCompactUsd(Math.abs(net))})`;
  return formatCompactUsd(net);
}

/** Ratio like 0.096 → `9.6%`; already-percent numbers not expected from Yahoo raw. */
export function formatRatioPct(n, decimals = 1) {
  if (n == null || Number.isNaN(n)) return '—';
  return `${(n * 100).toFixed(decimals)}%`;
}

export function formatMultiple(n, decimals = 1) {
  if (n == null || Number.isNaN(n)) return '—';
  return n.toFixed(decimals);
}

export function formatShares(n) {
  if (n == null || Number.isNaN(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(abs / 1e3).toFixed(1)}K`;
  return String(Math.round(abs));
}

export function formatEarningsDate(rawSec, fmt) {
  if (fmt && typeof fmt === 'string') return fmt;
  if (rawSec == null || !Number.isFinite(Number(rawSec))) return null;
  try {
    return new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'America/New_York',
    }).format(new Date(Number(rawSec) * 1000));
  } catch {
    return null;
  }
}

function emptyFundamentals(symbol, warning = null) {
  return {
    symbol: String(symbol || '').toUpperCase() || null,
    sector: null,
    industry: null,
    exchange: null,
    quoteType: null,
    country: null,
    marketCap: null,
    sharesOutstanding: null,
    floatShares: null,
    averageVolume: null,
    totalCash: null,
    totalDebt: null,
    netCash: null,
    shortPercentOfFloat: null,
    shortRatio: null,
    trailingPE: null,
    forwardPE: null,
    priceToSales: null,
    enterpriseToRevenue: null,
    enterpriseToEbitda: null,
    revenueGrowth: null,
    earningsGrowth: null,
    profitMargins: null,
    operatingMargins: null,
    returnOnEquity: null,
    totalRevenue: null,
    ebitda: null,
    heldPercentInsiders: null,
    heldPercentInstitutions: null,
    beta: null,
    dividendYield: null,
    fiftyTwoWeekHigh: null,
    fiftyTwoWeekLow: null,
    pctFromHigh: null,
    pctFromLow: null,
    nextEarningsDate: null,
    nextEarningsRaw: null,
    spot: null,
    warning,
    fetchedAt: now(),
  };
}

/**
 * Normalize a quoteSummary result[0] object into a flat fundamentals record.
 */
export function normalizeQuoteSummary(result, symbol) {
  const out = emptyFundamentals(symbol);
  if (!result || typeof result !== 'object') {
    out.warning = 'No fundamentals modules returned';
    return out;
  }

  const profile = result.assetProfile || result.summaryProfile || {};
  const detail = result.summaryDetail || {};
  const stats = result.defaultKeyStatistics || {};
  const fin = result.financialData || {};
  const price = result.price || {};
  const cal = result.calendarEvents || {};

  out.sector = strField(profile.sectorDisp, profile.sector);
  out.industry = strField(profile.industryDisp, profile.industry);
  out.country = strField(profile.country);
  out.exchange = strField(price.exchangeName, price.fullExchangeName, price.exchange);
  out.quoteType = strField(price.quoteType);
  out.symbol = strField(price.symbol, symbol)?.toUpperCase() || out.symbol;

  out.marketCap =
    rawNum(price.marketCap) ?? rawNum(detail.marketCap) ?? null;
  out.sharesOutstanding = rawNum(stats.sharesOutstanding);
  out.floatShares = rawNum(stats.floatShares);
  out.averageVolume =
    rawNum(detail.averageVolume) ??
    rawNum(price.averageDailyVolume3Month) ??
    null;

  out.totalCash = rawNum(fin.totalCash);
  out.totalDebt = rawNum(fin.totalDebt);
  if (out.totalCash != null || out.totalDebt != null) {
    out.netCash = (out.totalCash ?? 0) - (out.totalDebt ?? 0);
  }

  out.shortPercentOfFloat = rawNum(stats.shortPercentOfFloat);
  out.shortRatio = rawNum(stats.shortRatio);

  out.trailingPE = rawNum(detail.trailingPE) ?? rawNum(stats.trailingPE);
  out.forwardPE = rawNum(detail.forwardPE) ?? rawNum(stats.forwardPE);
  out.priceToSales =
    rawNum(detail.priceToSalesTrailing12Months) ??
    rawNum(stats.priceToSalesTrailing12Months);
  out.enterpriseToRevenue = rawNum(stats.enterpriseToRevenue);
  out.enterpriseToEbitda = rawNum(stats.enterpriseToEbitda);

  out.revenueGrowth = rawNum(fin.revenueGrowth);
  out.earningsGrowth = rawNum(fin.earningsGrowth);
  out.profitMargins =
    rawNum(fin.profitMargins) ?? rawNum(stats.profitMargins);
  out.operatingMargins = rawNum(fin.operatingMargins);
  out.returnOnEquity = rawNum(fin.returnOnEquity);
  out.totalRevenue = rawNum(fin.totalRevenue);
  out.ebitda = rawNum(fin.ebitda);

  out.heldPercentInsiders = rawNum(stats.heldPercentInsiders);
  out.heldPercentInstitutions = rawNum(stats.heldPercentInstitutions);

  out.beta = rawNum(detail.beta) ?? rawNum(stats.beta);
  out.dividendYield = rawNum(detail.dividendYield);
  out.fiftyTwoWeekHigh = rawNum(detail.fiftyTwoWeekHigh);
  out.fiftyTwoWeekLow = rawNum(detail.fiftyTwoWeekLow);
  out.spot = rawNum(price.regularMarketPrice) ?? rawNum(fin.currentPrice);

  if (out.spot != null && out.fiftyTwoWeekHigh != null && out.fiftyTwoWeekHigh > 0) {
    out.pctFromHigh = (out.spot - out.fiftyTwoWeekHigh) / out.fiftyTwoWeekHigh;
  }
  if (out.spot != null && out.fiftyTwoWeekLow != null && out.fiftyTwoWeekLow > 0) {
    out.pctFromLow = (out.spot - out.fiftyTwoWeekLow) / out.fiftyTwoWeekLow;
  }

  const earnings = cal.earnings || {};
  const dates = Array.isArray(earnings.earningsDate)
    ? earnings.earningsDate
    : [];
  const first = dates[0];
  if (first) {
    out.nextEarningsRaw = rawNum(first);
    out.nextEarningsDate =
      formatEarningsDate(out.nextEarningsRaw, first.fmt) || first.fmt || null;
  }

  return out;
}

/**
 * Fetch + normalize fundamentals for one stock symbol.
 * Returns a fundamentals object (null fields on failure) — does not throw
 * except AbortError.
 */
export async function fetchStockFundamentals(symbol, { signal, bypassCache = false } = {}) {
  const sym = String(symbol || '').toUpperCase().trim();
  if (!sym) return emptyFundamentals('', 'Missing symbol');

  if (!bypassCache) {
    const cached = getCachedFundamentals(sym);
    if (cached) return { ...cached, fromCache: true };
  }

  const path = `/v10/finance/quoteSummary/${encodeURIComponent(
    sym,
  )}?modules=${encodeURIComponent(FUNDAMENTALS_MODULES)}`;

  try {
    const data = await fetchYahooFinance(path, { signal });
    const err =
      data?.quoteSummary?.error ||
      data?.finance?.error ||
      null;
    const result = data?.quoteSummary?.result?.[0];
    if (!result) {
      const msg =
        err?.description ||
        err?.code ||
        'Fundamentals unavailable';
      const soft = emptyFundamentals(sym, msg);
      // Don't cache hard empties from rate limits too long — skip session write
      if (!/429|rate/i.test(msg)) putCache(sym, soft);
      return soft;
    }
    const normalized = normalizeQuoteSummary(result, sym);
    putCache(sym, normalized);
    return normalized;
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    const msg = err?.rateLimited
      ? 'Yahoo rate-limited fundamentals'
      : err?.message || 'Fundamentals fetch failed';
    return emptyFundamentals(sym, msg);
  }
}

/**
 * Compact fields for Scanner table enrichment.
 */
export function fundamentalsToScannerFields(f) {
  if (!f) {
    return {
      sector: null,
      netCash: null,
      shortPercentOfFloat: null,
      floatShares: null,
      shortRatio: null,
      pctFromHigh: null,
      pctFromLow: null,
      fiftyTwoWeekHigh: null,
      fiftyTwoWeekLow: null,
      fundamentalsLoaded: false,
    };
  }
  return {
    sector: f.sector ?? null,
    netCash: f.netCash ?? null,
    shortPercentOfFloat: f.shortPercentOfFloat ?? null,
    floatShares: f.floatShares ?? null,
    shortRatio: f.shortRatio ?? null,
    pctFromHigh: f.pctFromHigh ?? null,
    pctFromLow: f.pctFromLow ?? null,
    fiftyTwoWeekHigh: f.fiftyTwoWeekHigh ?? null,
    fiftyTwoWeekLow: f.fiftyTwoWeekLow ?? null,
    fundamentalsLoaded: true,
  };
}

/**
 * Enrich scanner rows with sector / netCash / short% using limited concurrency.
 * Mutates nothing — returns new rows array. Fills cache as it goes.
 * Calls onProgress(updatedRows) optionally as batches complete.
 */
export async function enrichScannerRows(
  rows,
  {
    signal,
    limit = 35,
    concurrency = 2,
    onProgress,
  } = {},
) {
  const list = Array.isArray(rows) ? rows : [];
  const target = list.slice(0, Math.max(0, limit));
  const bySym = new Map(list.map((r) => [r.symbol, { ...r }]));

  // Seed from cache immediately
  for (const row of target) {
    const cached = getCachedFundamentals(row.symbol);
    if (cached) {
      const prev = bySym.get(row.symbol) || { ...row };
      bySym.set(row.symbol, {
        ...prev,
        ...fundamentalsToScannerFields(cached),
        // Prefer existing float from screener when present
        floatShares: prev.floatShares ?? cached.floatShares ?? null,
      });
    }
  }
  let snapshot = list.map((r) => bySym.get(r.symbol) || r);
  onProgress?.(snapshot);

  const pending = target.filter((r) => !getCachedFundamentals(r.symbol));
  let idx = 0;

  async function worker() {
    while (idx < pending.length) {
      if (signal?.aborted) {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        throw err;
      }
      const i = idx;
      idx += 1;
      const row = pending[i];
      const f = await fetchStockFundamentals(row.symbol, { signal });
      const prev = bySym.get(row.symbol) || { ...row };
      bySym.set(row.symbol, {
        ...prev,
        ...fundamentalsToScannerFields(f),
        floatShares: prev.floatShares ?? f.floatShares ?? null,
      });
      snapshot = list.map((r) => bySym.get(r.symbol) || r);
      onProgress?.(snapshot);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(1, pending.length)) },
    () => worker(),
  );
  try {
    await Promise.all(workers);
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
  }

  return list.map((r) => bySym.get(r.symbol) || r);
}
