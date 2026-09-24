/**
 * Short Kings — short-biased watchlist + Hunt ranking helpers.
 * Data only; no trade recommendations.
 */

import {
  MIN_VOLUME,
  fetchScannerUniverse,
  normalizeScreenerQuote,
  passesLiquidity,
  rowToStockAsset,
} from './scanner.js';
import {
  enrichScannerRows,
  fetchStockFundamentals,
  fundamentalsToScannerFields,
} from './fundamentals.js';
import { fetchYahooChart, fetchYahooFinance } from './yahoo.js';

/** Seeded My Shorts — edit this list to change the default watchlist. */
export const SHORT_KINGS_WATCHLIST = [
  'RUN',
  'CHGG',
  'PLUG',
  'FCEL',
  'DUOL',
  'SNAP',
  'GPRO',
  'RRGB',
];

const WATCHLIST_STORAGE_KEY = 'doge-tracker-short-kings-watchlist-v1';

export { MIN_VOLUME, rowToStockAsset };

/** How many Hunt rows get quoteSummary enrichment. */
export const HUNT_ENRICH_TOP_N = 35;
export const ENRICH_CONCURRENCY = 2;

function num(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function emptyShortRow(symbol, name = null) {
  const sym = String(symbol || '').toUpperCase();
  return {
    symbol: sym,
    name: name || sym,
    price: null,
    changePct: null,
    volume: null,
    avgVolume: null,
    relVolume: null,
    floatShares: null,
    sharesOutstanding: null,
    marketCap: null,
    exchange: null,
    quoteType: 'EQUITY',
    sector: null,
    netCash: null,
    shortPercentOfFloat: null,
    shortRatio: null,
    pctFromHigh: null,
    fundamentalsLoaded: false,
  };
}

export function loadWatchlist() {
  try {
    if (typeof localStorage === 'undefined') {
      return [...SHORT_KINGS_WATCHLIST];
    }
    const raw = localStorage.getItem(WATCHLIST_STORAGE_KEY);
    if (!raw) return [...SHORT_KINGS_WATCHLIST];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.length) {
      return [...SHORT_KINGS_WATCHLIST];
    }
    return [
      ...new Set(
        parsed
          .map((s) => String(s || '').toUpperCase().trim())
          .filter(Boolean),
      ),
    ];
  } catch {
    return [...SHORT_KINGS_WATCHLIST];
  }
}

export function saveWatchlist(symbols) {
  const list = [
    ...new Set(
      (symbols || [])
        .map((s) => String(s || '').toUpperCase().trim())
        .filter(Boolean),
    ),
  ];
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(list));
    }
  } catch {
    /* private mode / quota */
  }
  return list;
}

function cmpDesc(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return b - a;
}

function cmpAsc(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a - b;
}

/**
 * Hunt ranking for short research (data order only — not a score product):
 * 1. Higher short % of float
 * 2. Weaker net cash (more net debt first)
 * 3. Higher relative volume
 * 4. Larger absolute % move
 */
export function sortHunt(a, b) {
  return (
    cmpDesc(a.shortPercentOfFloat, b.shortPercentOfFloat) ||
    cmpAsc(a.netCash, b.netCash) ||
    cmpDesc(a.relVolume, b.relVolume) ||
    cmpDesc(Math.abs(a.changePct ?? 0), Math.abs(b.changePct ?? 0)) ||
    String(a.symbol).localeCompare(String(b.symbol))
  );
}

/**
 * Pre-enrich order when short% / netCash are still empty:
 * RVOL → |% change| → volume, so the concurrency-limited enrich hits active names.
 */
export function sortHuntBootstrap(a, b) {
  return (
    cmpDesc(a.relVolume, b.relVolume) ||
    cmpDesc(Math.abs(a.changePct ?? 0), Math.abs(b.changePct ?? 0)) ||
    cmpDesc(a.avgVolume ?? a.volume, b.avgVolume ?? b.volume) ||
    String(a.symbol).localeCompare(String(b.symbol))
  );
}

export function applyHuntProfile(
  rows,
  { limit = 75, excludeSymbols = [], bootstrap = false } = {},
) {
  const exclude = new Set(
    (excludeSymbols || []).map((s) => String(s).toUpperCase()),
  );
  const filtered = (rows || []).filter((r) => !exclude.has(r.symbol));
  const sorter = bootstrap ? sortHuntBootstrap : sortHunt;
  return [...filtered].sort(sorter).slice(0, limit);
}

function normalizeQuoteEndpoint(q) {
  if (!q || !q.symbol) return null;
  const quoteType = String(q.quoteType || q.typeDisp || '').toUpperCase();
  if (quoteType && quoteType !== 'EQUITY' && quoteType !== 'ETF') return null;
  // Reuse screener normalizer when shape matches
  const fromScreener = normalizeScreenerQuote(q);
  if (fromScreener) return fromScreener;

  const volume = num(q.regularMarketVolume);
  const avg3m = num(q.averageDailyVolume3Month);
  const avg10d = num(q.averageDailyVolume10Day);
  const avgVolume = avg3m ?? avg10d;
  const price = num(q.regularMarketPrice);
  const changePct = num(q.regularMarketChangePercent);
  const relVolume =
    volume != null && avgVolume != null && avgVolume > 0
      ? volume / avgVolume
      : null;

  return {
    ...emptyShortRow(q.symbol, q.longName || q.shortName || q.displayName),
    price,
    changePct,
    volume,
    avgVolume,
    relVolume,
    floatShares: num(q.floatShares),
    sharesOutstanding: num(q.sharesOutstanding),
    marketCap: num(q.marketCap),
    exchange: q.fullExchangeName || q.exchange || null,
  };
}

async function fetchBatchQuotes(symbols, { signal } = {}) {
  const list = [...new Set(symbols.map((s) => String(s).toUpperCase()))];
  if (!list.length) return [];
  const path = `/v7/finance/quote?symbols=${encodeURIComponent(list.join(','))}&formatted=false`;
  const data = await fetchYahooFinance(path, { signal });
  const quotes = data?.quoteResponse?.result;
  if (!Array.isArray(quotes) || !quotes.length) {
    throw new Error('Batch quote returned no results');
  }
  return quotes.map(normalizeQuoteEndpoint).filter(Boolean);
}

async function fetchChartAsRow(symbol, { signal } = {}) {
  const sym = String(symbol).toUpperCase();
  const chart = await fetchYahooChart(sym, '3mo', { signal });
  const bars = chart.bars || [];
  const last = bars.length ? bars[bars.length - 1] : null;
  const volume = last?.volume ?? null;
  // Rough 3mo ADV from daily bars
  const vols = bars.map((b) => b.volume).filter((v) => v != null && v > 0);
  const avgVolume = vols.length
    ? vols.reduce((a, b) => a + b, 0) / vols.length
    : null;
  const relVolume =
    volume != null && avgVolume != null && avgVolume > 0
      ? volume / avgVolume
      : null;
  return {
    ...emptyShortRow(sym, chart.shortName || sym),
    price: chart.spot,
    changePct: chart.change24h,
    volume,
    avgVolume,
    relVolume,
  };
}

async function mapPool(items, concurrency, fn, signal) {
  const out = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      if (signal?.aborted) {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        throw err;
      }
      const i = idx;
      idx += 1;
      out[i] = await fn(items[i], i);
    }
  }
  const n = Math.min(concurrency, Math.max(1, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

/**
 * Load quote rows for My Shorts symbols.
 * Prefers one batch v7 quote; falls back to chart fetches (concurrency 2).
 */
export async function fetchWatchlistRows(
  symbols = SHORT_KINGS_WATCHLIST,
  { signal } = {},
) {
  const list = [
    ...new Set(
      (symbols || [])
        .map((s) => String(s || '').toUpperCase().trim())
        .filter(Boolean),
    ),
  ];
  if (!list.length) {
    return { rows: [], warnings: [], fetchedAt: Date.now() };
  }

  const warnings = [];
  let bySym = new Map(list.map((s) => [s, emptyShortRow(s)]));

  try {
    const batch = await fetchBatchQuotes(list, { signal });
    for (const row of batch) {
      bySym.set(row.symbol, { ...bySym.get(row.symbol), ...row });
    }
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    warnings.push(
      `Batch quote unavailable (${err?.message || 'error'}); using charts.`,
    );
    try {
      const chartRows = await mapPool(
        list,
        ENRICH_CONCURRENCY,
        async (sym) => {
          try {
            return await fetchChartAsRow(sym, { signal });
          } catch (e) {
            if (e?.name === 'AbortError') throw e;
            warnings.push(`${sym}: ${e?.message || 'chart failed'}`);
            return emptyShortRow(sym);
          }
        },
        signal,
      );
      for (const row of chartRows) {
        if (row?.symbol) bySym.set(row.symbol, row);
      }
    } catch (err2) {
      if (err2?.name === 'AbortError') throw err2;
      warnings.push(`Chart fallback failed (${err2?.message || 'error'})`);
    }
  }

  // Preserve watchlist order
  const rows = list.map((s) => bySym.get(s) || emptyShortRow(s));
  return { rows, warnings, fetchedAt: Date.now() };
}

/**
 * Enrich short-kings rows (My Shorts or Hunt) with fundamentals.
 * Reuses enrichScannerRows (session cache, concurrency-limited).
 */
export async function enrichShortRows(rows, opts = {}) {
  return enrichScannerRows(rows, {
    limit: opts.limit ?? rows?.length ?? 0,
    concurrency: opts.concurrency ?? ENRICH_CONCURRENCY,
    signal: opts.signal,
    onProgress: opts.onProgress,
  });
}

/**
 * Fetch liquid scanner universe and apply Hunt bootstrap ranking.
 */
export async function fetchHuntUniverse({
  signal,
  excludeSymbols = SHORT_KINGS_WATCHLIST,
  limit = 75,
} = {}) {
  const universe = await fetchScannerUniverse(undefined, { signal });
  const rows = applyHuntProfile(universe.rows, {
    limit,
    excludeSymbols,
    bootstrap: true,
  });
  return {
    ...universe,
    rows,
    sourceNote:
      universe.sourceNote ||
      `Hunt liquidity floor: ~${MIN_VOLUME.toLocaleString('en-US')}+ ADV when available.`,
  };
}

/**
 * Optional single-symbol quote+fundamentals for add-to-watchlist.
 */
export async function fetchOneShortRow(symbol, { signal } = {}) {
  const sym = String(symbol || '').toUpperCase().trim();
  if (!sym) throw new Error('Missing symbol');
  let row = emptyShortRow(sym);
  try {
    const batch = await fetchBatchQuotes([sym], { signal });
    if (batch[0]) row = { ...row, ...batch[0] };
  } catch {
    try {
      row = { ...row, ...(await fetchChartAsRow(sym, { signal })) };
    } catch {
      /* keep empty */
    }
  }
  const f = await fetchStockFundamentals(sym, { signal });
  return {
    ...row,
    ...fundamentalsToScannerFields(f),
    floatShares: row.floatShares ?? f.floatShares ?? null,
    name: row.name || f.symbol || sym,
    price: row.price ?? f.spot ?? null,
  };
}

export { passesLiquidity };
