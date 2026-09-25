/** node scripts/check-alerts.mjs — crossing / re-arm behaviour of alertRules.js */
import assert from 'node:assert/strict';
import { buildRules, evaluateRules } from '../src/lib/alertRules.js';
import { DEFAULT_PLAN } from '../src/lib/planStore.js';

const plan = { ...DEFAULT_PLAN };
let rules = buildRules(plan, { effectiveStop: 0.0885 });
let st = {};
const step = (price) => {
  const r = evaluateRules(rules, price, st);
  st = r.state;
  return r.fired.map((f) => f.ruleId);
};
assert.deepEqual(step(0.0958), []);
assert.deepEqual(step(0.1001), ['sell']);
assert.deepEqual(step(0.0999), [], 'chop just under level: not re-armed yet');
assert.deepEqual(step(0.1002), [], 'no repeat');
assert.deepEqual(step(0.0990), [], 're-arms (>0.5% below)');
assert.deepEqual(step(0.1003), ['sell'], 'fires again after re-arm');
assert.deepEqual(step(0.105), ['breakout']);
assert.deepEqual(step(0.0885), ['lowZoneIn', 'stop']);
assert.deepEqual(step(0.0869), ['buyBack']);
assert.deepEqual(step(0.0849), ['lowZoneOut']);
// ratchet raises the stop while price is back above → sticky rule stays armed/disarmed correctly
assert.deepEqual(step(0.095), []);
rules = buildRules(plan, { effectiveStop: 0.091 });
assert.deepEqual(step(0.0905), ['stop'], 'stop re-armed after recovery and fires at new level');
// editing a (non-sticky) level resets that rule
rules = buildRules({ ...plan, sellLevel: 0.09 }, { effectiveStop: 0.08 });
assert.deepEqual(step(0.0905), ['sell'], 'sell moved below price → fires once');
assert.deepEqual(step(0.0906), []);
console.log('alert rule checks: OK');
