/**
 * Price-crossing alert rules (pure). Fire once per crossing; re-arm only after
 * price moves back past the level by `hysteresisPct` so chop around a level
 * doesn't spam.
 */

import { formatPrice } from './format.js';

export const DEFAULT_HYSTERESIS_PCT = 0.5;

/**
 * @returns {{ id, label, dir: 'up'|'down', level, sticky?, title, body }[]}
 * `sticky` rules keep their armed state when the level changes (the ratcheting stop).
 */
export function buildRules(plan, snapshot) {
  if (!plan) return [];
  const p = formatPrice;
  const rules = [
    {
      id: 'sell',
      label: 'Sell-into-strength',
      dir: 'up',
      level: plan.sellLevel,
      title: `DOGE hit sell level ${p(plan.sellLevel)}`,
      body: `Trim the ${plan.slicePct}% trading slice into strength.`,
    },
    {
      id: 'breakout',
      label: 'Breakout',
      dir: 'up',
      level: plan.breakoutLevel,
      title: `DOGE broke out above ${p(plan.breakoutLevel)}`,
      body: `Raise the stop floor to ${p(plan.breakoutFloor)}.`,
    },
    {
      id: 'highZoneIn',
      label: 'High zone entered',
      dir: 'up',
      level: plan.highZone?.low,
      title: `DOGE entered predicted high zone (${p(plan.highZone?.low)}–${p(plan.highZone?.high)})`,
      body: 'Price reached your predicted high zone.',
    },
    {
      id: 'highZoneOut',
      label: 'Above high zone',
      dir: 'up',
      level: plan.highZone?.high,
      title: `DOGE broke above predicted high zone ${p(plan.highZone?.high)}`,
      body: 'Price is above your predicted high zone.',
    },
    {
      id: 'buyBack',
      label: 'Buy-back',
      dir: 'down',
      level: plan.buyBackLevel,
      title: `DOGE hit buy-back level ${p(plan.buyBackLevel)}`,
      body: `Buy back the ${plan.slicePct}% trading slice.`,
    },
    {
      id: 'lowZoneIn',
      label: 'Low zone entered',
      dir: 'down',
      level: plan.lowZone?.high,
      title: `DOGE entered predicted low zone (${p(plan.lowZone?.low)}–${p(plan.lowZone?.high)})`,
      body: 'Price reached your predicted low zone.',
    },
    {
      id: 'lowZoneOut',
      label: 'Below low zone',
      dir: 'down',
      level: plan.lowZone?.low,
      title: `DOGE broke below predicted low zone ${p(plan.lowZone?.low)}`,
      body: 'Price is below your predicted low zone.',
    },
  ];
  if (snapshot?.effectiveStop) {
    rules.push({
      id: 'stop',
      label: 'Effective stop',
      dir: 'down',
      level: snapshot.effectiveStop,
      sticky: true,
      title: `DOGE STOP: price at/through ${p(snapshot.effectiveStop)}`,
      body: `Core (${plan.corePct}%) trailing stop reached.`,
    });
  }
  return rules.filter((r) => Number.isFinite(r.level) && r.level > 0);
}

const beyond = (dir, price, level) => (dir === 'up' ? price >= level : price <= level);
const rearmed = (dir, price, level, h) =>
  dir === 'up' ? price < level * (1 - h / 100) : price > level * (1 + h / 100);

/**
 * @param rules  from buildRules
 * @param price  latest price
 * @param prev   { [ruleId]: { armed, level } }
 * @returns { state, fired: [{ ruleId, title, body, price, level }] }
 */
export function evaluateRules(rules, price, prev = {}, hysteresisPct = DEFAULT_HYSTERESIS_PCT) {
  const state = {};
  const fired = [];
  if (!Number.isFinite(price)) return { state: { ...prev }, fired };
  for (const r of rules) {
    const old = prev[r.id];
    const levelChanged = old && Math.abs(old.level - r.level) > 1e-12;
    const fresh = !old || (levelChanged && !r.sticky);
    let armed = fresh ? true : old.armed;
    if (armed && beyond(r.dir, price, r.level)) {
      fired.push({ ruleId: r.id, title: r.title, body: r.body, price, level: r.level });
      armed = false;
    } else if (!armed && rearmed(r.dir, price, r.level, hysteresisPct)) {
      armed = true;
    }
    state[r.id] = { armed, level: r.level };
  }
  return { state, fired };
}
