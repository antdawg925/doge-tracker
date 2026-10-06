/**
 * Client: build Buy dips rows from the Momentum + Investable universe using major levels.
 */
import { applyInvestableProfile, applyMomentumProfile, fetchScannerUniverse } from './scanner.js';
import { fetchYahooChart } from './yahoo.js';
import { scoreMarketStage } from './marketStage.js';
import { buildDipPlan, DIP_EXCLUDES } from '../../shared/dipBuys.js';
import { fetchStockFundamentals } from './fundamentals.js';
import { toPeriod } from './majorLevels.js';

const ENRICH_N = 28;
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

/** Fetch weekly + daily bars, score stage, build a dip plan. */
export async function enrichDipRow(row, { signal } = {}) {
  const sym = String(row.symbol || '').toUpperCase();
  if (!sym || DIP_EXCLUDES.has(sym)) return null;
  try {
    const [{ bars: weekly }, { bars: daily }] = await Promise.all([
      fetchYahooChart(sym, '5y', { signal, interval: '1wk' }),
      fetchYahooChart(sym, '1y', { signal, interval: '1d' }),
    ]);
    const wk = weekly?.length >= 20 ? weekly : toPeriod(daily, 'week');
    const stage = scoreMarketStage(daily, { assetType: 'stock' });
    if (!stage.ok || ![1, 2].includes(stage.stage)) return null;
    const spot = row.price ?? daily?.at?.(-1)?.close;
    const fund = await fetchStockFundamentals(sym, { signal }).catch(() => null);
    const earnRaw = fund?.nextEarningsRaw;
    const earningsAt = Number.isFinite(earnRaw) ? (earnRaw < 1e12 ? earnRaw * 1000 : earnRaw) : row.earningsAt ?? null;
    const plan = buildDipPlan(sym, wk, spot, {
      stage: stage.stage,
      dailyCloses: (daily || []).map((b) => b.close).filter((c) => Number.isFinite(c)),
      earningsAt,
    });
    if (!plan) return null;
    // Liquid swing names only: ≥ $10, dip of at least 0.5% and at most 25% away.
    if (!(spot >= 10)) return null;
    if (!(plan.awayPct <= -0.5 && plan.awayPct >= -25)) return null;
    if (!(plan.rr >= 1.2)) return null;
    return {
      ...row,
      symbol: sym,
      name: row.name || sym,
      price: spot,
      stage: stage.stage,
      stageLabel: stage.label,
      buy: plan.limit,
      stop: plan.stop,
      t1: plan.t1,
      rr: plan.rr,
      awayPct: plan.awayPct,
      support: plan.support,
      atrW: plan.atrW,
      buyZone: plan.buyZone,
      ladder: plan.ladder,
      earningsAt: plan.earningsAt,
      earningsWarn: plan.earningsWarn,
      plan,
    };
  } catch {
    return null;
  }
}

/** Universe → dip candidates, sorted by closeness then R:R. */
export async function fetchDipBuys({ signal, onProgress } = {}) {
  const universe = await fetchScannerUniverse(undefined, { signal });
  const poolRows = [
    ...applyMomentumProfile(universe.rows, { limit: 60 }),
    ...applyInvestableProfile(universe.rows, { limit: 60 }),
  ];
  const by = new Map();
  for (const r of poolRows) {
    const s = String(r.symbol || '').toUpperCase();
    if (!s || DIP_EXCLUDES.has(s) || by.has(s)) continue;
    by.set(s, r);
  }
  const candidates = [...by.values()].slice(0, ENRICH_N);
  let done = 0;
  const enriched = await pool(candidates, CONCURRENCY, async (row) => {
    const r = await enrichDipRow(row, { signal });
    done += 1;
    onProgress?.(done, candidates.length);
    return r;
  });
  const rows = enriched.filter(Boolean).sort((a, b) => {
    // Prefer closer dips, then better R:R, then larger caps
    const away = Math.abs(a.awayPct) - Math.abs(b.awayPct);
    if (Math.abs(away) > 0.15) return away;
    if (Math.abs(b.rr - a.rr) > 0.15) return b.rr - a.rr;
    return (b.marketCap || 0) - (a.marketCap || 0);
  });
  return { rows, warnings: universe.warnings, updatedAt: Date.now() };
}
