/**
 * Dip-buy plan (pure): major support as the limit, holding stop under it, T1 = next resistance.
 * Used by My Bot → Buy dips and by stock_plans (Schwab limit + protective stop).
 * Never touches TSLA. Default dry-run.
 */
import { computeMajorPlan, weeklyAtr } from './majorLevels.js';
import { buildLimitBuyOrder as schwabLimitBuy, roundStop, tickSize } from './schwabLive.js';

export const DIP_EXCLUDES = Object.freeze(new Set(['TSLA']));
export const DIP_CANCEL_DAYS = 10;
/** Stages that count as "uptrend or base" for a long dip (1 Base, 2 Ramp). */
export const DIP_STAGES = Object.freeze(new Set([1, 2]));

const fin = (x) => Number.isFinite(x) && x > 0;
const sma = (closes, n) => {
  if (!closes?.length || closes.length < n) return null;
  const slice = closes.slice(-n);
  return slice.reduce((a, x) => a + x, 0) / slice.length;
};

/** Round a BUY limit in the conservative direction (down to tick). */
export function roundLimit(price) {
  if (!(price > 0)) throw new Error('limit must be > 0');
  const tick = tickSize(price);
  return Number((Math.floor(price / tick + 1e-7) * tick).toFixed(tick >= 0.01 ? 2 : 4));
}

/**
 * Build a dip-buy plan from weekly bars (+ optional daily closes for SMA50).
 * Returns null when the name is excluded or there is no usable major support below.
 */
export function buildDipPlan(symbol, weeklyBars, spot, { stage = null, dailyCloses = null, earningsAt = null, nowMs = Date.now() } = {}) {
  const sym = String(symbol || '').toUpperCase();
  if (!sym || DIP_EXCLUDES.has(sym)) return null;
  if (!(spot > 0) || !weeklyBars?.length) return null;
  if (stage != null && !DIP_STAGES.has(Number(stage))) return null;

  const major = computeMajorPlan(weeklyBars, spot, { now: nowMs });
  if (!major?.supports?.length) return null;
  const s1 = major.supports[0];
  const atrW = major.atrW || weeklyAtr(weeklyBars);
  if (!fin(s1.price) || !fin(atrW)) return null;

  // Buy at/just above major support; if SMA50 is between support and spot, prefer that zone.
  const sma50 = dailyCloses?.length ? sma(dailyCloses, 50) : null;
  let rawLimit = s1.price * 1.005; // a tick above the floor
  let buyZone = 'major_support';
  if (fin(sma50) && sma50 > s1.price && sma50 < spot * 0.995) {
    rawLimit = Math.min(rawLimit * 1.02, sma50); // SMA50 zone, still near the floor
    buyZone = 'sma50';
  }
  if (!(rawLimit < spot)) return null; // already at/below the floor — not a dip
  const limit = roundLimit(rawLimit);
  const stopRaw = s1.price - atrW;
  if (!(stopRaw > 0) || !(stopRaw < limit)) return null;
  const stop = roundStop(stopRaw, 'long');
  const t1 = major.resistances[0]?.price ?? null;
  if (!(t1 > limit)) return null;
  const risk = limit - stop;
  const reward = t1 - limit;
  if (!(risk > 0) || !(reward > 0)) return null;
  const rr = reward / risk;
  const awayPct = (limit / spot - 1) * 100;
  const earnMs = fin(earningsAt) ? Number(earningsAt) : null;
  // Warn when earnings land before a typical 10-trading-day wait for the fill.
  const earnWarn = earnMs != null && earnMs > nowMs && earnMs < nowMs + 14 * 86400000;

  return {
    symbol: sym,
    spot,
    limit,
    stop,
    t1,
    rr: Number(rr.toFixed(2)),
    awayPct: Number(awayPct.toFixed(2)),
    support: s1.price,
    atrW,
    buyZone,
    stage: stage ?? null,
    ladder: major.ladder,
    resistances: major.resistances.map((r) => r.price),
    supports: major.supports.map((s) => s.price),
    earningsAt: earnMs,
    earningsWarn: earnWarn,
    cancelDays: DIP_CANCEL_DAYS,
  };
}

/** Shares for a dollar amount at the limit (whole shares only). */
export function sharesForAmount(usd, limit) {
  if (!(usd > 0) || !(limit > 0)) return 0;
  return Math.floor(usd / limit);
}

/** Dollar risk if the stop fills after the buy. */
export function dollarRisk(shares, limit, stop) {
  if (!(shares > 0) || !(limit > stop)) return null;
  return Number(((limit - stop) * shares).toFixed(2));
}

/** Schwab LIMIT BUY JSON — see shared/schwabLive.js. */
export function buildLimitBuyOrder(args) {
  return schwabLimitBuy(args);
}

/** Next ratchet stop after a weekly (or daily) close above a resistance. Never lowers. */
export function nextRatchetStop(currentStop, close, ladder) {
  if (!(currentStop > 0) || !(close > 0) || !ladder?.length) return null;
  let best = null;
  for (const r of ladder) {
    if (close > r.trigger && r.stop > currentStop && (!best || r.stop > best.stop)) best = r;
  }
  return best ? { stop: roundStop(best.stop, 'long'), trigger: best.trigger } : null;
}

/**
 * Cancel an unfilled entry? N days elapsed, or price already through the planned stop
 * (long: below the stop; short: above the stop). Reads DB rows (stop_price, side) or plan objects.
 */
export function shouldCancelPending(plan, { nowMs = Date.now(), spot = null } = {}) {
  const created = Date.parse(plan.created_at || plan.createdAt || 0);
  const days = plan.cancel_days ?? plan.cancelDays ?? DIP_CANCEL_DAYS;
  const stop = Number(plan.stop ?? plan.stop_price);
  const short = plan.side === 'short';
  if (created && nowMs - created > days * 86400000) return { cancel: true, reason: `unfilled after ${days} days` };
  if (fin(spot) && fin(stop) && !short && spot < stop) return { cancel: true, reason: 'price below stop before fill' };
  if (fin(spot) && fin(stop) && short && spot > stop) return { cancel: true, reason: 'price above stop before fill' };
  return { cancel: false };
}
