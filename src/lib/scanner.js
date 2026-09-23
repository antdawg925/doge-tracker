/** Stock scanner: Yahoo predefined screeners → liquid Momentum / Investable lanes. */

import { fetchYahooFinance } from './yahoo.js';

/** Prefer ~5M+ average daily volume; day volume also accepted when ADV missing. */
export const MIN_VOLUME = 5_000_000;

/** Optional micro-cap illiquidity reject: price < $0.50 and day volume < 10M. */
export const MICRO_PRICE = 0.5;
export const MICRO_MIN_VOLUME = 10_000_000;

const SCREENER_COUNT = 50;

/** Screeners that tend to surface volatile / high-activity names. */
const MOMENTUM_SCREENERS = [
  'day_gainers',
  'day_losers',
  'most_actives',
  'small_cap_gainers',
];

/** Screeners that tend to surface larger / more established liquid names. */
const INVESTABLE_SCREENERS = [
  'most_actives',
  'undervalued_large_caps',
  'growth_technology_stocks',
  'day_gainers',
];

const ALL_SCREENERS = [
  ...new Set([...MOMENTUM_SCREENERS, ...INVESTABLE_SCREENERS]),
];

function num(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalize a Yahoo screener quote into a scanner row.
 * Float is rarely present on free predefined screeners — leave null → UI "—".
 */
export function normalizeScreenerQuote(q) {
  if (!q || !q.symbol) return null;
  const quoteType = String(q.quoteType || q.typeDisp || '').toUpperCase();
  if (quoteType && quoteType !== 'EQUITY') return null;

  const volume = num(q.regularMarketVolume);
  const avg3m = num(q.averageDailyVolume3Month);
  const avg10d = num(q.averageDailyVolume10Day);
  // Prefer 3-month ADV when present; else 10-day.
  const avgVolume = avg3m ?? avg10d;
  const price = num(q.regularMarketPrice);
  const changePct = num(q.regularMarketChangePercent);
  const floatShares = num(q.floatShares);
  const sharesOutstanding = num(q.sharesOutstanding);
  const marketCap = num(q.marketCap);
  const relVolume =
    volume != null && avgVolume != null && avgVolume > 0
      ? volume / avgVolume
      : null;

  return {
    symbol: String(q.symbol).toUpperCase(),
    name: q.longName || q.shortName || q.displayName || q.symbol,
    price,
    changePct,
    volume,
    avgVolume,
    relVolume,
    floatShares: floatShares ?? null,
    sharesOutstanding: sharesOutstanding ?? null,
    marketCap,
    exchange: q.fullExchangeName || q.exchange || null,
    quoteType: quoteType || 'EQUITY',
  };
}

/**
 * Liquidity gate:
 * - Pass if avgVolume ≥ MIN_VOLUME (preferred when present) OR day volume ≥ MIN_VOLUME.
 * - Reject absurdly thin micros: price < $0.50 AND day volume < 10M.
 */
export function passesLiquidity(row) {
  if (!row) return false;
  const vol = row.volume;
  const avg = row.avgVolume;
  const hasAvgOk = avg != null && avg >= MIN_VOLUME;
  const hasDayOk = vol != null && vol >= MIN_VOLUME;
  if (!hasAvgOk && !hasDayOk) return false;

  const price = row.price;
  if (
    price != null &&
    price < MICRO_PRICE &&
    (vol == null || vol < MICRO_MIN_VOLUME)
  ) {
    return false;
  }
  return true;
}

function cmpDesc(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return b - a;
}

function cmpAsc(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return 1; // missing float sorts after known floats
  if (b == null) return -1;
  return a - b;
}

/** Momentum: RVOL desc → |% change| desc → lower float when both known. */
export function sortMomentum(a, b) {
  return (
    cmpDesc(a.relVolume, b.relVolume) ||
    cmpDesc(Math.abs(a.changePct ?? 0), Math.abs(b.changePct ?? 0)) ||
    cmpAsc(a.floatShares, b.floatShares) ||
    String(a.symbol).localeCompare(String(b.symbol))
  );
}

/**
 * Investable: higher market cap → higher price among liquid names;
 * milder |% change| as a soft tiebreaker (less lottery-ticket first).
 */
export function sortInvestable(a, b) {
  return (
    cmpDesc(a.marketCap, b.marketCap) ||
    cmpDesc(a.price, b.price) ||
    cmpAsc(Math.abs(a.changePct ?? 0), Math.abs(b.changePct ?? 0)) ||
    cmpDesc(a.avgVolume ?? a.volume, b.avgVolume ?? b.volume) ||
    String(a.symbol).localeCompare(String(b.symbol))
  );
}

async function fetchPredefinedScreener(scrId, { signal, count = SCREENER_COUNT } = {}) {
  const path = `/v1/finance/screener/predefined/saved?scrIds=${encodeURIComponent(
    scrId,
  )}&count=${count}&formatted=false`;
  const data = await fetchYahooFinance(path, { signal });
  const result = data?.finance?.result?.[0];
  const quotes = Array.isArray(result?.quotes) ? result.quotes : [];
  return quotes;
}

/**
 * Fetch a union of predefined Yahoo screeners, normalize, dedupe by symbol.
 * Soft-fails per screener so one 429 does not blank the whole scan.
 */
export async function fetchScannerUniverse(
  screenerIds = ALL_SCREENERS,
  { signal, count = SCREENER_COUNT } = {},
) {
  const warnings = [];
  const bySymbol = new Map();
  let rateLimited = false;
  let okCount = 0;

  // Sequential to be gentler on Yahoo free endpoints
  for (const scrId of screenerIds) {
    if (signal?.aborted) {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      throw err;
    }
    try {
      const quotes = await fetchPredefinedScreener(scrId, { signal, count });
      okCount += 1;
      for (const q of quotes) {
        const row = normalizeScreenerQuote(q);
        if (!row) continue;
        const prev = bySymbol.get(row.symbol);
        if (!prev) {
          bySymbol.set(row.symbol, row);
        } else {
          // Keep the quote with richer volume / cap fields if a later screener overlaps
          bySymbol.set(row.symbol, {
            ...prev,
            ...Object.fromEntries(
              Object.entries(row).filter(([, v]) => v != null && v !== ''),
            ),
            // Recompute RVOL after merge
            relVolume: null,
          });
          const merged = bySymbol.get(row.symbol);
          merged.relVolume =
            merged.volume != null &&
            merged.avgVolume != null &&
            merged.avgVolume > 0
              ? merged.volume / merged.avgVolume
              : null;
        }
      }
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      if (err?.rateLimited || /429/.test(err?.message || '')) {
        rateLimited = true;
        warnings.push(`Yahoo rate-limited on screener "${scrId}"`);
      } else {
        warnings.push(
          `Screener "${scrId}" failed (${err?.message || 'error'})`,
        );
      }
    }
  }

  const rows = [...bySymbol.values()].filter(passesLiquidity);

  if (!rows.length && okCount === 0) {
    const err = new Error(
      rateLimited
        ? 'Yahoo rate-limited all scanner requests. Wait a minute and refresh.'
        : 'Could not load any Yahoo screeners.',
    );
    err.rateLimited = rateLimited;
    err.warnings = warnings;
    throw err;
  }

  if (!rows.length) {
    warnings.push(
      `No names passed the ${MIN_VOLUME.toLocaleString('en-US')}+ volume floor.`,
    );
  }

  return {
    rows,
    warnings,
    rateLimited,
    fetchedAt: Date.now(),
    sourceNote:
      'Liquidity gate: averageDailyVolume3Month (preferred) or regularMarketVolume ≥ 5,000,000.',
  };
}

export function applyMomentumProfile(rows, { limit = 75 } = {}) {
  return [...(rows || [])].sort(sortMomentum).slice(0, limit);
}

export function applyInvestableProfile(rows, { limit = 75 } = {}) {
  return [...(rows || [])].sort(sortInvestable).slice(0, limit);
}

/** Convenience: fetch + Momentum sort. */
export async function fetchMomentumScan(opts = {}) {
  const universe = await fetchScannerUniverse(MOMENTUM_SCREENERS, opts);
  return {
    ...universe,
    rows: applyMomentumProfile(universe.rows, { limit: opts.limit }),
    profile: 'momentum',
  };
}

/** Convenience: fetch + Investable sort. */
export async function fetchInvestableScan(opts = {}) {
  const universe = await fetchScannerUniverse(INVESTABLE_SCREENERS, opts);
  return {
    ...universe,
    rows: applyInvestableProfile(universe.rows, { limit: opts.limit }),
    profile: 'investable',
  };
}

/** Asset shape Desk expects when opening a scanner row. */
export function rowToStockAsset(row) {
  return {
    type: 'stock',
    symbol: String(row.symbol || '').toUpperCase(),
    name: row.name || row.symbol,
  };
}
