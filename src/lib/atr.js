/**
 * ATR + ratcheting trailing-stop math (pure — no DOM, no fetch, no storage).
 *
 * Bars: `{ t (ms), open, high, low, close }`, sorted oldest → newest.
 *
 * Method (DOGE plan):
 *   - True range  = max(high − low, |high − prevClose|, |low − prevClose|)
 *   - ATR(14)     = Wilder smoothing, i.e. EWM with alpha = 1/14
 *                   (recursive form: atr = prev + (tr − prev) / 14, seeded with the first TR)
 *   - Trail       = highest high since anchor − mult × ATR
 *                   mult = atrMult (2.5) normally, tightMult (1.75) once price is
 *                   more than tightenPct (15%) above the tighten reference (avg cost)
 *   - Effective   = max(manual floor, ATR trail, previous effective) — never moves down.
 */

export const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
export const BARS_PER_DAY_4H = 6;

/** True range per bar. First bar has no previous close → high − low. */
export function trueRanges(bars) {
  if (!Array.isArray(bars)) return [];
  return bars.map((b, i) => {
    const hl = b.high - b.low;
    if (i === 0) return hl;
    const pc = bars[i - 1].close;
    return Math.max(hl, Math.abs(b.high - pc), Math.abs(b.low - pc));
  });
}

/** Wilder ATR series (EWM alpha = 1/period, adjust=false). Same length as bars. */
export function wilderAtr(bars, period = 14) {
  const tr = trueRanges(bars);
  const alpha = 1 / period;
  const out = [];
  let prev = null;
  for (const x of tr) {
    prev = prev == null ? x : prev + alpha * (x - prev);
    out.push(prev);
  }
  return out;
}

export function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** Ratchet: the highest of the finite candidates. The stop never moves down. */
export function ratchet(...candidates) {
  const v = candidates.filter((x) => Number.isFinite(x) && x > 0);
  return v.length ? Math.max(...v) : null;
}

/** ATR multiplier to use at a given price. */
export function multiplierFor(price, { atrMult, tightMult, tightenPct, tightenRef }) {
  const ref = Number(tightenRef);
  if (Number.isFinite(ref) && ref > 0 && Number.isFinite(price)) {
    if (price > ref * (1 + (Number(tightenPct) || 0) / 100)) {
      return { mult: tightMult, tightened: true };
    }
  }
  return { mult: atrMult, tightened: false };
}

/** Index of the bar that contains `anchorMs` (last bar with t ≤ anchor). 0 if anchor predates data. */
export function anchorIndex(bars, anchorMs) {
  if (!bars.length || !Number.isFinite(anchorMs)) return 0;
  let idx = 0;
  for (let i = 0; i < bars.length; i += 1) {
    if (bars[i].t <= anchorMs) idx = i;
    else break;
  }
  return idx;
}

/**
 * Full stop snapshot for display + alerts.
 *
 * @param {object}   p
 * @param {Array}    p.bars              4h OHLC bars (oldest → newest; last may be in progress)
 * @param {number}  [p.livePrice]        latest ticker price (falls back to last close)
 * @param {number}  [p.anchorMs]         trail start (highest high is measured from the bar containing it)
 * @param {number}  [p.stopFloor]        manual stop floor
 * @param {number}  [p.atrMult=2.5]
 * @param {number}  [p.tightMult=1.75]
 * @param {number}  [p.tightenPct=15]
 * @param {number}  [p.tightenRef]       price the +tightenPct% is measured from (avg cost)
 * @param {number}  [p.prevEffectiveStop] last persisted effective stop (ratchet memory)
 * @param {number}  [p.period=14]
 * @param {number}  [p.medianDays=90]
 */
export function computeStopSnapshot({
  bars,
  livePrice,
  anchorMs,
  stopFloor,
  atrMult = 2.5,
  tightMult = 1.75,
  tightenPct = 15,
  tightenRef,
  prevEffectiveStop,
  period = 14,
  medianDays = 90,
}) {
  if (!Array.isArray(bars) || bars.length < 2) return null;

  const atrSeries = wilderAtr(bars, period);
  const last = bars[bars.length - 1];
  const price = Number.isFinite(livePrice) && livePrice > 0 ? livePrice : last.close;
  const atr = atrSeries[atrSeries.length - 1];
  const atrPct = (atr / price) * 100;

  // 90-day median ATR% (skip the warm-up bars so the seed doesn't skew it).
  const nMedian = medianDays * BARS_PER_DAY_4H;
  const from = Math.max(period, bars.length - nMedian);
  const pctSeries = [];
  for (let i = from; i < bars.length; i += 1) {
    if (bars[i].close > 0) pctSeries.push((atrSeries[i] / bars[i].close) * 100);
  }
  const medianAtrPct = median(pctSeries);
  const medianCoverageDays = pctSeries.length / BARS_PER_DAY_4H;

  const multOpts = { atrMult, tightMult, tightenPct, tightenRef };
  const floor = Number.isFinite(stopFloor) && stopFloor > 0 ? stopFloor : null;

  // Walk every bar since the anchor so the ratchet is reproducible from data
  // even when the app wasn't open (trail only ever steps up).
  const start = anchorIndex(bars, anchorMs);
  const anchorBeforeData = Number.isFinite(anchorMs) && anchorMs < bars[0].t;
  let highestHigh = -Infinity;
  let highestHighAt = null;
  let walkedStop = floor;
  let trail = null;
  let mult = atrMult;
  let tightened = false;
  for (let i = start; i < bars.length; i += 1) {
    const b = bars[i];
    const isLast = i === bars.length - 1;
    const hi = isLast ? Math.max(b.high, price) : b.high;
    if (hi > highestHigh) {
      highestHigh = hi;
      highestHighAt = b.t;
    }
    const c = isLast ? price : b.close;
    ({ mult, tightened } = multiplierFor(c, multOpts));
    trail = highestHigh - mult * atrSeries[i];
    walkedStop = ratchet(walkedStop, trail);
  }

  const prev = Number.isFinite(prevEffectiveStop) ? prevEffectiveStop : null;
  const effectiveStop = ratchet(floor, trail, walkedStop, prev);

  const eq = (a, b) => a != null && b != null && Math.abs(a - b) < 1e-12;
  const stopSource = eq(effectiveStop, trail)
    ? 'trail'
    : eq(effectiveStop, floor)
      ? 'floor'
      : 'ratchet';

  const trailDistance = mult * atr;
  const tightenAt =
    Number.isFinite(tightenRef) && tightenRef > 0
      ? tightenRef * (1 + (Number(tightenPct) || 0) / 100)
      : null;

  return {
    price,
    lastBarAt: last.t,
    bars: bars.length,
    atr,
    atrPct,
    medianAtrPct,
    medianCoverageDays,
    anchorBarAt: bars[start].t,
    anchorBeforeData,
    highestHigh,
    highestHighAt,
    mult,
    tightened,
    tightenAt,
    trail,
    trailDistance,
    trailPct: (trailDistance / price) * 100,
    baseTrailPct: ((atrMult * atr) / price) * 100,
    tightTrailPct: ((tightMult * atr) / price) * 100,
    floor,
    effectiveStop,
    stopSource,
    distToStopPct:
      effectiveStop != null ? ((price - effectiveStop) / price) * 100 : null,
  };
}
