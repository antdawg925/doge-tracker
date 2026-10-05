// Dip-buy plan + Schwab LIMIT BUY payload (validation only, no network).
import assert from 'node:assert/strict';
import { buildDipPlan, buildLimitBuyOrder, dollarRisk, nextRatchetStop, sharesForAmount, shouldCancelPending, DIP_EXCLUDES } from '../shared/dipBuys.js';
import { buildLimitBuyOrder as schwabBuy } from '../shared/schwabLive.js';

const t0 = Date.UTC(2020, 0, 6);
const bars = [];
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.03;
const path = [];
for (let c = 0; c < 14; c += 1) {
  const lo = c % 3 === 0 ? 80 : 100;
  const hi = c % 4 === 0 ? 160 : 130;
  for (let i = 0; i < 13; i += 1) path.push(lo + (hi - lo) * Math.sin((Math.PI * i) / 12));
}
path.push(108, 110, 112);
path.forEach((p, i) => {
  const o = p * (1 + rnd());
  const cl = p * (1 + rnd());
  bars.push({ t: t0 + i * 7 * 86400000, open: o, close: cl, high: Math.max(o, cl) * 1.02, low: Math.min(o, cl) * 0.98 });
});

let n = 0;
const ok = (name, cond, extra = '') => {
  n += 1;
  if (!cond) {
    console.error(`FAIL ${name}`, extra);
    process.exit(1);
  }
};

ok('TSLA excluded', DIP_EXCLUDES.has('TSLA') && buildDipPlan('TSLA', bars, 200) === null);
const plan = buildDipPlan('NVDA', bars, 112, { stage: 2, dailyCloses: path });
ok('plan built', plan && plan.limit < 112 && plan.stop < plan.limit && plan.t1 > plan.limit, JSON.stringify(plan));
ok('RR > 0', plan.rr > 0);
ok('stage 6 rejected', buildDipPlan('NVDA', bars, 112, { stage: 6 }) === null);
ok('shares floor', sharesForAmount(1000, plan.limit) === Math.floor(1000 / plan.limit));
ok('dollar risk', Math.abs(dollarRisk(10, plan.limit, plan.stop) - (plan.limit - plan.stop) * 10) < 0.02);

const payload = buildLimitBuyOrder({ symbol: 'nvda', qty: 5, limitPrice: plan.limit });
ok('LIMIT BUY payload', payload.orderType === 'LIMIT' && payload.session === 'NORMAL' && payload.duration === 'GOOD_TILL_CANCEL');
ok('BUY instruction', payload.orderLegCollection[0].instruction === 'BUY' && payload.orderLegCollection[0].quantity === 5);
ok('same as schwabLive', JSON.stringify(payload) === JSON.stringify(schwabBuy({ symbol: 'NVDA', qty: 5, limitPrice: plan.limit })));
ok('rejects TSLA order', (() => { try { buildLimitBuyOrder({ symbol: 'TSLA', qty: 1, limitPrice: 100 }); return false; } catch { return true; } })());
ok('rejects fractional', (() => { try { buildLimitBuyOrder({ symbol: 'NVDA', qty: 1.5, limitPrice: 100 }); return false; } catch { return true; } })());

const ladder = [{ trigger: 120, stop: 110 }, { trigger: 140, stop: 130 }];
ok('ratchet up', nextRatchetStop(100, 121, ladder)?.stop === 110);
ok('never lower', nextRatchetStop(115, 121, ladder) === null);
ok('cancel after days', shouldCancelPending({ created_at: new Date(Date.now() - 11 * 86400000).toISOString(), stop: 90 }, { spot: 100 }).cancel);
ok('cancel under stop', shouldCancelPending({ created_at: new Date().toISOString(), stop: 100 }, { spot: 99 }).cancel);

console.log(`check:dip-buys OK (${n} checks; NVDA limit ${plan.limit} stop ${plan.stop} t1 ${plan.t1} rr ${plan.rr})`);
