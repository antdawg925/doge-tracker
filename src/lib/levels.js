/** Statistical support / resistance helpers from daily OHLC or closes. */

function sortedCopy(values) {
  return [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
}

/** Linear-interpolated percentile; `p` in [0, 1]. */
export function percentile(values, p) {
  const s = sortedCopy(values);
  if (!s.length) return null;
  if (s.length === 1) return s[0];
  const clamped = Math.min(1, Math.max(0, p));
  const idx = (s.length - 1) * clamped;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  const w = idx - lo;
  return s[lo] * (1 - w) + s[hi] * w;
}

export function median(values) {
  return percentile(values, 0.5);
}

export function mean(values) {
  const s = values.filter((v) => Number.isFinite(v));
  if (!s.length) return null;
  return s.reduce((a, b) => a + b, 0) / s.length;
}

export function stdDev(values) {
  const s = values.filter((v) => Number.isFinite(v));
  if (s.length < 2) return null;
  const m = mean(s);
  const varSum = s.reduce((acc, v) => acc + (v - m) ** 2, 0);
  return Math.sqrt(varSum / (s.length - 1));
}

/** Rolling max/min of closes over the last `window` bars. */
export function rollingExtremes(closes, window) {
  if (!closes?.length) return { high: null, low: null };
  const slice = closes.slice(-Math.max(1, window));
  return {
    high: Math.max(...slice),
    low: Math.min(...slice),
  };
}

/**
 * Simple swing high/low: local extrema with `lookback` bars on each side,
 * using the most recent extrema found scanning from the end.
 */
export function recentSwing(closes, lookback = 3) {
  if (!closes || closes.length < lookback * 2 + 1) {
    return { swingHigh: null, swingLow: null };
  }
  let swingHigh = null;
  let swingLow = null;
  for (let i = closes.length - 1 - lookback; i >= lookback; i -= 1) {
    const c = closes[i];
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= lookback; j += 1) {
      if (closes[i - j] >= c || closes[i + j] >= c) isHigh = false;
      if (closes[i - j] <= c || closes[i + j] <= c) isLow = false;
    }
    if (isHigh && swingHigh == null) swingHigh = c;
    if (isLow && swingLow == null) swingLow = c;
    if (swingHigh != null && swingLow != null) break;
  }
  return { swingHigh, swingLow };
}

function classify(price, spot) {
  if (spot == null || price == null) return 'neutral';
  const eps = spot * 0.002; // ~0.2% band around spot
  if (Math.abs(price - spot) <= eps) return 'neutral';
  return price < spot ? 'support' : 'resistance';
}

/**
 * Build labeled levels from daily bars.
 * Each bar: { close, high?, low? } (high/low optional).
 */
export function computeLevels(dailyBars, spot) {
  if (!dailyBars?.length) return [];

  const closes = dailyBars.map((b) => b.close).filter(Number.isFinite);
  if (!closes.length) return [];

  const highs = dailyBars
    .map((b) => (Number.isFinite(b.high) ? b.high : b.close))
    .filter(Number.isFinite);
  const lows = dailyBars
    .map((b) => (Number.isFinite(b.low) ? b.low : b.close))
    .filter(Number.isFinite);

  const p25 = percentile(closes, 0.25);
  const p50 = median(closes);
  const p75 = percentile(closes, 0.75);
  const m = mean(closes);
  const sd = stdDev(closes);
  const r20 = rollingExtremes(closes, 20);
  const r50 = rollingExtremes(closes, Math.min(50, closes.length));
  const { swingHigh, swingLow } = recentSwing(closes, 3);

  const rangeHigh = highs.length ? Math.max(...highs) : null;
  const rangeLow = lows.length ? Math.min(...lows) : null;

  const candidates = [
    { id: 'p25', name: '25th pct (closes)', price: p25 },
    { id: 'median', name: 'Median close', price: p50 },
    { id: 'p75', name: '75th pct (closes)', price: p75 },
    {
      id: 'mean_minus_1s',
      name: 'Mean − 1σ',
      price: m != null && sd != null ? m - sd : null,
    },
    {
      id: 'mean_plus_1s',
      name: 'Mean + 1σ',
      price: m != null && sd != null ? m + sd : null,
    },
    { id: 'roll20_high', name: '20d rolling high', price: r20.high },
    { id: 'roll20_low', name: '20d rolling low', price: r20.low },
    { id: 'roll50_high', name: '50d rolling high', price: r50.high },
    { id: 'roll50_low', name: '50d rolling low', price: r50.low },
    { id: 'swing_high', name: 'Recent swing high', price: swingHigh },
    { id: 'swing_low', name: 'Recent swing low', price: swingLow },
    { id: 'range_high', name: 'Lookback range high', price: rangeHigh },
    { id: 'range_low', name: 'Lookback range low', price: rangeLow },
  ];

  // Dedupe near-identical prices (~0.15%) keeping first label.
  const seen = [];
  const levels = [];
  for (const c of candidates) {
    if (c.price == null || !Number.isFinite(c.price) || c.price <= 0) continue;
    const dup = seen.some((p) => Math.abs(p - c.price) / c.price < 0.0015);
    if (dup) continue;
    seen.push(c.price);
    levels.push({
      ...c,
      type: classify(c.price, spot),
    });
  }

  levels.sort((a, b) => a.price - b.price);
  return levels;
}

/**
 * Sell estimates if the full DOGE book is sold at `levelPrice`.
 * `coins` = current position size in DOGE.
 */
export function sellEstimate(levelPrice, coins, avgCost, spot) {
  if (
    !Number.isFinite(levelPrice) ||
    !Number.isFinite(coins) ||
    coins <= 0 ||
    !Number.isFinite(avgCost)
  ) {
    return null;
  }
  const proceeds = coins * levelPrice;
  const cost = coins * avgCost;
  const profitVsCost = proceeds - cost;
  const profitPctVsCost = cost > 0 ? (profitVsCost / cost) * 100 : null;
  const markNow = Number.isFinite(spot) ? coins * spot : null;
  const gainVsSpot =
    markNow != null ? proceeds - markNow : null;
  const gainPctVsSpot =
    markNow != null && markNow > 0 ? (gainVsSpot / markNow) * 100 : null;

  return {
    proceeds,
    cost,
    profitVsCost,
    profitPctVsCost,
    gainVsSpot,
    gainPctVsSpot,
  };
}

/** Coins from MTM DOGE $ at spot, falling back to avg cost. */
export function positionCoins(dogeValue, spot, avgCost) {
  if (!Number.isFinite(dogeValue) || dogeValue <= 0) return 0;
  if (Number.isFinite(spot) && spot > 0) return dogeValue / spot;
  if (Number.isFinite(avgCost) && avgCost > 0) return dogeValue / avgCost;
  return 0;
}
