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

/** Preferred ids when choosing the strong / key support. */
const KEY_SUPPORT_IDS = [
  'swing_low',
  'p25',
  'roll20_low',
  'mean_minus_1s',
  'median',
];

/** Preferred ids for a wider structural floor. */
const WIDER_SUPPORT_IDS = [
  'range_low',
  'roll50_low',
  'mean_minus_1s',
  'p25',
  'swing_low',
];

const MIN_MEANINGFUL_PCT = 3; // prefer ≥3% below spot for primary stop
const DEDUPE_PCT = 0.01; // ~1% of spot = near-identical

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
  if (index === total - 1) return 'Wider stop (stronger support)';
  return 'Mid stop (next support)';
}

/**
 * Pick ~2–4 key supports below spot for the Support panel and stops.
 * Prefers nearest floor, a strong/primary trough (swing / p25 / multi-week low),
 * and optionally one wider structural support. Dedupes near-identical prices.
 *
 * Each item: { ...level, friendlyLabel, sourceName }.
 */
export function pickKeySupports(levels, spot) {
  const below = supportLevels(levels, spot);
  if (!below.length || !Number.isFinite(spot) || spot <= 0) return [];

  // Deduplicate near-identical prices (keep first = nearest-first order)
  const deduped = [];
  for (const l of below) {
    if (deduped.some((p) => isNear(p.price, l.price, spot))) continue;
    deduped.push(l);
  }
  if (!deduped.length) return [];

  const nearest = deduped[0];

  // Key / strong support: prefer familiar trough markers, ideally ≥3% below
  let key = null;
  for (const id of KEY_SUPPORT_IDS) {
    const hit = deduped.find(
      (l) => l.id === id && !isNear(l.price, nearest.price, spot),
    );
    if (!hit) continue;
    key = hit;
    const pctBelow = ((spot - hit.price) / spot) * 100;
    if (pctBelow >= MIN_MEANINGFUL_PCT) break;
  }
  if (!key) {
    key = deduped.find((l) => {
      if (isNear(l.price, nearest.price, spot)) return false;
      return ((spot - l.price) / spot) * 100 >= MIN_MEANINGFUL_PCT;
    });
  }
  if (!key) {
    key = deduped.find((l) => !isNear(l.price, nearest.price, spot)) || null;
  }

  const used = [nearest.price];
  if (key) used.push(key.price);

  // Wider structural support — farthest meaningful distinct floor
  let wider = null;
  for (const id of WIDER_SUPPORT_IDS) {
    const hit = deduped.find(
      (l) =>
        l.id === id && used.every((p) => !isNear(p, l.price, spot, 0.012)),
    );
    if (hit) {
      wider = hit;
      break;
    }
  }
  if (!wider) {
    for (let i = deduped.length - 1; i >= 0; i -= 1) {
      const l = deduped[i];
      if (used.every((p) => !isNear(p, l.price, spot, 0.015))) {
        wider = l;
        break;
      }
    }
  }

  const picked = [];
  const push = (lvl, friendlyLabel) => {
    if (!lvl) return;
    if (picked.some((p) => isNear(p.price, lvl.price, spot))) return;
    if (picked.length >= 4) return;
    picked.push({
      ...lvl,
      friendlyLabel,
      sourceName: lvl.name,
    });
  };

  push(nearest, 'Nearest support');
  if (key) push(key, 'Key support');
  if (wider) push(wider, 'Wider support');

  // If only nearest so far but more distinct levels exist, add one more
  if (picked.length === 1) {
    const extra = deduped.find((l) => !isNear(l.price, picked[0].price, spot));
    if (extra) push(extra, 'Key support');
  }

  // Optional mid between key and wider when gap is large and we have room
  if (picked.length === 2 && deduped.length >= 3) {
    const hi = picked[0].price;
    const lo = picked[picked.length - 1].price;
    const mid = deduped.find((l) => {
      if (picked.some((p) => isNear(p.price, l.price, spot))) return false;
      return l.price < hi && l.price > lo;
    });
    if (mid && ((hi - lo) / spot) >= 0.06) {
      push(mid, 'Next support');
    }
  }

  picked.sort((a, b) => b.price - a.price);

  // Normalize dad-friendly labels by rank
  if (picked.length === 2) {
    picked[0].friendlyLabel = 'Nearest support';
    picked[1].friendlyLabel = 'Key support';
  } else if (picked.length === 3) {
    picked[0].friendlyLabel = 'Nearest support';
    picked[1].friendlyLabel = 'Key support';
    picked[2].friendlyLabel = 'Wider support';
  } else if (picked.length >= 4) {
    picked[0].friendlyLabel = 'Nearest support';
    picked[1].friendlyLabel = 'Key support';
    picked[2].friendlyLabel = 'Next support';
    picked[3].friendlyLabel = 'Wider support';
  }

  return picked.slice(0, 4);
}

/**
 * Suggest stop-loss prices aligned with the simplified key supports.
 * Returns { candidates, primaryId } for dad-friendly stop UI.
 */
export function suggestStops(levels, spot, coins, avgCost) {
  if (!Number.isFinite(spot) || spot <= 0 || !levels?.length) {
    return { candidates: [], primaryId: null };
  }

  const unique = pickKeySupports(levels, spot);
  if (!unique.length) {
    return { candidates: [], primaryId: null };
  }

  const c = Number.isFinite(coins) && coins > 0 ? coins : 0;
  const costPer = Number.isFinite(avgCost) ? avgCost : null;

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
  const costPer = Number.isFinite(avgCost) ? avgCost : null;
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
    c > 0 && Number.isFinite(avgCost) ? c * (lvl.price - avgCost) : null;
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

  return {
    groups,
    comparison,
    primary,
    nearAth,
    athNote,
    targetNote,
    allAbove,
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
