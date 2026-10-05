// Research levels v2 (src/lib/majorLevels.js): synthetic weekly series, no network.
import { computeMajorPlan, weeklyAtr } from '../src/lib/majorLevels.js';

let n = 0;
const ok = (name, cond, extra = '') => {
  n += 1;
  if (!cond) {
    console.error(`FAIL ${name} ${extra}`);
    process.exit(1);
  }
};
// Oscillate between floors ~1.0 / 0.8 and ceilings ~1.3 / 1.6 for 6 years, end at 1.1.
const bars = [];
const t0 = Date.UTC(2020, 0, 6);
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.04;
const path = [];
for (let c = 0; c < 12; c += 1) {
  const lo = c % 3 === 0 ? 0.8 : 1.0;
  const hi = c % 4 === 0 ? 1.6 : 1.3;
  for (let i = 0; i < 13; i += 1) path.push(lo + (hi - lo) * Math.sin((Math.PI * i) / 12));
}
path.push(1.05, 1.08, 1.1);
path.forEach((p, i) => {
  const o = p * (1 + rnd());
  const cl = p * (1 + rnd());
  bars.push({ t: t0 + i * 7 * 86400000, open: o, close: cl, high: Math.max(o, cl) * 1.03, low: Math.min(o, cl) * 0.97 });
});
const spot = 1.1;
const m = computeMajorPlan(bars, spot, { coins: 1000, avgCost: 1.2, now: bars.at(-1).t });
ok('plan computed', m);
ok('2–3 supports', m.supports.length >= 1 && m.supports.length <= 3, m.supports.length);
ok('≤3 resistances', m.resistances.length >= 1 && m.resistances.length <= 3, m.resistances.length);
const spaced = (arr) => arr.every((l, i) => i === 0 || Math.abs(Math.log(l.price / arr[i - 1].price)) >= Math.log(1 + m.tol) - 1e-9);
ok('supports spaced ≥ merge distance', spaced(m.supports));
ok('resistances spaced ≥ merge distance', spaced(m.resistances));
ok('merge ≥ 10%', m.tol >= 0.1);
ok('supports below spot, resistances above', m.supports.every((l) => l.price < spot) && m.resistances.every((l) => l.price > spot));
ok('holding stop = S1 − 1 wk ATR', Math.abs(m.holdingStop.price - (m.supports[0].price - weeklyAtr(bars))) < 1e-9);
ok('holding stop risk vs cost', Math.abs(m.holdingStop.riskVsCost - 1000 * (m.holdingStop.price - 1.2)) < 1e-9);
ok('ladder steps up', m.ladder.every((l, i) => l.stop > (i ? m.ladder[i - 1].stop : m.holdingStop.price)));
ok('ladder stop under its trigger', m.ladder.every((l) => l.stop < l.trigger));
ok('too little history → null', computeMajorPlan(bars.slice(0, 10), spot) === null);
console.log(`check:levels OK (${n} checks; S ${m.supports.map((l) => l.price.toFixed(3)).join('/')} R ${m.resistances.map((l) => l.price.toFixed(3)).join('/')} stop ${m.holdingStop.price.toFixed(3)} merge ${(m.tol * 100).toFixed(0)}%)`);
