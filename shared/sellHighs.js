/**
 * "Sell highs" short plan (pure): weak name (Weinstein stage 3–4, below SMA50, downtrend) bouncing up
 * into a major resistance. Short limit at/just below the resistance, buy-to-cover stop one weekly
 * ATR above it, cover target = next major support. Stop ratchets DOWN only.
 * Never TSLA. Default dry-run. Used by Scanner "Sell highs" (?mode=sell-highs) and stock_plans side='short'.
 */
import { computeMajorPlan, weeklyAtr } from './majorLevels.js';
import { buildShortLimitOrder as schwabShortLimit, roundStop, tickSize } from './schwabLive.js';
import { DIP_CANCEL_DAYS, DIP_EXCLUDES } from './dipBuys.js';

export const SHORT_EXCLUDES = DIP_EXCLUDES;
export const SHORT_CANCEL_DAYS = DIP_CANCEL_DAYS;
export const SHORT_RISK_USD = 100; // Anthony's rule: $100 risk per short
/** Squeeze risk: short % of float AND days to cover both high. */
export const SQUEEZE = Object.freeze({ siPct: 15, dtc: 5, siPctHigh: 25 });

const fin = (x) => Number.isFinite(x) && x > 0;
const sma = (xs, n, endOffset = 0) => {
  if (!xs?.length || xs.length < n + endOffset) return null;
  const end = xs.length - endOffset;
  const s = xs.slice(end - n, end);
  return s.reduce((a, x) => a + x, 0) / s.length;
};

/** Short limit rounds DOWN to a tick (at or just below the resistance). */
export function roundShortLimit(price) {
  if (!(price > 0)) throw new Error('limit must be > 0');
  const tick = tickSize(price);
  return Number((Math.floor(price / tick + 1e-7) * tick).toFixed(tick >= 0.01 ? 2 : 4));
}

/**
 * Weinstein stage from weekly closes vs the 30-week MA and its 5-week slope.
 * 1 base (flat MA, price around it) · 2 advance · 3 top (flat MA after advance, price at/below) · 4 decline.
 */
export function weinsteinStage(weeklyCloses) {
  const c = (weeklyCloses || []).filter(fin);
  if (c.length < 36) return null;
  const ma = sma(c, 30);
  const maPrev = sma(c, 30, 5);
  const maOld = sma(c, 30, 20);
  if (!fin(ma) || !fin(maPrev)) return null;
  const slope = (ma / maPrev - 1) * 100;
  const px = c.at(-1);
  const flat = Math.abs(slope) < 1;
  if (slope <= -1 && px < ma) return 4;
  if (flat && px <= ma * 1.02 && fin(maOld) && ma > maOld) return 3; // rolled over after an advance
  if (slope >= 1 && px > ma) return 2;
  if (flat && fin(maOld) && ma < maOld) return px < ma ? 4 : 1;
  return px < ma ? 3 : 1;
}

/** Downtrend on daily closes: below SMA50, and SMA50 under SMA200 or falling over 10 days. */
export function dailyDowntrend(dailyCloses) {
  const c = (dailyCloses || []).filter(fin);
  const s50 = sma(c, 50);
  if (!fin(s50)) return { ok: false, sma50: null, sma200: null };
  const s50Prev = sma(c, 50, 10);
  const s200 = sma(c, 200);
  const px = c.at(-1);
  const falling = fin(s50Prev) && s50 < s50Prev;
  const under200 = fin(s200) && s50 < s200;
  return { ok: px < s50 && (falling || under200), belowSma50: px < s50, sma50: s50, sma200: s200, falling, under200 };
}

/** Bouncing: last close at least 3% off the 10-day low, or a positive 5-day change. */
export function isBouncing(dailyCloses) {
  const c = (dailyCloses || []).filter(fin);
  if (c.length < 11) return false;
  const px = c.at(-1);
  const lo10 = Math.min(...c.slice(-10));
  return px >= lo10 * 1.03 || px > c.at(-6);
}

/** Squeeze flag from short % of float (percent, 0–100) and days to cover. */
export function squeezeRisk(siPct, dtc) {
  const si = siPct == null || !Number.isFinite(Number(siPct)) ? null : Number(siPct);
  if (si == null && dtc == null) return { flag: false, level: null, siPct: null, dtc: null };
  const high = si != null && dtc != null && si >= SQUEEZE.siPct && dtc >= SQUEEZE.dtc;
  const extreme = si != null && si >= SQUEEZE.siPctHigh && (dtc ?? 0) >= SQUEEZE.dtc;
  return { flag: high || extreme, level: extreme ? 'extreme' : high ? 'high' : null, siPct: si, dtc: dtc ?? null };
}

/** Down ladder: on a daily close below each support rung, stop → rung + 1 weekly ATR. */
export function shortLadder(supports, atrW, initialStop) {
  const out = [];
  let prev = initialStop;
  for (const s of [...(supports || [])].filter(fin).sort((a, b) => b - a)) {
    const y = s + atrW;
    if (!(y < prev)) continue;
    out.push({ trigger: s, stop: y });
    prev = y;
  }
  return out;
}

/**
 * Build a Sell highs short plan. weeklyBars multi-year weekly OHLC; dailyCloses ≥ 50 for SMA50.
 * Returns null when excluded, not weak, or no usable resistance above / support below.
 */
export function buildShortPlan(symbol, weeklyBars, spot, { dailyCloses = null, siPct = null, dtc = null, earningsAt = null, borrow = null, requireWeak = true, nowMs = Date.now() } = {}) {
  const sym = String(symbol || '').toUpperCase();
  if (!sym || SHORT_EXCLUDES.has(sym)) return null;
  if (!(spot > 0) || !weeklyBars?.length) return null;
  const wStage = weinsteinStage(weeklyBars.map((b) => b.close));
  const trend = dailyDowntrend(dailyCloses);
  if (requireWeak && !((wStage === 3 || wStage === 4) && trend.ok)) return null;

  const major = computeMajorPlan(weeklyBars, spot, { now: nowMs });
  if (!major?.resistances?.length || !major?.supports?.length) return null;
  const r1 = major.resistances[0].price;
  const s1 = major.supports[0].price;
  const atrW = major.atrW || weeklyAtr(weeklyBars);
  if (!fin(r1) || !fin(s1) || !fin(atrW)) return null;

  const limit = roundShortLimit(r1 * 0.995); // just below resistance
  if (!(limit > spot)) return null; // already at/through resistance — not a bounce entry
  const stop = roundStop(r1 + atrW, 'short');
  if (!(stop > limit)) return null;
  const target = s1;
  const risk = stop - limit;
  const reward = limit - target;
  if (!(risk > 0) || !(reward > 0)) return null;
  const earnMs = fin(earningsAt) ? Number(earningsAt) : null;
  const sq = squeezeRisk(siPct, dtc);
  return {
    symbol: sym,
    side: 'short',
    spot,
    limit,
    stop,
    t1: target,
    rr: Number((reward / risk).toFixed(2)),
    awayPct: Number(((limit / spot - 1) * 100).toFixed(2)),
    resistance: r1,
    atrW,
    stage: wStage,
    trend,
    ladder: shortLadder(major.supports.map((s) => s.price), atrW, stop),
    resistances: major.resistances.map((r) => r.price),
    supports: major.supports.map((s) => s.price),
    siPct: sq.siPct,
    dtc: sq.dtc,
    squeeze: sq,
    borrow: borrow || null,
    earningsAt: earnMs,
    earningsWarn: earnMs != null && earnMs > nowMs && earnMs < nowMs + 14 * 86400000,
    cancelDays: SHORT_CANCEL_DAYS,
  };
}

/** Shares so the stop loses about `riskUsd` (default $100). Whole shares. */
export function sharesForRisk(riskUsd, limit, stop) {
  const per = Math.abs(stop - limit);
  if (!(riskUsd > 0) || !(per > 0)) return 0;
  return Math.floor(riskUsd / per + 1e-9);
}

/** Dollar risk on a short if the buy-to-cover stop fills. */
export function shortDollarRisk(shares, limit, stop) {
  if (!(shares > 0) || !(stop > limit)) return null;
  return Number(((stop - limit) * shares).toFixed(2));
}

/** Schwab LIMIT SELL_SHORT JSON (see shared/schwabLive.js). */
export function buildShortLimitOrder(args) {
  return schwabShortLimit(args);
}

/** Next ratchet for a short: daily close below a support rung lowers the stop. Never raises. */
export function nextShortRatchetStop(currentStop, close, ladder) {
  if (!(currentStop > 0) || !(close > 0) || !ladder?.length) return null;
  let best = null;
  for (const r of ladder) {
    if (close < r.trigger && r.stop < currentStop && (!best || r.stop < best.stop)) best = r;
  }
  return best ? { stop: roundStop(best.stop, 'short'), trigger: best.trigger } : null;
}
