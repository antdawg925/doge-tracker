/**
 * node scripts/check-bot.mjs — server bot run logic (shared/botEngine.js + shared/paper.js)
 * on fixture 4h candles. Simulates successive 5-min runs, carrying state between them
 * exactly like api/_botRunner.js does with the database rows.
 */
import assert from 'node:assert/strict';
import { dogeFromKrakenBalance, evaluateUserRun, priorStop } from '../shared/botEngine.js';
import { DEFAULT_PLAN, STOP_RULES_VERSION } from '../shared/plan.js';
import { initPaper, paperValues, stepPaper } from '../shared/paper.js';

const H4 = 4 * 3600 * 1000;
const T0 = Date.UTC(2026, 8, 1);
const bar = (i, c, spread = 0.002) => ({ t: T0 + i * H4, open: c, high: c + spread, low: c - spread, close: c });

// 60 quiet bars around 0.095 (stage 1), anchor at bar 30.
const bars = [];
for (let i = 0; i < 60; i += 1) bars.push(bar(i, 0.095 + (i % 3) * 0.0005));
const plan = { ...DEFAULT_PLAN, anchorAt: new Date(T0 + 30 * H4).toISOString() };

// State carried between runs (what the DB rows hold).
let stopRow = null;
let alertState = null;
let paper = null;
const log = [];

function run(price, nowMs, extraBars = []) {
  const r = evaluateUserRun({
    planRaw: plan,
    stopRow,
    alertState,
    paper,
    bars: [...bars, ...extraBars],
    price,
    nowMs,
    notionalUnits: 100000,
    unitsSource: 'positions',
  });
  if (r.stopRowNext) stopRow = r.stopRowNext;
  alertState = r.alertStateNext;
  paper = r.paperNext;
  log.push(r.decision);
  return r;
}

const now0 = T0 + 60 * H4 + 60_000; // 1 min into the forming bar after bar 59
// --- Run 1: stage 1, stop = manual floor, paper initialised from positions
let r = run(0.0955, now0);
assert.equal(r.snapshot.stage, 1);
assert.equal(r.snapshot.effectiveStop, plan.stopFloor);
assert.equal(r.decision, 'hold');
assert.ok(r.paperInit);
assert.equal(paper.data.units_source, 'positions');
assert.ok(Math.abs(paper.core_units - 78000) < 1e-6 && Math.abs(paper.slice_units - 22000) < 1e-6, 'core/slice split 78/22');
assert.equal(stopRow.version, STOP_RULES_VERSION);
assert.equal(priorStop(plan, stopRow), plan.stopFloor);

// --- Run 2: price hits sell level → slice sells once, sell alert fires
r = run(0.1005, now0 + 5 * 60_000);
assert.equal(r.decision, 'would_sell_slice');
assert.deepEqual(r.fired.map((f) => f.ruleId), ['sell']);
assert.equal(paper.slice_units, 0);
assert.ok(Math.abs(paper.cash - 22000 * 0.1) < 1e-9, 'fill assumes the sell level price');
// --- Run 3: still above: no repeat sell (once per cycle), no repeat alert
r = run(0.1008, now0 + 10 * 60_000);
assert.equal(r.decision, 'hold');
assert.equal(r.fired.length, 0);

// --- Stage 2: a CLOSED 4h candle closes above breakout (0.104) → floor 0.09 + ATR trail
const up = [bar(60, 0.106, 0.003), bar(61, 0.112, 0.003), bar(62, 0.118, 0.003)];
const now2 = T0 + 63 * H4 + 60_000;
r = run(0.118, now2, up);
assert.equal(r.snapshot.stage, 2);
assert.ok(r.snapshot.effectiveStop >= plan.breakoutFloor, 'floor steps up after breakout');
assert.equal(r.decision, 'stop_raised', 'stop moved up from 0.079');
const stopAfterBreakout = stopRow.data.effectiveStop;

// --- Price dips (no new high): stop never moves down
r = run(0.108, now2 + 5 * 60_000, up);
assert.equal(r.snapshot.effectiveStop, stopAfterBreakout);
assert.notEqual(r.decision, 'stop_raised');

// --- Crash through the stop and the buy-back: slice buys back, core exits at the stop
r = run(0.086, now2 + 10 * 60_000, up);
assert.equal(r.decision, 'would_exit_core', 'core exit outranks buy-back');
assert.ok(r.paperEvents.includes('buy_back') && r.paperEvents.includes('exit_core'));
assert.equal(paper.core_units, 0);
assert.ok(paper.data.core_stopped);
assert.ok(r.fired.some((f) => f.ruleId === 'stop'));
// --- Stays in cash after the stop
r = run(0.08, now2 + 15 * 60_000, up);
assert.ok(!r.paperEvents.includes('exit_core'));
assert.match(r.reason, /core stopped out/);

// --- Paper vs hold math
const v = paperValues(paper, 0.08);
assert.ok(v.paperValue > v.holdValue, 'stop-out beats holding into a crash');

// --- Re-anchored plan ignores old stop memory
assert.equal(priorStop({ ...plan, anchorAt: new Date().toISOString() }, stopRow), null);
assert.equal(priorStop(plan, { ...stopRow, version: STOP_RULES_VERSION - 1 }), null);

// --- initPaper default notional + stepPaper guard on inverted levels
const p0 = initPaper({ plan: DEFAULT_PLAN, price: 0.1, nowIso: new Date().toISOString() });
assert.equal(p0.data.notional_units, 10000);
const inv = stepPaper(p0, { plan: { ...DEFAULT_PLAN, sellLevel: 0.08, buyBackLevel: 0.09 }, price: 0.2, effectiveStop: 0.05 });
assert.equal(inv.trades.length, 0, 'sell <= buy-back → slice never trades');

// --- Kraken balance parsing (spot + earn variants)
assert.deepEqual(dogeFromKrakenBalance({ XXDG: '1000.5', 'XDG.F': '10', ZUSD: '5' }).total, 1010.5);
assert.equal(dogeFromKrakenBalance({ ZUSD: '5' }).total, 0);

console.log('bot run checks: OK', log.join(' → '));
