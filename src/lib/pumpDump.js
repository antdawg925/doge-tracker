/**
 * Pump-and-dump recognition:
 * 1) Known-list match (user-supplied historical P&D names)
 * 2) Chart-history lookalike: old vertical spike, then long fade / grind-down
 */

/** Cleaned tickers from the user's historical pump list (deduped). */
export const KNOWN_PUMP_DUMP_TICKERS = [
  'ARKBKF',
  'INDP',
  'CRK',
  'UNG',
  'OPAD',
  'CANO',
  'LIFE',
  'ILUS',
  'JCS',
  'SWRM',
  'GTXO',
  'LCLP',
  'DFTC',
  'KXIN',
  'AHPI', // from "ahpitedu" (likely AHPI + TEDU run together)
  'TEDU',
  'ZEV',
  'FULC',
  'CWBR',
  'LITB',
  'PBTS',
  'SESN',
  'ANY',
  'NAOV',
  'PMCB',
  'AZRX',
  'SONN',
  'TSOI',
  'CYBL',
];

const KNOWN_SET = new Set(
  KNOWN_PUMP_DUMP_TICKERS.map((t) => String(t).toUpperCase()),
);

/** Normalize Yahoo / OTC symbols for list matching (strip class / exchange suffixes). */
export function normalizeTicker(symbol) {
  if (!symbol) return '';
  return String(symbol)
    .toUpperCase()
    .trim()
    .replace(/\s+/g, '')
    .split('.')[0]
    .split('-')[0];
}

export function isKnownPumpDump(asset) {
  if (!asset || asset.type === 'crypto') return false;
  const sym = normalizeTicker(asset.symbol);
  return Boolean(sym && KNOWN_SET.has(sym));
}

function barHigh(b) {
  const h = Number(b?.high ?? b?.close);
  return Number.isFinite(h) ? h : null;
}

function barLow(b) {
  const l = Number(b?.low ?? b?.close);
  return Number.isFinite(l) ? l : null;
}

function barClose(b) {
  const c = Number(b?.close);
  return Number.isFinite(c) ? c : null;
}

function barTime(b) {
  const t = Number(b?.t ?? b?.time);
  return Number.isFinite(t) ? t : null;
}

/**
 * Detect classic "old pump → long fade" structure on daily bars.
 * Tuned to: huge vertical move months/years ago, then 50–90%+ drawdown
 * and continued grind lower (stage-7 style), not a fresh V-recovery.
 *
 * @returns {{ hit: boolean, confidence: 'high'|'med'|'low'|null, reasons: string[], metrics: object|null }}
 */
export function detectPumpDumpPattern(longBars) {
  const empty = { hit: false, confidence: null, reasons: [], metrics: null };
  if (!longBars?.length || longBars.length < 120) return empty;

  const closes = longBars.map(barClose);
  const highs = longBars.map(barHigh);
  const n = longBars.length;
  const last = n - 1;
  const spot = closes[last];
  if (!Number.isFinite(spot) || spot <= 0) return empty;

  // Peak must be in the older part of the series (not the last ~4 months)
  const minPeakAgeBars = Math.min(90, Math.floor(n * 0.25));
  const peakSearchEnd = Math.max(40, n - minPeakAgeBars);
  let peakIdx = 0;
  let peakHigh = -Infinity;
  for (let i = 0; i < peakSearchEnd; i += 1) {
    const h = highs[i];
    if (Number.isFinite(h) && h > peakHigh) {
      peakHigh = h;
      peakIdx = i;
    }
  }
  if (!(peakHigh > 0) || peakIdx < 20) return empty;

  const drawdown = (peakHigh - spot) / peakHigh;
  if (!(drawdown >= 0.5)) return empty; // need ≥50% off the old high

  // Vertical run into the peak: best gain over ~15–60 sessions before peak
  let runGain = 0;
  const runLookbacks = [15, 30, 45, 60];
  for (const lb of runLookbacks) {
    const start = Math.max(0, peakIdx - lb);
    const base = closes[start];
    if (!Number.isFinite(base) || base <= 0) continue;
    const g = (peakHigh - base) / base;
    if (g > runGain) runGain = g;
  }
  // Stocks: require a real parabolic leg (≥100%). Crypto-ish names can be wilder.
  if (!(runGain >= 1.0)) return empty;

  // Peak age in calendar days when timestamps exist
  const tPeak = barTime(longBars[peakIdx]);
  const tNow = barTime(longBars[last]);
  let peakAgeDays = n - 1 - peakIdx; // bar count fallback
  if (Number.isFinite(tPeak) && Number.isFinite(tNow) && tNow > tPeak) {
    peakAgeDays = Math.round((tNow - tPeak) / 86_400_000);
  }

  // Prefer peaks ≥ ~6 months old; require ≥ ~4 months
  if (peakAgeDays < 120) return empty;

  // After the peak: still fading — lower highs / not reclaiming most of the spike
  const post = longBars.slice(peakIdx);
  let postMax = -Infinity;
  for (const b of post) {
    const h = barHigh(b);
    if (Number.isFinite(h)) postMax = Math.max(postMax, h);
  }
  const reclaim = postMax > 0 ? (postMax - spot) / (postMax - (barLow(longBars[peakIdx]) || spot)) : 0;
  // Recent half of post-peak history should not be making new highs near the pump
  const mid = peakIdx + Math.floor((n - 1 - peakIdx) / 2);
  let lateHigh = -Infinity;
  for (let i = mid; i < n; i += 1) {
    const h = highs[i];
    if (Number.isFinite(h)) lateHigh = Math.max(lateHigh, h);
  }
  const lateOffPeak = lateHigh > 0 ? (peakHigh - lateHigh) / peakHigh : 0;

  // Yearly-ish fade: compare ~252 bars ago close vs now when available
  let yearFade = null;
  if (n > 260) {
    const yAgo = closes[n - 252];
    if (Number.isFinite(yAgo) && yAgo > 0) {
      yearFade = (yAgo - spot) / yAgo;
    }
  }

  const reasons = [];
  reasons.push(
    `Off old high about ${(drawdown * 100).toFixed(0)}% (peak ≈ ${peakAgeDays}d ago)`,
  );
  reasons.push(
    `Prior run into that high was about +${(runGain * 100).toFixed(0)}% (vertical / parabolic leg)`,
  );
  if (yearFade != null && yearFade >= 0.4) {
    reasons.push(
      `Roughly ${(yearFade * 100).toFixed(0)}% lower than ~1 year ago (ongoing fade)`,
    );
  }
  if (lateOffPeak >= 0.35) {
    reasons.push('Later highs failed well below the old pump peak (grind / fade)');
  }

  // Score confidence
  let score = 0;
  if (drawdown >= 0.7) score += 2;
  else if (drawdown >= 0.5) score += 1;
  if (runGain >= 2.0) score += 2;
  else if (runGain >= 1.0) score += 1;
  if (peakAgeDays >= 365) score += 2;
  else if (peakAgeDays >= 180) score += 1;
  if (yearFade != null && yearFade >= 0.5) score += 1;
  if (lateOffPeak >= 0.4) score += 1;
  // Penalize if price has reclaimed most of the spike (not a dump leftover)
  if (spot > peakHigh * 0.55) score -= 2;

  if (score < 4) return empty;

  const confidence = score >= 7 ? 'high' : score >= 5 ? 'med' : 'low';
  // Require at least med for an auto banner (avoid noisy lows)
  if (confidence === 'low') return empty;

  return {
    hit: true,
    confidence,
    reasons,
    metrics: {
      peakHigh,
      peakAgeDays,
      drawdown,
      runGain,
      yearFade,
      lateOffPeak,
      reclaim,
      score,
    },
  };
}

/**
 * Combined assessment for the Desk banner.
 * @returns {{ show: boolean, source: 'known_list'|'chart_pattern'|null, title: string, detail: string, confidence: string|null, reasons: string[] }}
 */
export function assessPumpDump(asset, longBars) {
  const known = isKnownPumpDump(asset);
  if (known) {
    return {
      show: true,
      source: 'known_list',
      title: 'Pump and Dumper BEWARE!',
      detail:
        'This ticker is on your historical pump-and-dump reference list. Treat it as a fade / avoid for momentum longs unless you have a clear short thesis.',
      confidence: 'high',
      reasons: ['Matched your known pump-and-dump list'],
    };
  }

  // Pattern scan for stocks (and crypto if long history exists)
  const pattern = detectPumpDumpPattern(longBars);
  if (pattern.hit) {
    return {
      show: true,
      source: 'chart_pattern',
      title: 'Pump and Dumper BEWARE!',
      detail:
        'Chart history looks like an old vertical pump followed by a long fade — similar to classic pump-and-dump leftovers (not a guarantee).',
      confidence: pattern.confidence,
      reasons: pattern.reasons,
    };
  }

  return {
    show: false,
    source: null,
    title: '',
    detail: '',
    confidence: null,
    reasons: [],
  };
}
