/**
 * ATR + staged, ratcheting stop math (pure — no DOM, no fetch, no storage).
 *
 * Bars: `{ t (ms, candle OPEN time), open, high, low, close }`, oldest → newest.
 * The last Kraken bar is usually still forming.
 *
 * ATR: true range = max(high − low, |high − prevClose|, |low − prevClose|);
 *      ATR(14) = Wilder smoothing (EWM alpha = 1/14, seeded with the first TR).
 *
 * Staged stop (DOGE plan):
 *   Stage 1 — before breakout: effective stop = manual stop floor. No ATR trail.
 *   Stage 2 — the first COMPLETED 4h candle (since the plan anchor) that closes
 *             above `breakoutLevel` switches on:
 *               floor  → max(manual floor, breakoutFloor)
 *               trail  = highest high since that breakout candle − mult × ATR
 *               mult   = atrMult (2.5), or tightMult (1.75) once price is more than
 *                        tightenPct (15%) above tightenRef (default: breakoutLevel)
 *   Effective stop = max(floor, trail at every bar since breakout, previous stop).
 *   It never moves down.
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
 * @param {Array}    p.bars               4h OHLC bars (oldest → newest; last may be in progress)
 * @param {number}  [p.livePrice]         latest ticker price (falls back to last close)
 * @param {number}  [p.anchorMs]          plan start: breakout closes are searched from the bar containing it
 * @param {number}  [p.stopFloor]         manual stop floor (stage 1 stop)
 * @param {number}  [p.breakoutLevel]     4h close above this → stage 2
 * @param {number}  [p.breakoutFloor]     floor once stage 2 starts
 * @param {number}  [p.atrMult=2.5]
 * @param {number}  [p.tightMult=1.75]
 * @param {number}  [p.tightenPct=15]
 * @param {number}  [p.tightenRef]        tighten reference; null/blank → breakoutLevel
 * @param {number}  [p.prevEffectiveStop] persisted stop (ratchet memory)
 * @param {number}  [p.nowMs=Date.now()]  used to decide which candles are closed
 * @param {number}  [p.intervalMs=4h]
 * @param {number}  [p.period=14]
 * @param {number}  [p.medianDays=90]
 */
export function computeStopSnapshot({
  bars,
  livePrice,
  anchorMs,
  stopFloor,
  breakoutLevel,
  breakoutFloor,
  atrMult = 2.5,
  tightMult = 1.75,
  tightenPct = 15,
  tightenRef,
  prevEffectiveStop,
  nowMs = Date.now(),
  intervalMs = FOUR_HOURS_MS,
  period = 14,
  medianDays = 90,
}) {
  if (!Array.isArray(bars) || bars.length < 2) return null;

  const pos = (x) => (Number.isFinite(x) && x > 0 ? x : null);
  const atrSeries = wilderAtr(bars, period);
  const last = bars[bars.length - 1];
  const lastIdx = bars.length - 1;
  const price = pos(livePrice) ?? last.close;
  const atr = atrSeries[lastIdx];
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

  const floor = pos(stopFloor);
  const boLevel = pos(breakoutLevel);
  const boFloor = pos(breakoutFloor);
  const tightenRefUsed = pos(tightenRef) ?? boLevel;
  const multOpts = { atrMult, tightMult, tightenPct, tightenRef: tightenRefUsed };
  const tightenAt = tightenRefUsed
    ? tightenRefUsed * (1 + (Number(tightenPct) || 0) / 100)
    : null;

  const start = anchorIndex(bars, anchorMs);
  const anchorBeforeData = Number.isFinite(anchorMs) && anchorMs < bars[0].t;
  const isClosed = (b) => b.t + intervalMs <= nowMs;
  const barHigh = (i) => (i === lastIdx ? Math.max(bars[i].high, price) : bars[i].high);
  const barClose = (i) => (i === lastIdx ? price : bars[i].close);

  // Highest high since the anchor (context only in stage 1).
  let hhSinceAnchor = -Infinity;
  for (let i = start; i < bars.length; i += 1) hhSinceAnchor = Math.max(hhSinceAnchor, barHigh(i));

  // Stage 2 trigger: first completed candle since anchor closing above breakout.
  let breakoutIdx = -1;
  if (boLevel) {
    for (let i = start; i < bars.length; i += 1) {
      if (isClosed(bars[i]) && bars[i].close > boLevel) {
        breakoutIdx = i;
        break;
      }
    }
  }
  const stage = breakoutIdx >= 0 ? 2 : 1;
  const prev = pos(prevEffectiveStop);

  let highestHigh = hhSinceAnchor;
  let highestHighAt = null;
  let trail = null;
  let mult = atrMult;
  let tightened = false;
  let stageFloor = floor;
  let walked = null;

  if (stage === 2) {
    stageFloor = ratchet(floor, boFloor);
    highestHigh = -Infinity;
    walked = stageFloor;
    // Replay every bar since the breakout candle so the ratchet is reproducible
    // from data even when the app wasn't open.
    for (let i = breakoutIdx; i < bars.length; i += 1) {
      const hi = barHigh(i);
      if (hi > highestHigh) {
        highestHigh = hi;
        highestHighAt = bars[i].t;
      }
      ({ mult, tightened } = multiplierFor(barClose(i), multOpts));
      trail = highestHigh - mult * atrSeries[i];
      walked = ratchet(walked, trail);
    }
  }

  const effectiveStop = ratchet(stageFloor, walked, prev);

  const eq = (a, b) => a != null && b != null && Math.abs(a - b) < 1e-12;
  let stopSource = 'ratchet';
  if (eq(effectiveStop, trail)) stopSource = 'trail';
  else if (stage === 2 && eq(effectiveStop, boFloor) && (floor == null || boFloor >= floor))
    stopSource = 'breakoutFloor';
  else if (eq(effectiveStop, floor)) stopSource = 'floor';

  const trailDistance = mult * atr;
  const baseTrailDistance = atrMult * atr;

  return {
    stage,
    trailActive: stage === 2,
    breakoutAt: stage === 2 ? bars[breakoutIdx].t : null,
    breakoutClose: stage === 2 ? bars[breakoutIdx].close : null,
    breakoutLevel: boLevel,
    breakoutFloor: boFloor,
    price,
    lastBarAt: last.t,
    lastBarClosed: isClosed(last),
    bars: bars.length,
    atr,
    atrPct,
    medianAtrPct,
    medianCoverageDays,
    anchorBarAt: bars[start].t,
    anchorBeforeData,
    hhSinceAnchor,
    highestHigh,
    highestHighAt,
    mult,
    tightened,
    tightenRef: tightenRefUsed,
    tightenAt,
    trail,
    // Stage 1 reference only: what a base-multiplier trail would be right now.
    previewTrail: stage === 1 ? hhSinceAnchor - baseTrailDistance : null,
    trailDistance,
    baseTrailDistance,
    trailPct: (trailDistance / price) * 100,
    baseTrailPct: (baseTrailDistance / price) * 100,
    tightTrailPct: ((tightMult * atr) / price) * 100,
    floor,
    stageFloor,
    effectiveStop,
    stopSource,
    distToStopPct:
      effectiveStop != null ? ((price - effectiveStop) / price) * 100 : null,
  };
}
