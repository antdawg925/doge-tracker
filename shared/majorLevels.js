/**
 * Major levels (Research #6, v2): a few real supports / resistances from weekly + monthly
 * candles, a wide holding stop and a ratchet ladder. Pure and dependency-free (runs in node too).
 * The old per-timeframe level code in levels.js stays available; this replaces it on Research.
 *
 * 1. Pivots: weekly swing highs/lows (3 bars each side) + monthly (2 each side). Prices that
 *    reversed more than once cluster into one level. Merge distance = max(10%, 1 weekly ATR).
 * 2. Score = Σ pivot weight (monthly 2, weekly 1) × recency (3-year decay) × closeness to price.
 *    Pick 2–3 per side, best score first, never two within the merge distance.
 * 3. Holding stop = nearest major support − 1 weekly ATR (normal weekly swings don't hit it).
 * 4. Ladder: weekly close above resistance R → stop to R − 1 weekly ATR (steps up level by level).
 */

const WEEK_MS = 7 * 86400000;

export function weeklyAtr(bars, n = 14) {
  if (!bars?.length) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i += 1) {
    const b = bars[i];
    const pc = bars[i - 1].close;
    trs.push(Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc)));
  }
  const last = trs.slice(-n);
  return last.length ? last.reduce((a, x) => a + x, 0) / last.length : null;
}

/** Daily (or weekly) bars → calendar-week (Mon) / month candles. */
export function toPeriod(bars, period) {
  const map = new Map();
  for (const b of bars || []) {
    if (!Number.isFinite(b?.close) || !Number.isFinite(b?.t)) continue;
    const d = new Date(b.t);
    let key;
    if (period === 'month') key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
    else {
      const day = (d.getUTCDay() + 6) % 7;
      key = Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - day * 86400000) / 86400000);
    }
    const hi = Number.isFinite(b.high) ? b.high : b.close;
    const lo = Number.isFinite(b.low) ? b.low : b.close;
    const p = map.get(key);
    if (!p) map.set(key, { t: b.t, open: Number.isFinite(b.open) ? b.open : b.close, high: hi, low: lo, close: b.close });
    else {
      p.high = Math.max(p.high, hi);
      p.low = Math.min(p.low, lo);
      p.close = b.close;
      p.t = b.t;
    }
  }
  return [...map.values()].sort((a, b) => a.t - b.t);
}

function pivots(bars, k, weight, now) {
  const out = [];
  for (let i = k; i < bars.length - k; i += 1) {
    let hi = true;
    let lo = true;
    for (let j = i - k; j <= i + k; j += 1) {
      if (j === i) continue;
      if (bars[j].high >= bars[i].high) hi = false;
      if (bars[j].low <= bars[i].low) lo = false;
    }
    const ageW = Math.max(0, (now - bars[i].t) / WEEK_MS);
    const rec = Math.exp(-ageW / 156);
    if (hi) out.push({ price: bars[i].high, t: bars[i].t, w: weight, rec, weekly: weight === 1 });
    if (lo) out.push({ price: bars[i].low, t: bars[i].t, w: weight, rec, weekly: weight === 1 });
  }
  return out;
}

function cluster(points, tol) {
  const sorted = [...points].sort((a, b) => a.price - b.price);
  const groups = [];
  for (const p of sorted) {
    const g = groups[groups.length - 1];
    if (g && p.price <= g.low * (1 + tol)) {
      g.pts.push(p);
    } else groups.push({ low: p.price, pts: [p] });
  }
  return groups.map((g) => {
    const wsum = g.pts.reduce((a, p) => a + p.w * (0.4 + 0.6 * p.rec), 0);
    const price = g.pts.reduce((a, p) => a + p.price * p.w * (0.4 + 0.6 * p.rec), 0) / wsum;
    const touches = Math.max(1, g.pts.filter((p) => p.weekly).length);
    const lastT = Math.max(...g.pts.map((p) => p.t));
    return { price, touches, monthly: g.pts.some((p) => !p.weekly), lastT, weight: wsum };
  });
}

function pick(cands, spot, tol, max) {
  const scored = cands.map((c) => ({ ...c, score: c.weight * Math.exp(-Math.abs(Math.log(c.price / spot)) / 0.4) }));
  const real = scored.filter((c) => c.touches >= 2 || c.monthly);
  const pool = (real.length >= 2 ? real : scored).sort((a, b) => b.score - a.score);
  const chosen = [];
  for (const c of pool) {
    if (chosen.length >= max) break;
    if (chosen.every((x) => Math.abs(Math.log(c.price / x.price)) >= Math.log(1 + tol))) chosen.push(c);
  }
  return chosen;
}

/**
 * weeklyBars: weekly OHLC (multi-year). spot, coins, avgCost: optional position.
 * Returns { atrW, tol, weeks, since, supports, resistances, holdingStop, ladder }.
 */
export function computeMajorPlan(weeklyBars, spot, { coins = 0, avgCost = null, now = Date.now(), max = 3 } = {}) {
  const bars = (weeklyBars || []).filter((b) => Number.isFinite(b.high) && Number.isFinite(b.low) && Number.isFinite(b.close));
  if (bars.length < 20 || !(spot > 0)) return null;
  const atrW = weeklyAtr(bars);
  const tol = Math.max(0.1, atrW / spot);
  const monthly = toPeriod(bars, 'month');
  const pts = [...pivots(bars, 3, 1, now), ...pivots(monthly, 2, 2, now)];
  const levels = cluster(pts, tol);
  const hasPos = coins > 0 && avgCost > 0;
  const vsCost = (px) => (hasPos ? coins * (px - avgCost) : null);
  const minGap = Math.max(0.01, (atrW / spot) * 0.25); // a level must be clearly above/below price
  const sup = pick(levels.filter((l) => l.price < spot * (1 - minGap) && l.price > spot * 0.3), spot, tol, max).sort((a, b) => b.price - a.price);
  const res = pick(levels.filter((l) => l.price > spot * (1 + minGap) && l.price < spot * 4), spot, tol, max).sort((a, b) => a.price - b.price);

  const s1 = sup[0]?.price ?? null;
  const stopPx = s1 ? s1 - atrW : spot - 2 * atrW;
  const holdingStop = stopPx > 0
    ? { price: stopPx, under: s1, distPct: (stopPx / spot - 1) * 100, riskVsCost: vsCost(stopPx) }
    : null;

  let prevStop = holdingStop?.price ?? 0;
  const ladder = [];
  for (const r of res) {
    const y = r.price - atrW;
    if (y <= prevStop) continue;
    ladder.push({ trigger: r.price, stop: y, lockVsCost: vsCost(y), stepPct: prevStop ? (y / prevStop - 1) * 100 : null });
    prevStop = y;
  }

  const row = (l, side) => ({
    price: l.price,
    touches: l.touches,
    monthly: l.monthly,
    lastT: l.lastT,
    distPct: (l.price / spot - 1) * 100,
    usdVsCost: vsCost(l.price),
    side,
  });
  return {
    atrW,
    tol,
    weeks: bars.length,
    since: bars[0].t,
    supports: sup.map((l) => row(l, 'support')),
    resistances: res.map((l) => row(l, 'resistance')),
    holdingStop,
    ladder,
  };
}
