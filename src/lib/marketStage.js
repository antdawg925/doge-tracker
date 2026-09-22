/**
 * 7-step momentum / pattern stage scoring from daily OHLC + volume.
 * Pattern-recognition lens for momentum charts (stocks & crypto) — tunable,
 * educational, not a buy/sell signal.
 */

import { computeVolumeMetrics, rvolLabel } from './volume.js';

/** Stage labels (1–7). Exported for UI. */
export const STAGE_LABELS = {
  1: 'Base',
  2: 'Ramp',
  3: 'Blowoff',
  4: 'Cliff',
  5: 'Dip reclaim',
  6: 'Weak bounce',
  7: 'Grind down',
};

/** Dad-friendly tradability hints by stage. */
export const STAGE_TRADABILITY = {
  1: 'Watch only — setup forming, not a size entry yet',
  2: 'Early momentum — prefer patience over chasing',
  3: 'Chase caution — blowoff zone; poor risk for fresh longs',
  4: 'High risk — sharp dump; prefer wait for structure',
  5: 'Prefer dip-buy setups — best long window in this pattern',
  6: 'Prefer fade / weak long — bounce often fails',
  7: 'Avoid momentum longs — interest mostly gone',
};

/**
 * Tunable thresholds. Adjust here without touching UI.
 * Percent gains are absolute moves; crypto often prints bigger swings than stocks —
 * `cryptoScale` slightly softens gain thresholds when assetType === 'crypto'.
 */
export const STAGE_THRESHOLDS = {
  minBars: 15,
  rvolAvgDays: 20,
  lookbackShort: 5,
  lookbackStruct: 12,
  highLowWindow20: 20,
  highLowWindow60: 60,
  // Step 3 supernova
  parabolicGain5d: 0.35, // +35% in ~5 sessions
  parabolicGain3d: 0.25,
  supernovaRvol: 4,
  // Step 4 cliff
  cliffGiveback: 0.22, // −22% from local high
  cliffRvol: 1.8,
  // Step 5 dip buy
  dipOffHighMin: 0.12,
  dipOffHighMax: 0.55,
  // Step 6 dead bounce
  weakBounceCeil: 0.65, // bounce reclaim < 65% of spike range
  // Step 7 death
  deathOffHigh: 0.45,
  deathRvolMax: 0.9,
  // Step 1 base
  baseRangeMax: 0.18, // range / mid over window
  // Step 2 ramp
  rampGainFromLow: 0.12,
  cryptoScale: 0.75, // multiply gain thresholds for crypto (easier to trip)
};

function closesOf(bars) {
  return bars.map((b) => Number(b.close)).filter((c) => Number.isFinite(c));
}

function highsOf(bars) {
  return bars.map((b) => Number(b.high ?? b.close)).filter((c) => Number.isFinite(c));
}

function lowsOf(bars) {
  return bars.map((b) => Number(b.low ?? b.close)).filter((c) => Number.isFinite(c));
}

function pctChange(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0) return null;
  return (to - from) / from;
}

function maxOf(arr) {
  if (!arr?.length) return null;
  return Math.max(...arr);
}

function minOf(arr) {
  if (!arr?.length) return null;
  return Math.min(...arr);
}

/**
 * Structure over last `n` bars: count higher-high / higher-low vs lower-high / lower-low
 * using a simple 2-bar swing sample.
 */
export function structureBias(bars, n = 12) {
  if (!bars?.length || bars.length < 6) {
    return { bias: 'flat', hh: 0, hl: 0, lh: 0, ll: 0 };
  }
  const slice = bars.slice(-Math.max(6, n));
  const highs = highsOf(slice);
  const lows = lowsOf(slice);
  let hh = 0;
  let hl = 0;
  let lh = 0;
  let ll = 0;
  const step = Math.max(2, Math.floor(slice.length / 4));
  for (let i = step; i < highs.length; i += step) {
    if (highs[i] > highs[i - step]) hh += 1;
    else if (highs[i] < highs[i - step]) lh += 1;
    if (lows[i] > lows[i - step]) hl += 1;
    else if (lows[i] < lows[i - step]) ll += 1;
  }
  const up = hh + hl;
  const down = lh + ll;
  let bias = 'flat';
  if (up >= down + 2) bias = 'up';
  else if (down >= up + 2) bias = 'down';
  return { bias, hh, hl, lh, ll, up, down };
}

function gainOver(closes, days) {
  if (closes.length < days + 1) return null;
  const from = closes[closes.length - 1 - days];
  const to = closes[closes.length - 1];
  return pctChange(from, to);
}

function avgTrueRange(bars, n = 14) {
  if (!bars?.length || bars.length < 2) return null;
  const end = bars.length;
  const start = Math.max(1, end - n);
  const ranges = [];
  for (let i = start; i < end; i += 1) {
    const h = Number(bars[i].high ?? bars[i].close);
    const l = Number(bars[i].low ?? bars[i].close);
    const prev = Number(bars[i - 1].close);
    if (![h, l, prev].every(Number.isFinite)) continue;
    ranges.push(Math.max(h - l, Math.abs(h - prev), Math.abs(l - prev)));
  }
  if (ranges.length < 3) return null;
  return ranges.reduce((a, b) => a + b, 0) / ranges.length;
}

function scaleTh(th, assetType) {
  if (assetType !== 'crypto') return { ...th };
  const s = th.cryptoScale ?? 1;
  return {
    ...th,
    parabolicGain5d: th.parabolicGain5d * s,
    parabolicGain3d: th.parabolicGain3d * s,
    cliffGiveback: th.cliffGiveback * s,
    dipOffHighMin: th.dipOffHighMin * s,
    dipOffHighMax: Math.min(0.75, th.dipOffHighMax * (2 - s)),
    deathOffHigh: th.deathOffHigh * s,
    baseRangeMax: th.baseRangeMax * (2 - s),
    rampGainFromLow: th.rampGainFromLow * s,
  };
}

/**
 * Score daily bars into a momentum / pattern stage (1–7).
 * @param {Array} bars - daily OHLC (+ volume) oldest→newest
 * @param {{ assetType?: 'crypto'|'stock', thresholds?: object }} [opts]
 * @returns {{
 *   ok: boolean,
 *   stage: number|null,
 *   label: string|null,
 *   confidence: 'high'|'medium'|'low'|null,
 *   tradability: string|null,
 *   reasons: string[],
 *   metrics?: object,
 *   message?: string,
 * }}
 */
export function scoreMarketStage(bars, opts = {}) {
  const th = scaleTh(
    { ...STAGE_THRESHOLDS, ...(opts.thresholds || {}) },
    opts.assetType,
  );

  if (!bars?.length || bars.length < th.minBars) {
    return {
      ok: false,
      stage: null,
      label: null,
      confidence: null,
      tradability: null,
      reasons: [],
      message: 'Not enough history',
    };
  }

  const closes = closesOf(bars);
  if (closes.length < th.minBars) {
    return {
      ok: false,
      stage: null,
      label: null,
      confidence: null,
      tradability: null,
      reasons: [],
      message: 'Not enough history',
    };
  }

  const last = closes[closes.length - 1];
  const w20 = Math.min(th.highLowWindow20, closes.length);
  const w60 = Math.min(th.highLowWindow60, closes.length);
  const high20 = maxOf(closes.slice(-w20));
  const low20 = minOf(closes.slice(-w20));
  const high60 = maxOf(closes.slice(-w60));
  const highs = highsOf(bars);
  const localHigh = maxOf(highs.slice(-Math.min(40, highs.length))) ?? high20;
  const pctFrom20High = high20 ? pctChange(high20, last) : null;
  const pctFrom20Low = low20 ? pctChange(low20, last) : null;
  const pctFrom60High = high60 ? pctChange(high60, last) : null;
  const pctFromLocalHigh = localHigh ? pctChange(localHigh, last) : null;

  const gain3 = gainOver(closes, 3);
  const gain5 = gainOver(closes, 5);
  const gain10 = gainOver(closes, 10);

  const vol = computeVolumeMetrics(bars);
  const rvol = vol.available ? vol.rvol : null;
  const trend = vol.available ? vol.trend : null;
  const struct = structureBias(bars, th.lookbackStruct);
  const atr = avgTrueRange(bars, 14);
  const lastBar = bars[bars.length - 1];
  const dayRange =
    Number.isFinite(lastBar?.high) && Number.isFinite(lastBar?.low)
      ? lastBar.high - lastBar.low
      : null;
  const wideCandle =
    atr != null && dayRange != null && atr > 0 ? dayRange / atr >= 2.2 : false;

  // Recent down-day volume vs up-day (last ~10)
  const recent = bars.slice(-10);
  let upVol = 0;
  let downVol = 0;
  let upN = 0;
  let downN = 0;
  for (const b of recent) {
    if (!Number.isFinite(b.volume) || b.volume <= 0) continue;
    if (b.close >= (b.open ?? b.close)) {
      upVol += b.volume;
      upN += 1;
    } else {
      downVol += b.volume;
      downN += 1;
    }
  }
  const heavyDownVol =
    downN > 0 && upN > 0 ? downVol / Math.max(1, downN) > (upVol / Math.max(1, upN)) * 1.25 : false;

  // Score each stage; pick best with confidence from margin.
  const scores = {
    1: 0,
    2: 0,
    3: 0,
    4: 0,
    5: 0,
    6: 0,
    7: 0,
  };
  const reasonBags = {
    1: [],
    2: [],
    3: [],
    4: [],
    5: [],
    6: [],
    7: [],
  };

  const push = (stage, pts, reason) => {
    scores[stage] += pts;
    if (reason) reasonBags[stage].push(reason);
  };

  // --- Step 3: Supernova (parabolic + high RVOL) ---
  const bigSpike =
    (gain5 != null && gain5 >= th.parabolicGain5d) ||
    (gain3 != null && gain3 >= th.parabolicGain3d);
  if (bigSpike) {
    push(3, 3, gain5 != null ? `+${(gain5 * 100).toFixed(0)}% / 5d` : `+${(gain3 * 100).toFixed(0)}% / 3d`);
  }
  if (rvol != null && rvol >= th.supernovaRvol && bigSpike) {
    push(3, 3, `RVOL ${rvol.toFixed(1)}×`);
  } else if (rvol != null && rvol >= th.supernovaRvol) {
    push(3, 1.5, `RVOL ${rvol.toFixed(1)}×`);
  }
  if (wideCandle && bigSpike) push(3, 1, 'Wide blowoff candle');
  if (pctFrom20Low != null && pctFrom20Low >= 0.5 && bigSpike) {
    push(3, 1, `Extended +${(pctFrom20Low * 100).toFixed(0)}% from 20d low`);
  }

  // --- Step 4: Cliff dive ---
  const sharpGiveback =
    pctFromLocalHigh != null && pctFromLocalHigh <= -th.cliffGiveback;
  const recentWasHot =
    (gain10 != null && gain10 > 0.15) ||
    (high20 != null && low20 != null && (high20 - low20) / low20 > 0.25);
  if (sharpGiveback && recentWasHot) {
    push(
      4,
      3.5,
      `${(pctFromLocalHigh * 100).toFixed(0)}% off local high`,
    );
  } else if (sharpGiveback) {
    push(4, 1.5, `${(pctFromLocalHigh * 100).toFixed(0)}% off high`);
  }
  if (sharpGiveback && heavyDownVol) push(4, 2, 'Heavy down-day volume');
  if (sharpGiveback && struct.bias === 'down') push(4, 1, 'Broke staircase supports');
  if (
    gain3 != null &&
    gain3 <= -th.cliffGiveback * 0.8 &&
    rvol != null &&
    rvol >= th.cliffRvol
  ) {
    push(4, 2, `Sharp 3d drop ${(gain3 * 100).toFixed(0)}%`);
  }

  // --- Step 5: Dip buy ---
  const offHigh = pctFromLocalHigh != null ? -pctFromLocalHigh : null;
  const inDipBand =
    offHigh != null &&
    offHigh >= th.dipOffHighMin &&
    offHigh <= th.dipOffHighMax;
  const reclaim =
    (gain3 != null && gain3 > 0.02) ||
    (struct.hl >= 1 && struct.bias !== 'down');
  const stillAlive = rvol == null || rvol >= 0.85;
  if (inDipBand && reclaim && stillAlive && !bigSpike) {
    push(5, 3.5, `${(offHigh * 100).toFixed(0)}% off high, reclaiming`);
  } else if (inDipBand && reclaim) {
    push(5, 2, 'Pullback with bounce');
  }
  if (inDipBand && struct.bias === 'up') push(5, 1.5, 'Higher-low structure');
  if (inDipBand && trend?.direction === 'rising') push(5, 0.5, 'Volume still interested');

  // --- Step 6: Dead-pump bounce ---
  const bounceFromLow =
    low20 != null && last > low20 ? (last - low20) / (high20 - low20 || last) : null;
  const lowerHighFail =
    pctFromLocalHigh != null &&
    pctFromLocalHigh < -0.05 &&
    pctFrom20High != null &&
    pctFrom20High < -0.02 &&
    gain5 != null &&
    gain5 > 0 &&
    gain5 < 0.12;
  if (
    offHigh != null &&
    offHigh >= th.dipOffHighMin &&
    lowerHighFail &&
    (rvol == null || rvol < th.supernovaRvol * 0.6)
  ) {
    push(6, 3, 'Weaker bounce / lower high');
  }
  if (
    bounceFromLow != null &&
    bounceFromLow < th.weakBounceCeil &&
    offHigh != null &&
    offHigh > 0.2 &&
    struct.bias !== 'up'
  ) {
    push(6, 2, 'Failed reclaim of spike zone');
  }
  if (trend?.direction === 'falling' && offHigh != null && offHigh > 0.15) {
    push(6, 1, 'Bounce volume fading');
  }

  // --- Step 7: Long kiss goodnight ---
  const farFromHigh =
    (pctFrom60High != null && pctFrom60High <= -th.deathOffHigh) ||
    (pctFrom20High != null && pctFrom20High <= -th.deathOffHigh * 0.7);
  if (farFromHigh && struct.bias === 'down') {
    push(7, 3.5, `${((pctFrom60High ?? pctFrom20High) * 100).toFixed(0)}% off highs`);
  } else if (farFromHigh) {
    push(7, 2, 'Large drawdown from peak');
  }
  if (farFromHigh && (rvol == null || rvol <= th.deathRvolMax)) {
    push(7, 2, 'Volume dried up');
  }
  if (struct.bias === 'down' && trend?.direction === 'falling') {
    push(7, 1, 'Persistent LH/LL + fading volume');
  }

  // --- Step 1: Pre-pump / base ---
  const windowCloses = closes.slice(-Math.min(25, closes.length));
  const baseHi = maxOf(windowCloses);
  const baseLo = minOf(windowCloses);
  const baseMid = baseHi != null && baseLo != null ? (baseHi + baseLo) / 2 : null;
  const baseRange =
    baseMid && baseMid > 0 && baseHi != null && baseLo != null
      ? (baseHi - baseLo) / baseMid
      : null;
  const quietBase =
    baseRange != null &&
    baseRange <= th.baseRangeMax &&
    (gain10 == null || Math.abs(gain10) < 0.12);
  if (quietBase) {
    push(1, 3, 'Quiet sideways base');
  }
  if (quietBase && rvol != null && rvol >= 1.2 && rvol < th.supernovaRvol) {
    push(1, 2, 'Early volume waking up');
  } else if (quietBase && trend?.direction === 'rising') {
    push(1, 1.5, 'Volume creeping higher');
  }
  if (quietBase && pctFrom20High != null && pctFrom20High > -0.05) {
    push(1, 0.5, 'Near top of base');
  }

  // --- Step 2: Ramp ---
  const orderlyUp =
    struct.bias === 'up' &&
    !bigSpike &&
    (gain10 == null || gain10 < th.parabolicGain5d * 1.2) &&
    pctFrom20Low != null &&
    pctFrom20Low >= th.rampGainFromLow;
  if (orderlyUp) {
    push(2, 3.5, 'Higher highs / higher lows');
  }
  if (orderlyUp && upVol > downVol * 1.1) push(2, 1.5, 'Volume leads up-days');
  if (
    orderlyUp &&
    rvol != null &&
    rvol >= 1.1 &&
    rvol < th.supernovaRvol
  ) {
    push(2, 1, 'Elevated but not blowoff volume');
  }
  if (
    pctFrom20Low != null &&
    pctFrom20Low >= th.rampGainFromLow &&
    !bigSpike &&
    struct.bias !== 'down'
  ) {
    push(2, 1, `+${(pctFrom20Low * 100).toFixed(0)}% from 20d low`);
  }

  // Pick winner
  let best = 2;
  let bestScore = -1;
  let second = 0;
  for (let s = 1; s <= 7; s += 1) {
    if (scores[s] > bestScore) {
      second = bestScore;
      bestScore = scores[s];
      best = s;
    } else if (scores[s] > second) {
      second = scores[s];
    }
  }

  // If nothing scored meaningfully, fall back by structure
  if (bestScore < 1.5) {
    if (quietBase) best = 1;
    else if (struct.bias === 'up') best = 2;
    else if (struct.bias === 'down' && farFromHigh) best = 7;
    else if (struct.bias === 'down') best = 4;
    else best = 2;
    bestScore = Math.max(bestScore, 1.2);
    if (!reasonBags[best].length) {
      reasonBags[best].push(
        struct.bias === 'up'
          ? 'Mild uptrend structure'
          : struct.bias === 'down'
            ? 'Mild downtrend structure'
            : 'Mixed / quiet tape',
      );
    }
  }

  const margin = bestScore - second;
  let confidence = 'low';
  if (bestScore >= 5 && margin >= 2) confidence = 'high';
  else if (bestScore >= 3 || margin >= 1.2) confidence = 'medium';

  // Build 2–4 reason chips (prefer winner's bag; pad with metrics)
  const reasons = [...reasonBags[best]];
  if (rvol != null && Number.isFinite(rvol)) {
    const lab = rvolLabel(rvol);
    const chip = `RVOL ${rvol.toFixed(2)}×${lab ? ` · ${lab.text}` : ''}`;
    if (!reasons.some((r) => r.startsWith('RVOL'))) reasons.push(chip);
  }
  if (pctFrom20High != null && Number.isFinite(pctFrom20High)) {
    const chip =
      pctFrom20High >= 0
        ? `At/near 20d high`
        : `${(pctFrom20High * 100).toFixed(1)}% from 20d high`;
    if (reasons.length < 4 && !reasons.includes(chip)) reasons.push(chip);
  }
  if (trend?.text && reasons.length < 4) {
    const short =
      trend.direction === 'rising'
        ? 'Vol rising'
        : trend.direction === 'falling'
          ? 'Vol falling'
          : 'Vol steady';
    if (!reasons.some((r) => /vol/i.test(r))) reasons.push(short);
  }

  const metrics = {
    rvol,
    rvolLabel: rvol != null ? rvolLabel(rvol) : null,
    pctFrom20High,
    pctFrom20Low,
    pctFrom60High,
    pctFromLocalHigh,
    gain3,
    gain5,
    structure: struct.bias,
    volumeTrend: trend?.direction ?? null,
    scores,
  };

  return {
    ok: true,
    stage: best,
    label: STAGE_LABELS[best],
    confidence,
    tradability: STAGE_TRADABILITY[best],
    reasons: reasons.slice(0, 4),
    metrics,
  };
}
