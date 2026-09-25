/**
 * node scripts/check-bot.mjs — server bot run logic (shared/botEngine.js + shared/paper.js)
 * on fixture 4h candles. Simulates successive 5-min runs, carrying state between them
 * exactly like api/_botRunner.js does with the database rows.
 */
import assert from 'node:assert/strict';
import { dogeFromKrakenBalance, evaluateUserRun, priorStop } from '../shared/botEngine.js';
import { DEFAULT_PLAN, STOP_RULES_VERSION } from '../shared/plan.js';
import { initPaper, paperValues, stepPaper } from '../shared/paper.js';
import { initGuard, lockLine, parseMaxLoss, preTradeCheck, unlockGuard } from '../shared/guard.js';

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
let guard = null;
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
    guard,
  });
  guard = r.guardNext;
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
assert.ok(r.guardInit && Math.abs(guard.baseline_value - 100000 * plan.avgCost) < 1e-9, 'baseline = paper shares × plan avg cost');

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

// ================= TSB Profit lock / Pause (shared/guard.js via stepPaper) =================
const nowIso = new Date(T0).toISOString();
const book = (units, extra = {}) => ({ ...initPaper({ plan: extra.plan || DEFAULT_PLAN, price: 0.1, units, nowIso }), ...extra.over });
const gPlan = (over) => ({ ...DEFAULT_PLAN, ...over });

// (a) stop fill above baseline stays armed: cost 0.09, stop 0.092, seen at 0.0915 → $915 ≥ $900
{
  const plan = gPlan({ avgCost: 0.09, corePct: 100, slicePct: 0 });
  const g0 = initGuard({ shares: 10000, avgCost: 0.09, nowIso });
  const r = stepPaper(book(10000, { plan }), { plan, price: 0.0915, effectiveStop: 0.092, nowIso, guard: g0 });
  assert.deepEqual(r.events, ['exit_core']);
  assert.equal(r.trades[0].price, 0.0915, 'stop fills at the price the 5-min check saw');
  assert.equal(r.guard.locked, false, '(a) $915 ≥ $900 stays armed');
  assert.ok(Math.abs(r.guard.realized_pnl - 10000 * 0.0015) < 1e-9, 'realized P&L tracked');
}

// (b) several trades: slice cycle, then a stop fill; cumulative book ends below baseline → locked
{
  const plan = gPlan({ avgCost: 0.1, sellLevel: 0.11, buyBackLevel: 0.102, stopFloor: 0.097 });
  let g = initGuard({ shares: 10000, avgCost: 0.1, nowIso }); // baseline $1,000
  let p = book(10000, { plan });
  let r = stepPaper(p, { plan, price: 0.111, effectiveStop: 0.097, nowIso, guard: g });
  assert.deepEqual(r.events, ['sell_slice']);
  assert.equal(r.guard.locked, false, 'book $1,100 after the sell');
  r = stepPaper(r.paper, { plan, price: 0.1015, effectiveStop: 0.097, nowIso, guard: r.guard });
  assert.deepEqual(r.events, ['buy_back']);
  assert.equal(r.guard.locked, false, 'book ≈ $1,037 after the buy-back');
  r = stepPaper(r.paper, { plan, price: 0.0965, effectiveStop: 0.097, nowIso, guard: r.guard });
  assert.deepEqual(r.events, ['exit_core']);
  assert.equal(r.guard.locked, true, '(b) cumulative book ≈ $986 < $1,000 → locked');
  assert.match(r.lockedNow, /Stop filled at \$0\.09650; book \$98\d\.\d\d is below starting \$1,000\.00/);
}

// (c) gap-through stop: price jumps from above to far below the stop → fills at the run price → locked
{
  const plan = gPlan({ avgCost: 0.09, corePct: 100, slicePct: 0 });
  const g0 = initGuard({ shares: 10000, avgCost: 0.09, nowIso }); // $900
  const r = stepPaper(book(10000, { plan }), { plan, price: 0.085, effectiveStop: 0.092, nowIso, guard: g0 });
  assert.equal(r.trades[0].price, 0.085, 'gap → fill at the run price, well below the stop');
  assert.equal(r.guard.locked, true, '(c) $850 < $900 → locked');
  // a later run while locked: nothing trades, the run still computes
  const again = stepPaper(r.paper, { plan, price: 0.08, effectiveStop: 0.092, nowIso, guard: r.guard });
  assert.equal(again.trades.length, 0);
}

// (d) locked blocks the buy-back (and a buy-back is blocked if the book is already below baseline)
{
  const plan = gPlan({ avgCost: 0.075 });
  let p = book(10000, { plan });
  p = stepPaper(p, { plan, price: 0.1005, effectiveStop: 0.079, nowIso }).paper; // slice sold, no guard
  const locked = { ...initGuard({ shares: 10000, avgCost: 0.075, nowIso }), locked: true, lock_reason: 'test' };
  const r = stepPaper(p, { plan, price: 0.0865, effectiveStop: 0.079, nowIso, guard: locked });
  assert.equal(r.trades.length, 0, '(d) no buy-back while locked');
  assert.equal(r.blocked[0].decision, 'blocked_locked');
  const high = initGuard({ shares: 10000, avgCost: 0.2, nowIso }); // baseline $2,000 > book
  const r2 = stepPaper(p, { plan, price: 0.0865, effectiveStop: 0.079, nowIso, guard: high });
  assert.equal(r2.trades.length, 0);
  assert.equal(r2.blocked[0].decision, 'blocked_below_baseline');
  assert.equal(preTradeCheck(high, { kind: 'sell_slice', bookValueNow: 1 }).allowed, true, 'only buy-backs use the below-baseline block');
}

// (e) unlock clears the lock and resets the baseline to the current book value
{
  const g = { ...initGuard({ shares: 10000, avgCost: 0.09, nowIso }), locked: true, lock_reason: 'x' };
  const u = unlockGuard(g, { bookValueNow: 850, units: 0, price: 0.085, userId: 'u1', nowIso });
  assert.equal(u.locked, false);
  assert.equal(u.baseline_value, 850, '(e) new baseline = book at unlock');
  assert.equal(u.unlocked_by, 'u1');
  assert.equal(u.baseline_source, 'reauthorized');
  // next loss below the re-authorized level locks again
  const plan = gPlan({ avgCost: 0.09, corePct: 100, slicePct: 0 });
  const p = book(10000, { plan });
  const u2 = unlockGuard(g, { bookValueNow: 10000 * 0.095, units: 10000, price: 0.095, userId: 'u1', nowIso });
  const r = stepPaper(p, { plan, price: 0.0935, effectiveStop: 0.094, nowIso, guard: u2 });
  assert.equal(r.guard.locked, true, 'locks again below the re-authorized $950');
}

// (f) paused blocks every trade but the run still computes
{
  const plan = gPlan({ avgCost: 0.075 });
  const paused = { ...initGuard({ shares: 10000, avgCost: 0.075, nowIso }), paused: true };
  const r = stepPaper(book(10000, { plan }), { plan, price: 0.101, effectiveStop: 0.079, nowIso, guard: paused });
  assert.equal(r.trades.length, 0, '(f) paused: no slice sell');
  assert.equal(r.blocked[0].decision, 'blocked_paused');
}

// Engine: lock decision + one blocked_* log per new blocked situation (not every run)
{
  const plan = { ...DEFAULT_PLAN, avgCost: 0.2, anchorAt: new Date(T0 + 30 * H4).toISOString() };
  let st = { stopRow: null, alertState: null, paper: null, guard: null };
  const go = (price, t) => {
    const r = evaluateUserRun({ planRaw: plan, ...st, bars, price, nowMs: now0 + t * 60_000, notionalUnits: 10000 });
    st = { stopRow: r.stopRowNext || st.stopRow, alertState: r.alertStateNext, paper: r.paperNext, guard: r.guardNext };
    return r;
  };
  let r = go(0.0955, 0); // baseline $2,000 (cost 0.2) — book ≈ $955
  assert.equal(r.decision, 'hold');
  r = go(0.1005, 5); // slice sells → book < baseline → locked
  assert.equal(r.decision, 'locked');
  assert.ok(st.guard.locked);
  r = go(0.0865, 10); // buy-back blocked (locked)
  assert.equal(r.decision, 'blocked_locked');
  r = go(0.0866, 15); // same blocked situation → not re-logged as a decision
  assert.equal(r.decision, 'hold');
  assert.match(r.reason, /still blocked/);
  assert.ok(Number.isFinite(r.snapshot.effectiveStop), 'still watching while locked');
}

// Max loss ("willing to lose" line): lock when book < baseline − max_loss_usd (default $1)
{
  const plan = gPlan({ avgCost: 0.1, corePct: 100, slicePct: 0 });
  const stopAt = (price, maxLoss) => {
    const g0 = initGuard({ shares: 10000, avgCost: 0.1, nowIso, prev: maxLoss == null ? null : { max_loss_usd: maxLoss } });
    return stepPaper(book(10000, { plan }), { plan, price, effectiveStop: 0.1, nowIso, guard: g0 }).guard;
  };
  assert.equal(initGuard({ shares: 1, avgCost: 1, nowIso }).max_loss_usd, 1, 'default max loss $1');
  assert.equal(lockLine(initGuard({ shares: 10000, avgCost: 0.1, nowIso })), 999);
  assert.equal(stopAt(0.09995, null).locked, false, 'default $1: a $0.50 drop stays armed');
  assert.equal(stopAt(0.0999, null).locked, false, 'default $1: exactly $1 down is on the line, not below');
  assert.equal(stopAt(0.099899, null).locked, true, 'default $1: a $1.01 drop locks');
  assert.equal(stopAt(0.098, 50).locked, false, '$50 line: a $20 drop stays armed');
  const g51 = stopAt(0.0949, 50);
  assert.equal(g51.locked, true, '$50 line: a $51 drop locks');
  assert.match(g51.lock_reason, /max loss \$50\.00/);
  assert.equal(stopAt(0.0999, 0).locked, true, '$0 line: any drop locks');
  assert.equal(parseMaxLoss('50'), 50);
  assert.throws(() => parseMaxLoss(-1));
  assert.throws(() => parseMaxLoss('abc'));
}

console.log('profit lock checks: OK (a)-(f) + max loss + engine');
