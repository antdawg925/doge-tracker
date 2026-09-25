/**
 * Quick sanity check for src/lib/atr.js (no test framework in this repo).
 *   node scripts/check-atr.mjs          # fixture assertions + live Kraken 4h numbers
 *   node scripts/check-atr.mjs --offline
 */
import assert from 'node:assert/strict';
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

// --- Tighten threshold
// 0.075 × 1.15 = 0.08625
assert.equal(multiplierFor(0.0863, { atrMult: 2.5, tightMult: 1.75, tightenPct: 15, tightenRef: 0.075 }).mult, 1.75);
assert.equal(multiplierFor(0.0862, { atrMult: 2.5, tightMult: 1.75, tightenPct: 15, tightenRef: 0.075 }).mult, 2.5);
assert.equal(multiplierFor(0.2, { atrMult: 2.5, tightMult: 1.75, tightenPct: 15, tightenRef: null }).tightened, false);

// --- Snapshot: price falls after a run-up → stop holds at the prior high trail
const run = [];
for (let i = 0; i < 40; i += 1) run.push(bar(i, 0.09, 0.0905, 0.0895, 0.09));
run.push(bar(40, 0.09, 0.1, 0.09, 0.099));
for (let i = 41; i < 50; i += 1) run.push(bar(i, 0.092, 0.0925, 0.0915, 0.092));
const snap = computeStopSnapshot({ bars: run, anchorMs: 0, stopFloor: 0.079, atrMult: 2.5, tightMult: 1.75, tightenPct: 15, tightenRef: 0.2 });
const atrs = wilderAtr(run);
assert.equal(snap.highestHigh, 0.1);
const peakTrail = 0.1 - 2.5 * atrs[40];
const bestTrail = Math.max(...atrs.slice(40).map((a) => 0.1 - 2.5 * a));
assert.ok(snap.effectiveStop >= peakTrail - 1e-12, 'stop keeps the peak-bar trail');
assert.ok(Math.abs(snap.effectiveStop - bestTrail) < 1e-12, 'stop = best trail since anchor');
// previous persisted stop higher than anything computed → keep it
const snap2 = computeStopSnapshot({ bars: run, anchorMs: 0, stopFloor: 0.079, prevEffectiveStop: 0.0985, tightenRef: 0.2 });
assert.equal(snap2.effectiveStop, 0.0985);
assert.equal(snap2.stopSource, 'ratchet');
// floor dominates when trail is below it
const snap3 = computeStopSnapshot({ bars: run, anchorMs: 0, stopFloor: 0.0985, tightenRef: 0.2 });
assert.equal(snap3.effectiveStop, 0.0985);
assert.equal(snap3.stopSource, 'floor');
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
    atrMult: 2.5,
    tightMult: 1.75,
    tightenPct: 15,
    tightenRef: 0.075,
  });
  const f = (n, d = 5) => n.toFixed(d);
  console.log(`live Kraken XDGUSD 4h (${bars.length} bars, last ${new Date(s.lastBarAt).toISOString()})`);
  console.log(`  price ${f(s.price)}  ATR ${f(s.atr)} (${s.atrPct.toFixed(2)}%)  90d median ATR% ${s.medianAtrPct.toFixed(2)}%`);
  console.log(`  2.5×ATR ${f(2.5 * s.atr)} (${s.baseTrailPct.toFixed(2)}%)  1.75×ATR ${f(1.75 * s.atr)} (${s.tightTrailPct.toFixed(2)}%)`);
  console.log(`  tighten at > ${f(s.tightenAt)} → tightened=${s.tightened} mult=${s.mult}`);
  console.log(`  HH since anchor ${f(s.highestHigh)}  trail ${f(s.trail)}  effective ${f(s.effectiveStop)} (${s.stopSource})  dist ${s.distToStopPct.toFixed(2)}%`);
  // Print TR/ATR tail for cross-checking with pandas
  if (process.argv.includes('--json')) console.log(JSON.stringify({ bars }));
}
