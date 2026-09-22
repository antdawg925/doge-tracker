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
    !Number.isFinite(avgCost) ||
    avgCost <= 0
  ) {
    return null;
  }
  const proceeds = coins * levelPrice;
  const cost = coins * avgCost;
  const profitVsCost = proceeds - cost;
  const profitPctVsCost = cost > 0 ? (profitVsCost / cost) * 100 : null;
  const markNow = Number.isFinite(spot) ? coins * spot : null;
  const gainVsSpot = markNow != null ? proceeds - markNow : null;
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

/** Prefer explicit coins; fall back to legacy dogeValue / price. */
export function resolveCoins(position, spot) {
  if (!position) return 0;
  if (Number.isFinite(position.coins) && position.coins > 0) {
    return position.coins;
  }
  const { dogeValue, avgCost } = position;
  if (!Number.isFinite(dogeValue) || dogeValue <= 0) return 0;
  if (Number.isFinite(spot) && spot > 0) return dogeValue / spot;
  if (Number.isFinite(avgCost) && avgCost > 0) return dogeValue / avgCost;
  return 0;
}

/** @deprecated use resolveCoins — kept for any lingering imports */
export function positionCoins(dogeValue, spot, avgCost) {
  if (!Number.isFinite(dogeValue) || dogeValue <= 0) return 0;
  if (Number.isFinite(spot) && spot > 0) return dogeValue / spot;
  if (Number.isFinite(avgCost) && avgCost > 0) return dogeValue / avgCost;
  return 0;
}

/** Supports only (below spot). */
export function supportLevels(levels, spot) {
  if (!levels?.length || !Number.isFinite(spot)) return [];
  return levels
    .filter(
      (l) =>
        Number.isFinite(l.price) &&
        l.price < spot * 0.998 &&
        (l.type === 'support' || l.price < spot),
    )
    .sort((a, b) => b.price - a.price);
}

/** Resistances only (above spot). */
export function resistanceLevels(levels, spot) {
  if (!levels?.length || !Number.isFinite(spot)) return [];
  return levels
    .filter(
      (l) =>
        Number.isFinite(l.price) &&
        l.price > spot * 1.002 &&
        (l.type === 'resistance' || l.price > spot),
    )
    .sort((a, b) => a.price - b.price);
}

const MIN_MEANINGFUL_PCT = 3; // prefer ≥3% below spot for primary stop
const DEDUPE_PCT = 0.01; // ~1% of spot = near-identical
const TOP_N = 5;

function isNear(a, b, spot, pct = DEDUPE_PCT) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(spot) || spot <= 0) {
    return false;
  }
  return Math.abs(a - b) / spot < pct;
}

function stopLabelFromFriendly(friendlyLabel, index, total) {
  if (friendlyLabel === 'Nearest support') return 'Tight stop (nearest support)';
  if (friendlyLabel === 'Key support') return 'Key stop (strong support)';
  if (friendlyLabel === 'Wider support') return 'Wider stop (structural support)';
  if (friendlyLabel === 'Next support') return 'Mid stop (next support)';
  if (index === 0) return 'Tight stop (nearest support)';
  if (index === total - 1) return 'Wider stop (structural support)';
  return 'Mid stop (next support)';
}

/** Significance weight by id / kind for ranking Top-N. */
function supportSignificance(lvl) {
  const id = lvl.id || '';
  const kind = lvl.kind || '';
  if (kind === 'period_low' || id.endsWith('_low') && (id.startsWith('6m') || id.startsWith('1y') || id.startsWith('5y'))) {
    if (id.startsWith('5y')) return 95;
    if (id.startsWith('1y')) return 88;
    if (id.startsWith('6m')) return 80;
  }
  const map = {
    swing_low: 92,
    roll20_low: 78,
    roll50_low: 74,
    range_low: 70,
    p25: 66,
    mean_minus_1s: 62,
    median: 50,
  };
  if (map[id] != null) return map[id];
  if (kind === 'swing_low') return 85;
  if (kind === 'percentile') return 55;
  return 45;
}

function resistanceSignificance(lvl) {
  const id = lvl.id || '';
  const kind = lvl.kind || '';
  if (kind === 'period_high') {
    if (lvl.tfKey === '5y') return 96;
    if (lvl.tfKey === '1y') return 90;
    if (lvl.tfKey === '6m') return 82;
    return 80;
  }
  if (kind === 'major_peak') {
    if (lvl.tfKey === '5y') return 84;
    if (lvl.tfKey === '1y') return 78;
    return 72;
  }
  if (kind === 'swing_high' || id === 'swing_high') return 88;
  const map = {
    roll20_high: 76,
    roll50_high: 72,
    range_high: 70,
    p75: 64,
    mean_plus_1s: 60,
    median: 48,
  };
  if (map[id] != null) return map[id];
  if (kind === 'percentile') return 52;
  return 44;
}

/** One-sentence why for a support level. */
export function supportWhy(lvl) {
  const id = lvl.id || '';
  const name = (lvl.name || '').toLowerCase();
  if (id === 'swing_low' || (lvl.kind === 'swing_low' && !lvl.tfKey)) {
    return 'Nearest swing low — first area buyers may defend.';
  }
  if (id === 'roll20_low') {
    return '20-day low — recent floor traders often watch for a hold.';
  }
  if (id === 'roll50_low') {
    return '50-day low — multi-week structural floor.';
  }
  if (id === 'p25') {
    return 'Lower quartile of closes — price spent relatively little time below here.';
  }
  if (id === 'mean_minus_1s') {
    return 'Mean − 1σ — statistical stretch where mean reversion often appears.';
  }
  if (id === 'median') {
    return 'Median close — midpoint of the lookback; soft support if still below spot.';
  }
  if (id === 'range_low') {
    return 'Lookback range low — deepest floor in the chart window.';
  }
  if (id.endsWith('_p25') || (lvl.kind === 'percentile' && /25/.test(lvl.name || ''))) {
    if (id.startsWith('6m')) {
      return '6-month lower quartile — soft floor inside the half-year range.';
    }
    if (id.startsWith('1y')) {
      return '1-year lower quartile — soft floor inside the yearly range.';
    }
    if (id.startsWith('5y')) {
      return 'Long-history lower quartile — soft floor across available history.';
    }
  }
  if (id.endsWith('_swing_low') || (lvl.kind === 'swing_low' && lvl.tfKey)) {
    if (id.startsWith('6m')) {
      return '6-month swing low — trough buyers defended in the half-year.';
    }
    if (id.startsWith('1y')) {
      return '1-year swing low — trough buyers defended over the past year.';
    }
    if (id.startsWith('5y')) {
      return 'Long-history swing low — major trough in available history.';
    }
    return 'Swing low — local trough where buyers previously stepped in.';
  }
  if (id.endsWith('_low') || lvl.kind === 'period_low' || /low/.test(name)) {
    if (id.startsWith('6m') || /6m/i.test(lvl.name || '')) {
      return '6-month low — buyers previously defended this in the half-year.';
    }
    if (id.startsWith('1y') || /1y/i.test(lvl.name || '')) {
      return '1-year low — major support from the past year.';
    }
    if (id.startsWith('5y') || /max|5y|multi-year/i.test(lvl.name || '')) {
      return 'Multi-year / max-history low — deepest available historical floor.';
    }
    return `${lvl.name || 'Structural low'} — longer-term floor buyers have defended.`;
  }
  if (lvl.kind === 'swing_low' || /swing/i.test(lvl.name || '')) {
    return 'Swing low — local trough where buyers previously stepped in.';
  }
  return `${lvl.name || 'Support'} — historical area where buyers stepped in.`;
}

/** One-sentence why for a resistance level. */
export function resistanceWhy(lvl) {
  const id = lvl.id || '';
  const kind = lvl.kind || '';
  if (kind === 'period_high' || id.endsWith('_high')) {
    if (lvl.tfKey === '6m' || id.startsWith('6m') || /\b6m\b/i.test(lvl.name || '')) {
      return '6-month high — sellers previously capped price here.';
    }
    if (lvl.tfKey === '1y' || id.startsWith('1y') || /\b1y\b/i.test(lvl.name || '')) {
      return '1-year high — hasn’t cleared this in a year; stronger ceiling.';
    }
    if (lvl.tfKey === '5y' || id.startsWith('5y') || /max|5y|multi-year/i.test(lvl.name || '')) {
      return 'Multi-year / max-history high — strong historical ceiling if still below it.';
    }
    if (id === 'roll20_high') {
      return '20-day high — short-term ceiling where recent rallies stalled.';
    }
    if (id === 'roll50_high') {
      return '50-day high — multi-week resistance traders watch on breakouts.';
    }
    if (id === 'range_high') {
      return 'Lookback range high — top of the chart window.';
    }
  }
  if (id === 'swing_high' || kind === 'swing_high') {
    return 'Recent swing high — nearest peak where rallies stalled.';
  }
  if (kind === 'major_peak') {
    return 'Prior major peak — sellers capped price at this earlier high.';
  }
  if (id === 'p75' || kind === 'percentile') {
    return 'Upper quartile of highs — stretch zone where selling often appears.';
  }
  if (id === 'mean_plus_1s') {
    return 'Mean + 1σ — statistical stretch above average closes.';
  }
  if (id === 'median' || kind === 'median') {
    return 'Median close — soft ceiling if price is still below it.';
  }
  return `${lvl.name || 'Resistance'} — historical area where buyers lost steam.`;
}

/**
 * Support-oriented levels for a single timeframe lookback (period / swing lows).
 */
export function computeTfSupportLevels(dailyBars, spot, tfKey, tfShortLabel) {
  if (!dailyBars?.length) return [];

  const closes = dailyBars.map((b) => b.close).filter(Number.isFinite);
  const lows = dailyBars
    .map((b) => (Number.isFinite(b.low) ? b.low : b.close))
    .filter(Number.isFinite);
  if (!closes.length) return [];

  const prefix = tfShortLabel || tfKey;
  const periodLow = lows.length ? Math.min(...lows) : Math.min(...closes);
  const p25Lows = percentile(lows.length ? lows : closes, 0.25);
  const lookback = Math.min(5, Math.max(2, Math.floor(closes.length / 40)));
  // Reuse swing-high finder on inverted series for lows
  const inv = (lows.length ? lows : closes).map((v) => -v);
  const troughs = findSwingHighs(inv, lookback).map((p) => ({
    index: p.index,
    price: -p.price,
  }));
  const recentSwing = troughs.length ? troughs[troughs.length - 1].price : null;

  const candidates = [
    {
      id: `${tfKey}_low`,
      name: `${prefix} low`,
      price: periodLow,
      kind: 'period_low',
      strength: 3,
    },
    {
      id: `${tfKey}_swing_low`,
      name: `${prefix} swing low`,
      price: recentSwing,
      kind: 'swing_low',
      strength: 2,
    },
    {
      id: `${tfKey}_p25`,
      name: `${prefix} 25th pct`,
      price: p25Lows,
      kind: 'percentile',
      strength: 1,
    },
  ];

  const seen = [];
  const levels = [];
  for (const c of candidates) {
    if (c.price == null || !Number.isFinite(c.price) || c.price <= 0) continue;
    const dup = seen.some((p) => Math.abs(p - c.price) / c.price < 0.004);
    if (dup) continue;
    seen.push(c.price);
    levels.push({
      ...c,
      tfKey,
      tfLabel: prefix,
      type: classify(c.price, spot),
    });
  }
  levels.sort((a, b) => a.price - b.price);
  return levels;
}

function collectSupportCandidates(levels, spot, tfSets) {
  const out = [];
  const short = supportLevels(levels, spot);
  for (const l of short) out.push({ ...l, tfKey: l.tfKey || 'chart' });

  if (tfSets) {
    for (const key of ['6m', '1y', '5y']) {
      const set = tfSets[key];
      if (!set?.bars?.length) continue;
      const raw = computeTfSupportLevels(set.bars, spot, key, set.shortLabel);
      for (const l of raw) {
        if (Number.isFinite(l.price) && l.price < spot * 0.998) {
          out.push(l);
        }
      }
    }
  }
  return out;
}

function rankAndPickTop(candidates, spot, side, topN = TOP_N) {
  if (!candidates?.length || !Number.isFinite(spot) || spot <= 0) return [];

  // Deduplicate near-identical; keep higher-significance
  const sorted = [...candidates].sort((a, b) => {
    const sigA = side === 'support' ? supportSignificance(a) : resistanceSignificance(a);
    const sigB = side === 'support' ? supportSignificance(b) : resistanceSignificance(b);
    if (sigB !== sigA) return sigB - sigA;
    // Tie-break: closer to spot preferred for structural mix later
    return Math.abs(a.price - spot) - Math.abs(b.price - spot);
  });

  const deduped = [];
  for (const l of sorted) {
    if (!Number.isFinite(l.price) || l.price <= 0) continue;
    if (deduped.some((p) => isNear(p.price, l.price, spot))) continue;
    deduped.push(l);
  }

  // Prefer a mix of timeframes / kinds when picking Top-N
  const picked = [];
  const usedBuckets = new Set();

  const bucketOf = (l) => {
    if (l.tfKey && l.tfKey !== 'chart') return l.tfKey;
    if (l.id === 'swing_low' || l.id === 'swing_high' || l.kind === 'swing_low' || l.kind === 'swing_high') {
      return 'swing';
    }
    if (l.id?.includes('roll20') || l.id?.includes('20')) return '20d';
    if (l.id?.includes('roll50') || l.id?.includes('50')) return '50d';
    if (l.kind === 'period_high' || l.kind === 'period_low') return l.tfKey || 'period';
    return l.id || 'other';
  };

  // Pass 1: diversify buckets
  for (const l of deduped) {
    if (picked.length >= topN) break;
    const b = bucketOf(l);
    if (usedBuckets.has(b) && picked.length < topN - 1) {
      // allow later fill
      continue;
    }
    if (usedBuckets.has(b)) continue;
    usedBuckets.add(b);
    picked.push(l);
  }

  // Pass 2: fill remaining by significance order
  for (const l of deduped) {
    if (picked.length >= topN) break;
    if (picked.some((p) => isNear(p.price, l.price, spot) || p.id === l.id)) continue;
    picked.push(l);
  }

  // Sort: supports nearest-first (high→low), resistance nearest-first (low→high)
  if (side === 'support') {
    picked.sort((a, b) => b.price - a.price);
  } else {
    picked.sort((a, b) => a.price - b.price);
  }
  return picked.slice(0, topN);
}

function labelSupportRank(index, total, lvl) {
  if (index === 0) return 'Nearest support';
  if (index === total - 1 && total >= 3) return 'Wider support';
  if (lvl.kind === 'period_low' || /low$/i.test(lvl.id || '')) {
    return lvl.name || 'Structural support';
  }
  if (index === 1) return 'Key support';
  return lvl.name || 'Next support';
}

function labelResistanceRank(index, total, lvl) {
  if (index === 0) return 'Nearest resistance';
  if (index === total - 1 && total >= 3) return 'Farther resistance';
  return lvl.name || 'Next resistance';
}

/**
 * Top supports below spot (max 5), mixing chart + multi-TF lows when available.
 * Each item: { ...level, friendlyLabel, sourceName, why }.
 */
export function pickTopSupports(levels, spot, tfSets = null) {
  const candidates = collectSupportCandidates(levels, spot, tfSets);
  const picked = rankAndPickTop(candidates, spot, 'support', TOP_N);
  return picked.map((lvl, index) => ({
    ...lvl,
    friendlyLabel: labelSupportRank(index, picked.length, lvl),
    sourceName: lvl.name,
    why: supportWhy(lvl),
  }));
}

/**
 * @deprecated alias — same as pickTopSupports (Top 5).
 */
export function pickKeySupports(levels, spot, tfSets = null) {
  return pickTopSupports(levels, spot, tfSets);
}

/**
 * Suggest stop-loss prices aligned with the condensed Top supports.
 * Returns { candidates, primaryId } for dad-friendly stop UI.
 */
export function suggestStops(levels, spot, coins, avgCost, tfSets = null) {
  if (!Number.isFinite(spot) || spot <= 0) {
    return { candidates: [], primaryId: null };
  }

  const unique = pickTopSupports(levels, spot, tfSets);
  if (!unique.length) {
    return { candidates: [], primaryId: null };
  }

  const c = Number.isFinite(coins) && coins > 0 ? coins : 0;
  const costPer = Number.isFinite(avgCost) && avgCost > 0 ? avgCost : null;

  const candidates = unique.map((lvl, index) => {
    const distPct = ((lvl.price - spot) / spot) * 100; // negative below
    const distPctBelow = Math.abs(distPct);
    const riskVsSpot = c > 0 ? c * (lvl.price - spot) : null;
    const riskVsCost =
      c > 0 && costPer != null ? c * (lvl.price - costPer) : null;
    return {
      id: lvl.id,
      name: lvl.sourceName || lvl.name,
      price: lvl.price,
      distPct,
      distPctBelow,
      riskVsSpot,
      riskVsCost,
      label: stopLabelFromFriendly(lvl.friendlyLabel, index, unique.length),
      friendlyLabel: lvl.friendlyLabel,
      why: lvl.why,
    };
  });

  // Primary: closest support ≥ ~3% below spot (noise buffer); else nearest.
  const primary =
    candidates.find((x) => x.distPctBelow >= MIN_MEANINGFUL_PCT) ||
    candidates[0] ||
    null;

  return {
    candidates,
    primaryId: primary?.id ?? null,
  };
}

/** Preferred resistance ids when building trim / take-profit candidates. */
const RESIST_PREFER_IDS = [
  'swing_high',
  'p75',
  'roll20_high',
  'mean_plus_1s',
  'median',
  'roll50_high',
  'range_high',
];

const MIN_RESIST_PCT = 2; // prefer ≥2% above spot for primary trim

function resistFriendlyLabel(index, total, id) {
  if (id === 'swing_high') return 'Swing high (recent peak)';
  if (id === 'p75') return 'Upper zone (75th pct)';
  if (id === 'roll20_high') return '20-day high';
  if (id === 'roll50_high') return '50-day high';
  if (id === 'range_high') return 'Lookback high';
  if (id === 'mean_plus_1s') return 'Mean + 1σ stretch';
  if (id === 'median') return 'Median close';
  if (index === 0) return 'Nearest resistance';
  if (index === total - 1) return 'Farther resistance';
  return 'Next resistance';
}

/**
 * Suggest resistance / trim zones above spot with upside math.
 * Returns { candidates, primaryId, targetNote }.
 */
export function suggestResistance(
  levels,
  spot,
  coins,
  avgCost,
  targetPrice = null,
) {
  if (!Number.isFinite(spot) || spot <= 0 || !levels?.length) {
    return { candidates: [], primaryId: null, targetNote: null };
  }

  const above = levels
    .filter(
      (l) =>
        Number.isFinite(l.price) &&
        l.price > 0 &&
        l.price > spot * 1.002 &&
        (l.type === 'resistance' || l.price > spot),
    )
    .sort((a, b) => a.price - b.price); // nearest first

  if (!above.length) {
    return { candidates: [], primaryId: null, targetNote: null };
  }

  const picked = [];
  const used = new Set();

  for (const id of RESIST_PREFER_IDS) {
    const hit = above.find((l) => l.id === id && !used.has(l.id));
    if (hit) {
      picked.push(hit);
      used.add(hit.id);
    }
  }
  for (const l of above) {
    if (picked.length >= 5) break;
    if (used.has(l.id)) continue;
    const near = picked.some(
      (p) => Math.abs(p.price - l.price) / spot < 0.01,
    );
    if (near) continue;
    picked.push(l);
    used.add(l.id);
  }

  if (!used.has(above[0].id)) {
    picked.unshift(above[0]);
  }

  picked.sort((a, b) => a.price - b.price);
  const unique = [];
  for (const l of picked) {
    if (unique.length >= 5) break;
    const near = unique.some(
      (p) => Math.abs(p.price - l.price) / spot < 0.008,
    );
    if (!near) unique.push(l);
  }

  const c = Number.isFinite(coins) && coins > 0 ? coins : 0;
  const costPer = Number.isFinite(avgCost) && avgCost > 0 ? avgCost : null;
  const hasTarget =
    Number.isFinite(targetPrice) && targetPrice > 0 ? targetPrice : null;

  const candidates = unique.map((lvl, index) => {
    const distPct = ((lvl.price - spot) / spot) * 100;
    const upsideVsSpot = c > 0 ? c * (lvl.price - spot) : null;
    const upsideVsCost =
      c > 0 && costPer != null ? c * (lvl.price - costPer) : null;
    const towardTarget =
      hasTarget != null
        ? {
            targetDistPct: ((lvl.price - hasTarget) / hasTarget) * 100,
            dollarsFromTarget:
              c > 0 ? c * (lvl.price - hasTarget) : null,
          }
        : null;

    return {
      id: lvl.id,
      name: lvl.name,
      price: lvl.price,
      distPct,
      upsideVsSpot,
      upsideVsCost,
      towardTarget,
      label: resistFriendlyLabel(index, unique.length, lvl.id),
    };
  });

  // Primary trim: closest resistance to user's target if set & above spot;
  // else nearest meaningful resistance (≥ ~2% above).
  let primary = null;
  if (hasTarget != null && hasTarget > spot) {
    primary = [...candidates].sort(
      (a, b) =>
        Math.abs(a.price - hasTarget) - Math.abs(b.price - hasTarget),
    )[0];
  }
  if (!primary) {
    primary =
      candidates.find((x) => x.distPct >= MIN_RESIST_PCT) ||
      candidates[0] ||
      null;
  }

  let targetNote = null;
  if (hasTarget != null) {
    const nearest = [...above].sort(
      (a, b) =>
        Math.abs(a.price - hasTarget) - Math.abs(b.price - hasTarget),
    )[0];
    if (nearest) {
      const pct = ((nearest.price - hasTarget) / hasTarget) * 100;
      targetNote = {
        targetPrice: hasTarget,
        nearestResistance: nearest.price,
        nearestName: nearest.name,
        distPct: pct,
      };
    }
  }

  return {
    candidates,
    primaryId: primary?.id ?? null,
    targetNote,
  };
}


/** Find local swing highs (peaks) with `lookback` bars on each side. */
export function findSwingHighs(values, lookback = 5) {
  if (!values || values.length < lookback * 2 + 1) return [];
  const peaks = [];
  for (let i = lookback; i < values.length - lookback; i += 1) {
    const c = values[i];
    if (!Number.isFinite(c)) continue;
    let isHigh = true;
    for (let j = 1; j <= lookback; j += 1) {
      if (values[i - j] >= c || values[i + j] >= c) {
        isHigh = false;
        break;
      }
    }
    if (isHigh) peaks.push({ index: i, price: c });
  }
  return peaks;
}

/**
 * Resistance-oriented levels for a single timeframe lookback.
 * Labels include the TF prefix (e.g. "6M high").
 */
export function computeTfResistanceLevels(dailyBars, spot, tfKey, tfShortLabel) {
  if (!dailyBars?.length) return [];

  const closes = dailyBars.map((b) => b.close).filter(Number.isFinite);
  const highs = dailyBars
    .map((b) => (Number.isFinite(b.high) ? b.high : b.close))
    .filter(Number.isFinite);
  if (!closes.length) return [];

  const prefix = tfShortLabel || tfKey;
  const periodHigh = highs.length ? Math.max(...highs) : Math.max(...closes);
  const p75Highs = percentile(highs.length ? highs : closes, 0.75);
  const p50Closes = median(closes);
  const lookback = Math.min(5, Math.max(2, Math.floor(closes.length / 40)));
  const peaks = findSwingHighs(highs.length ? highs : closes, lookback);

  // Most recent swing high
  const recentSwing = peaks.length ? peaks[peaks.length - 1].price : null;

  // Prior major peaks: top distinct highs excluding the period high itself
  const majorPeaks = [...peaks]
    .sort((a, b) => b.price - a.price)
    .filter((p) => periodHigh == null || p.price < periodHigh * 0.998);

  const candidates = [
    {
      id: `${tfKey}_high`,
      name: `${prefix} high`,
      price: periodHigh,
      kind: 'period_high',
      strength: 3,
    },
    {
      id: `${tfKey}_swing`,
      name: `${prefix} swing high`,
      price: recentSwing,
      kind: 'swing_high',
      strength: 2,
    },
    {
      id: `${tfKey}_p75`,
      name: `${prefix} 75th pct`,
      price: p75Highs,
      kind: 'percentile',
      strength: 1,
    },
    {
      id: `${tfKey}_median`,
      name: `${prefix} median close`,
      price: p50Closes,
      kind: 'median',
      strength: 1,
    },
  ];

  // Up to 2 prior major peaks (distinct from period high / recent swing)
  majorPeaks.slice(0, 4).forEach((p, i) => {
    candidates.push({
      id: `${tfKey}_peak_${i}`,
      name: i === 0 ? `${prefix} major peak` : `${prefix} prior peak`,
      price: p.price,
      kind: 'major_peak',
      strength: 2,
    });
  });

  const seen = [];
  const levels = [];
  for (const c of candidates) {
    if (c.price == null || !Number.isFinite(c.price) || c.price <= 0) continue;
    const dup = seen.some((p) => Math.abs(p - c.price) / c.price < 0.004);
    if (dup) continue;
    seen.push(c.price);
    levels.push({
      ...c,
      tfKey,
      tfLabel: prefix,
      type: classify(c.price, spot),
    });
  }

  levels.sort((a, b) => a.price - b.price);
  return levels;
}

const TF_WEIGHT = { '5y': 3, '1y': 2.2, '6m': 1.2 };

function enrichLevel(lvl, spot, coins, avgCost, targetPrice) {
  const distPct = Number.isFinite(spot) && spot > 0
    ? ((lvl.price - spot) / spot) * 100
    : null;
  const c = Number.isFinite(coins) && coins > 0 ? coins : 0;
  const upsideVsSpot = c > 0 && Number.isFinite(spot) ? c * (lvl.price - spot) : null;
  const upsideVsCost =
    c > 0 && Number.isFinite(avgCost) && avgCost > 0 ? c * (lvl.price - avgCost) : null;
  const hasTarget =
    Number.isFinite(targetPrice) && targetPrice > 0 ? targetPrice : null;
  const towardTarget =
    hasTarget != null
      ? {
          targetDistPct: ((lvl.price - hasTarget) / hasTarget) * 100,
          dollarsFromTarget: c > 0 ? c * (lvl.price - hasTarget) : null,
        }
      : null;

  return {
    ...lvl,
    distPct,
    upsideVsSpot,
    upsideVsCost,
    towardTarget,
    aboveSpot:
      Number.isFinite(spot) &&
      Number.isFinite(lvl.price) &&
      lvl.price > spot * 1.002,
  };
}

/**
 * Top resistances above spot (max 5), mixing multi-TF highs + short chart levels.
 * Each item enriched with distPct / upside + friendlyLabel + why.
 */
export function pickTopResistances(
  tfSets,
  spot,
  coins,
  avgCost,
  targetPrice = null,
  chartLevels = null,
) {
  if (!Number.isFinite(spot) || spot <= 0) return [];

  const candidates = [];

  if (tfSets) {
    for (const key of ['6m', '1y', '5y']) {
      const set = tfSets[key];
      if (!set?.bars?.length) continue;
      const raw = computeTfResistanceLevels(
        set.bars,
        spot,
        key,
        set.shortLabel,
      );
      for (const l of raw) {
        if (Number.isFinite(l.price) && l.price > spot * 1.002) {
          candidates.push(l);
        }
      }
    }
  }

  // Mix in short-chart resistance markers when available
  if (chartLevels?.length) {
    for (const l of resistanceLevels(chartLevels, spot)) {
      candidates.push({ ...l, tfKey: l.tfKey || 'chart' });
    }
  }

  const picked = rankAndPickTop(candidates, spot, 'resistance', TOP_N);
  return picked.map((lvl, index) => {
    const enriched = enrichLevel(lvl, spot, coins, avgCost, targetPrice);
    return {
      ...enriched,
      friendlyLabel: labelResistanceRank(index, picked.length, lvl),
      sourceName: lvl.name,
      why: resistanceWhy(lvl),
      label: labelResistanceRank(index, picked.length, lvl),
    };
  });
}

/**
 * Build multi-timeframe resistance view for the Resistance panel.
 * `tfSets`: { '6m': { bars, shortLabel, name, ... }, '1y': ..., '5y': ... }
 */
export function buildMultiTfResistance(
  tfSets,
  spot,
  coins,
  avgCost,
  targetPrice = null,
) {
  const empty = {
    groups: [],
    comparison: [],
    primary: null,
    nearAth: false,
    athNote: null,
    targetNote: null,
    allAbove: [],
    topLevels: [],
  };

  if (!tfSets || !Number.isFinite(spot) || spot <= 0) return empty;

  const order = ['6m', '1y', '5y'];
  const groups = [];
  const comparison = [];
  const allAbove = [];

  for (const key of order) {
    const set = tfSets[key];
    if (!set?.bars?.length) continue;

    const raw = computeTfResistanceLevels(
      set.bars,
      spot,
      key,
      set.shortLabel,
    );
    const enriched = raw.map((l) =>
      enrichLevel(l, spot, coins, avgCost, targetPrice),
    );
    const above = enriched
      .filter((l) => l.aboveSpot)
      .sort((a, b) => a.price - b.price);
    const periodHigh = enriched.find((l) => l.kind === 'period_high') || null;

    groups.push({
      key,
      shortLabel: set.shortLabel,
      name: set.name,
      capped: Boolean(set.capped),
      barCount: set.bars.length,
      levels: above,
      allLevels: enriched,
      periodHigh,
      blurb: tfBlurb(key, set.shortLabel, set.capped),
    });

    if (periodHigh) {
      comparison.push({
        key,
        shortLabel: set.shortLabel,
        name: set.name,
        price: periodHigh.price,
        distPct: periodHigh.distPct,
        upsideVsSpot: periodHigh.upsideVsSpot,
        aboveSpot: periodHigh.aboveSpot,
      });
    }

    for (const l of above) allAbove.push(l);
  }

  // Near ATH: no (or almost no) resistance above spot on the longest TF
  const longGroup = groups.find((g) => g.key === '5y') || groups[groups.length - 1];
  let nearAth = false;
  let athNote = null;
  if (longGroup?.periodHigh) {
    const high = longGroup.periodHigh.price;
    const pctBelow = ((high - spot) / spot) * 100;
    if (pctBelow <= 2) {
      nearAth = true;
      athNote =
        pctBelow <= 0.5
          ? `Spot is at / above the ${longGroup.shortLabel} high (${formatLevelPrice(high)}) — little historical ceiling left in this lookback.`
          : `Spot is within ~${pctBelow.toFixed(1)}% of the ${longGroup.shortLabel} high — near the top of available history.`;
    } else if (!longGroup.levels.length) {
      nearAth = true;
      athNote = `No clear resistance above spot in the ${longGroup.shortLabel} window — price may be pressing highs.`;
    }
  }

  // Primary trim: prefer longer TF significance, nearest strong level above spot
  let primary = pickPrimaryResistance(allAbove, spot, targetPrice);

  let targetNote = null;
  const hasTarget =
    Number.isFinite(targetPrice) && targetPrice > 0 ? targetPrice : null;
  if (hasTarget != null && allAbove.length) {
    const nearest = [...allAbove].sort(
      (a, b) => Math.abs(a.price - hasTarget) - Math.abs(b.price - hasTarget),
    )[0];
    if (nearest) {
      targetNote = {
        targetPrice: hasTarget,
        nearestResistance: nearest.price,
        nearestName: nearest.name,
        distPct: ((nearest.price - hasTarget) / hasTarget) * 100,
      };
    }
  }

  const topLevels = pickTopResistances(
    tfSets,
    spot,
    coins,
    avgCost,
    targetPrice,
  );

  // Prefer primary from condensed list when available
  if (topLevels.length) {
    const hasTarget =
      Number.isFinite(targetPrice) && targetPrice > spot ? targetPrice : null;
    let primaryFromTop = null;
    if (hasTarget != null) {
      primaryFromTop = [...topLevels].sort(
        (a, b) =>
          Math.abs(a.price - hasTarget) - Math.abs(b.price - hasTarget),
      )[0];
    }
    if (!primaryFromTop) {
      primaryFromTop =
        topLevels.find((x) => (x.distPct ?? 0) >= 2) || topLevels[0];
    }
    primary = primaryFromTop;
  }

  return {
    groups,
    comparison,
    primary,
    nearAth,
    athNote,
    targetNote,
    allAbove,
    topLevels,
  };
}

function formatLevelPrice(n) {
  if (!Number.isFinite(n)) return '—';
  if (n >= 100) return `$${n.toFixed(2)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}

function tfBlurb(key, shortLabel, capped) {
  if (key === '6m') {
    return '6-month high = the best price sellers got in the last half-year — first ceiling many traders watch.';
  }
  if (key === '1y') {
    return '1-year high = hasn’t cleared this in a year — stronger resistance than a short chart wiggle.';
  }
  if (capped) {
    return `${shortLabel} high = best available long history (free APIs often can’t go a full 5 years on crypto). Still a serious ceiling if you’re below it.`;
  }
  return '5-year high = price hasn’t cleared this in years — strong resistance if still below it.';
}

/**
 * Prefer nearest strong level above spot, weighted toward 1Y / 5Y+.
 */
export function pickPrimaryResistance(levelsAbove, spot, targetPrice = null) {
  if (!levelsAbove?.length || !Number.isFinite(spot) || spot <= 0) return null;

  const hasTarget =
    Number.isFinite(targetPrice) && targetPrice > spot ? targetPrice : null;

  // Prefer period highs and major peaks from longer TFs
  const scored = levelsAbove.map((l) => {
    const distPct = Math.max(0.01, ((l.price - spot) / spot) * 100);
    const tfW = TF_WEIGHT[l.tfKey] || 1;
    const kindW =
      l.kind === 'period_high' ? 1.4 : l.kind === 'major_peak' || l.kind === 'swing_high' ? 1.15 : 1;
    // Lower score = better. Distance penalty + inverse TF weight.
    let score = distPct / (tfW * kindW);
    // Soft preference: not absurdly far (>40%) unless it's the only option
    if (distPct > 40) score *= 1.35;
    if (hasTarget != null) {
      const tDist = Math.abs(l.price - hasTarget) / spot * 100;
      score = score * 0.65 + tDist * 0.35;
    }
    return { level: l, score };
  });

  scored.sort((a, b) => a.score - b.score);
  // Prefer ≥ ~2% above when available among top scores
  const meaningful = scored.find((s) => s.level.distPct >= 2);
  return (meaningful || scored[0]).level;
}
