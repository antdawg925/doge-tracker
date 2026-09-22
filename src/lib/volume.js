/** Daily volume helpers: RVOL, labels, short trend hints. */

/**
 * True if a bar has a usable volume number (> 0 preferred; 0 counts as present).
 */
export function barHasVolume(bar) {
  return bar != null && Number.isFinite(bar.volume) && bar.volume >= 0;
}

/** Count of bars with volume in the series. */
export function volumeCoverage(bars) {
  if (!bars?.length) return { withVol: 0, total: 0, ratio: 0 };
  let withVol = 0;
  for (const b of bars) {
    if (barHasVolume(b) && b.volume > 0) withVol += 1;
  }
  return {
    withVol,
    total: bars.length,
    ratio: bars.length ? withVol / bars.length : 0,
  };
}

/**
 * Mean of the last `n` volumes ending at `endIndex` (inclusive),
 * skipping bars without volume. Returns null if fewer than `min` samples.
 */
export function meanVolume(bars, endIndex, n, min = 1) {
  if (!bars?.length || n < 1) return null;
  const end = Math.min(endIndex, bars.length - 1);
  if (end < 0) return null;
  const vals = [];
  for (let i = end; i >= 0 && vals.length < n; i -= 1) {
    const v = bars[i]?.volume;
    if (Number.isFinite(v) && v >= 0) vals.push(v);
  }
  if (vals.length < min) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/**
 * Dad-friendly RVOL bands.
 * Quiet <0.7 · Normal 0.7–1.3 · Elevated 1.3–3 · Very high >3
 */
export function rvolLabel(rvol) {
  if (rvol == null || !Number.isFinite(rvol)) return null;
  if (rvol < 0.7) return { key: 'quiet', text: 'Quiet' };
  if (rvol < 1.3) return { key: 'normal', text: 'Normal' };
  if (rvol < 3) return { key: 'elevated', text: 'Elevated' };
  return { key: 'very-high', text: 'Very high' };
}

/**
 * Compare recent ~window sessions vs the prior window.
 * Returns { direction: 'rising'|'falling'|'flat', text, ratio }.
 */
export function volumeTrend(bars, window = 7) {
  if (!bars?.length) return null;
  const lastIdx = bars.length - 1;
  const recent = meanVolume(bars, lastIdx, window, Math.min(3, window));
  const priorEnd = lastIdx - window;
  if (priorEnd < 0) return null;
  const prior = meanVolume(bars, priorEnd, window, Math.min(3, window));
  if (recent == null || prior == null || prior <= 0) return null;
  const ratio = recent / prior;
  if (ratio >= 1.15) {
    return { direction: 'rising', text: 'Volume rising lately', ratio };
  }
  if (ratio <= 0.85) {
    return { direction: 'falling', text: 'Volume fading lately', ratio };
  }
  return { direction: 'flat', text: 'Volume about steady', ratio };
}

/**
 * Build metrics for the metrics strip from daily bars.
 * Uses latest bar with volume; 20-day average of prior bars when possible.
 */
export function computeVolumeMetrics(bars) {
  if (!bars?.length) {
    return { available: false, reason: 'no-bars' };
  }

  const coverage = volumeCoverage(bars);
  if (coverage.withVol < 5) {
    return {
      available: false,
      reason: 'no-volume',
      coverage,
    };
  }

  // Prefer the last bar that has volume (in case latest is partial/missing)
  let latestIdx = -1;
  for (let i = bars.length - 1; i >= 0; i -= 1) {
    if (barHasVolume(bars[i]) && bars[i].volume > 0) {
      latestIdx = i;
      break;
    }
  }
  if (latestIdx < 0) {
    return { available: false, reason: 'no-volume', coverage };
  }

  const latest = bars[latestIdx].volume;
  // Avg of up to 20 prior bars (exclude latest for cleaner RVOL)
  const avgEnd = latestIdx - 1;
  let avg20 = avgEnd >= 0 ? meanVolume(bars, avgEnd, 20, 5) : null;
  if (avg20 == null) {
    // Fall back to including latest if history is short
    avg20 = meanVolume(bars, latestIdx, 20, 5);
  }

  const rvol = avg20 && avg20 > 0 ? latest / avg20 : null;
  const label = rvolLabel(rvol);
  const trend = volumeTrend(bars, 7);

  return {
    available: true,
    latest,
    avg20,
    rvol,
    label,
    trend,
    coverage,
    date: bars[latestIdx].date || null,
  };
}
