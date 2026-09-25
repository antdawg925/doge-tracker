/**
 * Quick sanity check for src/lib/atr.js (no test framework in this repo).
 *   node scripts/check-atr.mjs          # fixture assertions + live Kraken 4h numbers
 *   node scripts/check-atr.mjs --offline
 */
import assert from 'node:assert/strict';
import {
  DEFAULT_PLAN,
  STOP_RULES_VERSION,
  loadPlanDoc,
  saveStopState,
  setPlanBackend,
} from '../src/lib/planStore.js';
import {
  computeStopSnapshot,
  multiplierFor,
  ratchet,
  trueRanges,
  wilderAtr,
} from '../src/lib/atr.js';

const H4 = 4 * 3600 * 1000;
const bar = (i, o, h, l, c) => ({ t: i * H4, open: o, high: h, low: l, close: c });

// --- True range picks the gap side when price gaps
const gap = [bar(0, 1, 1.1, 0.9, 1.0), bar(1, 1.3, 1.4, 1.25, 1.35), bar(2, 0.8, 0.85, 0.7, 0.75)];
const tr = trueRanges(gap);
assert.ok(Math.abs(tr[0] - 0.2) < 1e-12, 'first TR = high-low');
assert.ok(Math.abs(tr[1] - 0.4) < 1e-12, 'gap up TR = high - prevClose');
assert.ok(Math.abs(tr[2] - 0.65) < 1e-12, 'gap down TR = prevClose - low');

// --- Wilder ATR on constant TR converges to that TR; recursion uses alpha 1/14
const flat = Array.from({ length: 50 }, (_, i) => bar(i, 1, 1.05, 0.95, 1));
const atrFlat = wilderAtr(flat);
assert.ok(Math.abs(atrFlat.at(-1) - 0.1) < 1e-12, 'constant TR → ATR = TR');
const two = wilderAtr([bar(0, 1, 1.1, 0.9, 1), bar(1, 1, 1.3, 0.9, 1)]);
assert.ok(Math.abs(two[1] - (0.2 + (0.4 - 0.2) / 14)) < 1e-12, 'Wilder step');

// --- Ratchet never moves down
assert.equal(ratchet(0.079, 0.0885, 0.09), 0.09);
assert.equal(ratchet(0.079, null, undefined), 0.079);

// --- Tighten threshold (reference passed explicitly)
// 0.075 × 1.15 = 0.08625
assert.equal(multiplierFor(0.0863, { atrMult: 2.5, tightMult: 1.75, tightenPct: 15, tightenRef: 0.075 }).mult, 1.75);
assert.equal(multiplierFor(0.0862, { atrMult: 2.5, tightMult: 1.75, tightenPct: 15, tightenRef: 0.075 }).mult, 2.5);
assert.equal(multiplierFor(0.2, { atrMult: 2.5, tightMult: 1.75, tightenPct: 15, tightenRef: null }).tightened, false);

// ===== Staged stop fixtures =====
// Plan: floor 0.079, breakout 0.104 → floor 0.090, 2.5× / 1.75× above breakout +15% (0.1196)
const PLAN = { stopFloor: 0.079, breakoutLevel: 0.104, breakoutFloor: 0.09, atrMult: 2.5, tightMult: 1.75, tightenPct: 15 };
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-12, `${msg}: ${a} vs ${b}`);
const series = (closes, spread = 0.001) =>
  closes.map((c, i) => bar(i, c, c + spread, c - spread, c));
const NOW_AFTER = (bars) => bars.at(-1).t + H4; // every bar closed
const snapOf = (bars, extra = {}) =>
  computeStopSnapshot({ bars, anchorMs: 0, nowMs: NOW_AFTER(bars), ...PLAN, ...extra });

// 1) Stage 1: price ~0.096 (like today) → stop = manual floor, no trail
const today = series([...Array(40).fill(0.095), 0.0958, 0.0965]);
const s1 = snapOf(today);
assert.equal(s1.stage, 1);
assert.equal(s1.trail, null, 'no trail before breakout');
assert.equal(s1.effectiveStop, 0.079, 'stage 1 stop = floor');
assert.equal(s1.stopSource, 'floor');
assert.ok(s1.previewTrail > 0.08 && s1.previewTrail < s1.price, 'preview 2.5× trail shown for reference');
near(s1.tightenAt, 0.104 * 1.15, 'tighten ref defaults to breakout level (~0.1196)');

// 2) Intrabar poke above 0.104 without a CLOSE above → still stage 1
const poke = series([...Array(30).fill(0.1), 0.1]);
poke[29] = bar(29, 0.1, 0.106, 0.099, 0.1035); // wick above, close below
assert.equal(snapOf(poke).stage, 1, 'wick above breakout does not trigger');
// …and an in-progress candle trading above 0.104 does not count until it closes
const forming = series([...Array(30).fill(0.1), 0.105]);
const sForming = computeStopSnapshot({ bars: forming, anchorMs: 0, nowMs: forming.at(-1).t + 60_000, ...PLAN });
assert.equal(sForming.stage, 1, 'forming candle above breakout ignored');
assert.equal(snapOf(forming).stage, 2, 'same candle once closed → stage 2');

// 3) Close above breakout → floor bumps to 0.090 and trail starts from the breakout candle
const bo = series([...Array(30).fill(0.1), 0.1045, 0.106, 0.108, 0.107]);
const s2 = snapOf(bo);
const atrBo = wilderAtr(bo);
assert.equal(s2.stage, 2);
assert.equal(s2.breakoutAt, bo[30].t, 'breakout = first close above 0.104');
assert.equal(s2.stageFloor, 0.09, 'floor after breakout applied automatically');
assert.equal(s2.highestHigh, 0.109, 'highest high counted from breakout candle');
const expectTrail = Math.max(0.09, ...[30, 31, 32, 33].map((i) => Math.max(...bo.slice(30, i + 1).map((b) => b.high)) - 2.5 * atrBo[i]));
near(s2.effectiveStop, expectTrail, 'stage 2 stop = max(floor 0.090, best 2.5× trail since breakout)');
assert.equal(s2.mult, 2.5, 'below 0.1196 → base multiplier');
// Pre-breakout highs (e.g. May 0.117) must NOT count: anchor excludes them
const withOldHigh = [bar(0, 0.115, 0.117, 0.113, 0.115), ...series(Array(30).fill(0.095)).map((b, i) => ({ ...b, t: (i + 1) * H4 }))];
const sOld = computeStopSnapshot({ bars: withOldHigh, anchorMs: H4, nowMs: 40 * H4, ...PLAN });
assert.equal(sOld.stage, 1, 'close above breakout before the anchor is ignored');
assert.equal(sOld.effectiveStop, 0.079);

// 4) Tighten above 1.15 × breakout (0.1196)
const run = series([...Array(30).fill(0.1), 0.105, 0.11, 0.115, 0.121]);
const sT = snapOf(run);
assert.equal(sT.tightened, true, 'price 0.121 > 0.1196 → tight');
assert.equal(sT.mult, 1.75);
const sNT = snapOf(series([...Array(30).fill(0.1), 0.105, 0.11, 0.115, 0.119]));
assert.equal(sNT.tightened, false, '0.119 < 0.1196 → still 2.5×');
// explicit override still works
assert.equal(snapOf(series([...Array(30).fill(0.1), 0.105, 0.11]), { tightenRef: 0.09 }).tightened, true);

// 5) Never lowers: pullback after a run keeps the peak stop; previous stored stop is respected
const pull = series([...Array(30).fill(0.1), 0.105, 0.115, 0.12, 0.1, 0.095]);
const sP = snapOf(pull);
const peak = snapOf(pull.slice(0, 33));
assert.ok(sP.effectiveStop >= peak.effectiveStop - 1e-12, 'stop held after pullback');
assert.ok(sP.effectiveStop > 0.09);
assert.equal(snapOf(today, { prevEffectiveStop: 0.081 }).effectiveStop, 0.081, 'stored stop above floor kept');
assert.equal(snapOf(today, { prevEffectiveStop: 0.081 }).stopSource, 'ratchet');
assert.equal(snapOf(today, { stopFloor: 0.07, prevEffectiveStop: 0.079 }).effectiveStop, 0.079, 'lowering the floor does not lower the stop');

// 6) Stale v1 stop memory (~0.092 from the avg-cost trail) is discarded on load
const mem = { doc: null };
setPlanBackend({ read: async () => mem.doc, write: async (d) => { mem.doc = JSON.parse(JSON.stringify(d)); } });
mem.doc = {
  version: 1,
  plan: { ...DEFAULT_PLAN, anchorAt: '2026-09-25T02:15:00.000Z' },
  history: [],
  stop: { effectiveStop: 0.09203, anchorAt: '2026-09-25T02:15:00.000Z', updatedAt: '2026-09-25T02:16:00.000Z' },
  alerts: { rules: { stop: { armed: true, level: 0.09203 }, sell: { armed: true, level: 0.1 } }, log: [] },
};
const migrated = await loadPlanDoc();
assert.equal(migrated.stop.effectiveStop, null, 'stale 0.092 dropped');
assert.equal(migrated.stop.rulesVersion, STOP_RULES_VERSION);
assert.equal(migrated.alerts.rules.stop, undefined, 'stale stop alert state dropped');
assert.deepEqual(migrated.alerts.rules.sell, { armed: true, level: 0.1 }, 'other alert state kept');
assert.equal(mem.doc.stop.rulesVersion, STOP_RULES_VERSION, 'migration persisted');
const recomputed = snapOf(today, { prevEffectiveStop: migrated.stop.effectiveStop });
assert.equal(recomputed.effectiveStop, 0.079, 'recomputes to stage-1 floor');
await saveStopState(0.079, migrated.plan.anchorAt);
await saveStopState(0.075, migrated.plan.anchorAt);
assert.equal((await loadPlanDoc()).stop.effectiveStop, 0.079, 'store never lowers');
console.log('fixture checks: OK');

if (!process.argv.includes('--offline')) {
  const res = await fetch('https://api.kraken.com/0/public/OHLC?pair=XDGUSD&interval=240');
  const data = await res.json();
  const key = Object.keys(data.result).find((k) => k !== 'last');
  const bars = data.result[key].map((r) => ({
    t: r[0] * 1000, open: +r[1], high: +r[2], low: +r[3], close: +r[4],
  }));
  const s = computeStopSnapshot({
    bars,
    anchorMs: Date.now(),
    stopFloor: 0.079,
    breakoutLevel: 0.104,
    breakoutFloor: 0.09,
    atrMult: 2.5,
    tightMult: 1.75,
    tightenPct: 15,
  });
  const f = (n, d = 5) => n.toFixed(d);
  console.log(`live Kraken XDGUSD 4h (${bars.length} bars, last ${new Date(s.lastBarAt).toISOString()})`);
  console.log(`  price ${f(s.price)}  ATR ${f(s.atr)} (${s.atrPct.toFixed(2)}%)  90d median ATR% ${s.medianAtrPct.toFixed(2)}%`);
  console.log(`  2.5×ATR ${f(2.5 * s.atr)} (${s.baseTrailPct.toFixed(2)}%)  1.75×ATR ${f(1.75 * s.atr)} (${s.tightTrailPct.toFixed(2)}%)`);
  console.log(`  stage ${s.stage}  tighten at > ${f(s.tightenAt)} → tightened=${s.tightened} mult=${s.mult}`);
  console.log(`  effective ${f(s.effectiveStop)} (${s.stopSource})  dist ${s.distToStopPct.toFixed(2)}%  trail ${s.trail == null ? 'off' : f(s.trail)}  preview 2.5× trail ${s.previewTrail == null ? '-' : f(s.previewTrail)}`);
  // Print TR/ATR tail for cross-checking with pandas
  if (process.argv.includes('--json')) console.log(JSON.stringify({ bars }));
}
