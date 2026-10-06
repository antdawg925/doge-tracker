/**
 * Client: "Sell highs" short candidates — weak names (Weinstein stage 3–4, below SMA50, downtrend)
 * bouncing up toward a major resistance. Short % of float / days to cover from Yahoo; borrow
 * (ETB/HTB, rate, shortable) only from Schwab quotes?fields=reference when the user is connected.
 */
import { fetchScannerUniverse } from './scanner.js';
import { fetchYahooChart } from './yahoo.js';
import { fetchStockFundamentals } from './fundamentals.js';
import { toPeriod } from './majorLevels.js';
import { authedFetch } from './api.js';
import { buildShortPlan, isBouncing, SHORT_EXCLUDES } from '../../shared/sellHighs.js';

const SCREENERS = ['day_losers', 'most_actives', 'most_shorted_stocks', 'undervalued_large_caps', 'growth_technology_stocks', 'day_gainers'];
const ENRICH_N = 32;
const CONCURRENCY = 3;

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k], k);
      }
    }),
  );
  return out;
}

/** Weekly + daily bars → weak/bouncing filter → short plan with SI, DTC and earnings. */
export async function enrichSellHighRow(row, { signal } = {}) {
  const sym = String(row.symbol || '').toUpperCase();
  if (!sym || SHORT_EXCLUDES.has(sym)) return null;
  try {
    const [{ bars: weekly }, { bars: daily }] = await Promise.all([
      fetchYahooChart(sym, '5y', { signal, interval: '1wk' }),
      fetchYahooChart(sym, '1y', { signal, interval: '1d' }),
    ]);
    const wk = weekly?.length >= 36 ? weekly : toPeriod(daily, 'week');
    const closes = (daily || []).map((b) => b.close).filter((c) => Number.isFinite(c));
    const spot = row.price ?? closes.at(-1);
    if (!(spot >= 10)) return null;
    if (!isBouncing(closes)) return null;
    const pre = buildShortPlan(sym, wk, spot, { dailyCloses: closes });
    if (!pre) return null;
    if (!(pre.awayPct >= 0.5 && pre.awayPct <= 15)) return null;
    if (!(pre.rr >= 1.2)) return null;
    const fund = await fetchStockFundamentals(sym, { signal }).catch(() => null);
    const earnRaw = fund?.nextEarningsRaw;
    const earningsAt = Number.isFinite(earnRaw) ? (earnRaw < 1e12 ? earnRaw * 1000 : earnRaw) : null;
    const siRaw = fund?.shortPercentOfFloat ?? row.shortPercentOfFloat;
    const siPct = Number.isFinite(siRaw) ? siRaw * 100 : null; // Yahoo returns a fraction
    const dtc = Number.isFinite(fund?.shortRatio) ? fund.shortRatio : null;
    const plan = buildShortPlan(sym, wk, spot, { dailyCloses: closes, siPct, dtc, earningsAt });
    if (!plan) return null;
    return {
      ...row,
      symbol: sym,
      name: row.name || sym,
      price: spot,
      stage: plan.stage,
      entry: plan.limit,
      stop: plan.stop,
      cover: plan.t1,
      rr: plan.rr,
      awayPct: plan.awayPct,
      resistance: plan.resistance,
      atrW: plan.atrW,
      ladder: plan.ladder,
      siPct: plan.siPct,
      dtc: plan.dtc,
      squeeze: plan.squeeze,
      earningsAt: plan.earningsAt,
      earningsWarn: plan.earningsWarn,
      borrow: null,
      plan,
    };
  } catch {
    return null;
  }
}

/** Schwab borrow fields for symbols (caller's own Schwab login). { available, reason, rows }. */
export async function fetchSchwabBorrow(symbols) {
  if (!symbols.length) return { available: false, rows: {} };
  try {
    return await authedFetch('/api/schwab/borrow', { method: 'POST', body: { symbols } });
  } catch (e) {
    return { available: false, reason: e.message, rows: {} };
  }
}

/** Universe → Sell highs candidates, closest to resistance first, then R:R. */
export async function fetchSellHighs({ signal, onProgress } = {}) {
  const universe = await fetchScannerUniverse(SCREENERS, { signal });
  const pre = universe.rows
    .filter((r) => !SHORT_EXCLUDES.has(String(r.symbol || '').toUpperCase()))
    .filter((r) => r.price == null || r.price >= 10)
    // Weak first: below the 50-day average when the screener gives it.
    .filter((r) => r.fiftyDayAverage == null || r.price == null || r.price < r.fiftyDayAverage * 1.02)
    .sort((a, b) => {
      const wa = a.fiftyDayAverage && a.price ? a.price / a.fiftyDayAverage : 1;
      const wb = b.fiftyDayAverage && b.price ? b.price / b.fiftyDayAverage : 1;
      return wa - wb || (b.marketCap || 0) - (a.marketCap || 0);
    });
  const candidates = pre.slice(0, ENRICH_N);
  let done = 0;
  const enriched = await pool(candidates, CONCURRENCY, async (row) => {
    const r = await enrichSellHighRow(row, { signal });
    done += 1;
    onProgress?.(done, candidates.length);
    return r;
  });
  const rows = enriched.filter(Boolean).sort((a, b) => {
    const away = a.awayPct - b.awayPct;
    if (Math.abs(away) > 0.25) return away;
    return b.rr - a.rr;
  });
  const borrow = await fetchSchwabBorrow(rows.map((r) => r.symbol));
  for (const r of rows) r.borrow = borrow.rows?.[r.symbol] ?? null;
  return { rows, warnings: universe.warnings, updatedAt: Date.now(), borrowAvailable: Boolean(borrow.available), borrowReason: borrow.reason || null };
}
