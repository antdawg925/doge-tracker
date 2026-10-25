/**
 * Anthony's DOGE level map (his word beats backtests). Pure helpers, no network.
 *  - ladderInfo: where price sits on the ladder (next level up, level below, distance, plan note)
 *  - levelSnapCandidate: optional stop candidate (setting `levelSnap`, default OFF) — once a level is
 *    reclaimed (last N completed 4h closes above it), the stop may move to just under the level below it.
 *    It is only a candidate: the engine still only ever raises, never at/above the market, step-capped.
 *  - sellNowCalc: "what if I sell X% now" — cash locked vs runner value at $0.30 / $0.40.
 */
export const DOGE_LEVELS = Object.freeze([
  { price: 0.1, note: 'Floor reclaim: the stop started at $0.089 under it' },
  { price: 0.14, note: 'First resistance' },
  { price: 0.175, note: 'Shelf before $0.20' },
  { price: 0.2, note: 'Cut way down here (main de-risk)' },
  { price: 0.25, note: 'Runners only from here' },
  { price: 0.3, note: 'Runner target 1' },
  { price: 0.35, note: 'Runner target' },
  { price: 0.4, note: 'Runner target 2' },
  { price: 0.45, note: 'Extension' },
  { price: 0.7, note: '~$0.70 stretch target', approx: true },
].map(Object.freeze));

const fin = (v) => v != null && Number.isFinite(Number(v));

export function ladderInfo(price, levels = DOGE_LEVELS) {
  if (!fin(price) || !(price > 0)) return null;
  const p = Number(price);
  const nextIdx = levels.findIndex((l) => l.price > p);
  const next = nextIdx >= 0 ? levels[nextIdx] : null;
  const belowIdx = nextIdx < 0 ? levels.length - 1 : nextIdx - 1;
  const under = belowIdx >= 0 ? levels[belowIdx] : null;
  return {
    price: p,
    next: next ? { ...next, index: nextIdx, distPct: (next.price / p - 1) * 100 } : null,
    below: under ? { ...under, index: belowIdx, distPct: (1 - under.price / p) * 100 } : null,
    rows: levels.map((l, i) => ({ ...l, index: i, distPct: (l.price / p - 1) * 100, hit: p >= l.price })),
  };
}

/** One-line ladder summary for Telegram. */
export function ladderLine(price, levels = DOGE_LEVELS) {
  const L = ladderInfo(price, levels);
  if (!L) return null;
  const f = (v) => `$${Number(v).toFixed(v < 1 ? 4 : 2)}`;
  const parts = [`📍 DOGE ${f(L.price)}`];
  if (L.next) parts.push(`next level ${f(L.next.price)}${L.next.approx ? '~' : ''} (+${L.next.distPct.toFixed(1)}%): ${L.next.note}`);
  else parts.push('above the whole level map');
  if (L.below) parts.push(`below ${f(L.below.price)} (−${L.below.distPct.toFixed(1)}%)`);
  return parts.join(' · ');
}

/**
 * @param bars4 completed 4h bars [{ close }]
 * @returns { px, level, why } | null
 */
export function levelSnapCandidate({ bars4, levels = DOGE_LEVELS, confirmBars = 2, bufferPct = 1 }) {
  const n = Math.max(1, Math.round(confirmBars));
  const last = (bars4 || []).slice(-n);
  if (last.length < n) return null;
  const minClose = Math.min(...last.map((b) => Number(b.close)));
  if (!Number.isFinite(minClose)) return null;
  let k = -1;
  for (let i = 0; i < levels.length; i++) if (minClose > levels[i].price) k = i;
  if (k < 1) return null; // nothing reclaimed above the first level, or no level below it
  const support = levels[k - 1].price;
  const px = support * (1 - bufferPct / 100);
  return { px, level: levels[k].price, support, why: `Level snap: reclaimed $${levels[k].price} (${n}× 4h close) → just under $${support}` };
}

/**
 * @returns { sellQty, keepQty, cashNow, runnerAt: [{price, value, total}], stopValue }
 */
export function sellNowCalc({ doge, usd = 0, bid, sellPct = 30, feePct = 0.4, slipPct = 0.5, stopPx = null, targets = [0.3, 0.4] }) {
  const d = Math.max(0, Number(doge) || 0);
  const b = Number(bid);
  if (!(d > 0) || !(b > 0)) return null;
  const pctC = Math.min(100, Math.max(0, Number(sellPct) || 0));
  const sellQty = (d * pctC) / 100;
  const keepQty = d - sellQty;
  const fill = b * (1 - slipPct / 100);
  const cashNow = sellQty * fill * (1 - feePct / 100);
  const cashTotal = (Number(usd) || 0) + cashNow;
  const runnerAt = targets.map((t) => ({ price: t, value: keepQty * t, total: cashTotal + keepQty * t, holdAll: d * t + (Number(usd) || 0) }));
  const stopValue = fin(stopPx) ? cashTotal + keepQty * Number(stopPx) : null;
  const holdStopValue = fin(stopPx) ? (Number(usd) || 0) + d * Number(stopPx) : null;
  return { sellQty, keepQty, fill, cashNow, cashTotal, runnerAt, stopValue, holdStopValue };
}

/** Stop-coverage check: the bottom stop should cover every DOGE (minus DOGE in resting zone/sell orders). */
export function coverageFlag({ status, doge, stopOrder, zoneQty = 0, killSwitch = false, orderMin = 0, mode = 'dry' }) {
  if (status !== 'active' || killSwitch) return null;
  const d = Number(doge) || 0;
  if (!(d >= orderMin) || !(d > 0)) return null;
  const tag = mode === 'live' ? '' : ' (dry-run)';
  if (!stopOrder) return { code: 'stop_uncovered', message: `🚨 No resting bottom stop${tag}: ${Math.round(d).toLocaleString('en-US')} DOGE unprotected. Check Kraken / the bot.` };
  const q = Number(stopOrder.qty) || 0;
  const gap = d - q;
  if (gap > Math.max(1, d * 0.001)) {
    const z = Number(zoneQty) || 0;
    return { code: 'stop_short', message: `🚨 Stop covers ${Math.round(q).toLocaleString('en-US')} of ${Math.round(d).toLocaleString('en-US')} DOGE${tag}${z > 0 ? ` (${Math.round(z).toLocaleString('en-US')} sit in a zone/sell order with no stop)` : ''}.` };
  }
  return null;
}
