/**
 * Server bot decision engine (pure — no fetch, no DB). One call per user per run:
 * staged stop from the plan + stop memory, alert crossings vs alert state, the
 * paper-trading step, and a single decision label for the run log.
 *
 * The same functions run in api/_botRunner.js (live) and scripts/check-bot.mjs
 * (fixture candles), so the check exercises the exact server logic.
 */
import { computeStopSnapshot } from './atr.js';
import { buildRules, evaluateRules } from './alertRules.js';
import { STOP_RULES_VERSION, normalizePlan } from './plan.js';
import { initPaper, paperBookValue, paperValues, stepPaper } from './paper.js';
import { initGuard, sameGuard } from './guard.js';

/** Symbols the bot watches. Add a row here (and a plan source) to watch more. */
export const BOT_SYMBOLS = Object.freeze({
  DOGE: Object.freeze({
    symbol: 'DOGE',
    pair: 'XDGUSD',
    intervalMin: 240,
    maxBars: 720, // same window the browser uses (120 days of 4h)
    krakenAssets: ['XXDG', 'XDG'], // Kraken balance keys for DOGE (+ '.F' earn variants)
  }),
});

export const DECISION_PRIORITY = [
  'locked',
  'would_exit_core',
  'would_sell_slice',
  'would_buy_back',
  'blocked_locked',
  'blocked_paused',
  'blocked_below_baseline',
  'stop_raised',
  'hold',
];
const EVENT_DECISION = { exit_core: 'would_exit_core', sell_slice: 'would_sell_slice', buy_back: 'would_buy_back' };

const EPS = 1e-12;

/** Stored stop that still applies to this plan (same rules version + anchor), else null. */
export function priorStop(plan, stopRow) {
  if (!stopRow || stopRow.version !== STOP_RULES_VERSION) return null;
  const data = stopRow.data || {};
  if (data.anchorAt !== plan.anchorAt) return null;
  const v = Number(data.effectiveStop);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * @param {object} p
 * @param {object} p.planRaw        doge_plans.plan (jsonb)
 * @param {object|null} p.stopRow   stop_memory row { version, data }
 * @param {object|null} p.alertState alert_state.data
 * @param {object|null} p.paper     paper_state row (null → initialise)
 * @param {Array}  p.bars           4h bars, oldest → newest
 * @param {number} p.price          live price (ticker; falls back to last close)
 * @param {number} p.nowMs
 * @param {number} [p.notionalUnits] paper notional (positions / Kraken / default)
 * @param {string} [p.unitsSource]
 * @param {object|null} [p.guard]   bot_guard row (TSB Profit lock / Pause); null → create
 */
export function evaluateUserRun({ planRaw, stopRow, alertState, paper, bars, price, nowMs, notionalUnits, unitsSource, guard = null, symbol = 'DOGE' }) {
  const nowIso = new Date(nowMs).toISOString();
  const plan = normalizePlan(planRaw || {});
  const prev = priorStop(plan, stopRow);
  const snapshot = computeStopSnapshot({
    bars,
    livePrice: price,
    anchorMs: Date.parse(plan.anchorAt),
    stopFloor: plan.stopFloor,
    breakoutLevel: plan.breakoutLevel,
    breakoutFloor: plan.breakoutFloor,
    atrMult: plan.atrMult,
    tightMult: plan.tightMult,
    tightenPct: plan.tightenPct,
    tightenRef: plan.tightenRef,
    prevEffectiveStop: prev,
    nowMs,
  });
  if (!snapshot) throw new Error('Not enough candles to compute the stop.');

  // --- stop memory (ratchet; server is the source of truth)
  const eff = snapshot.effectiveStop;
  let stopRowNext = null;
  if (Number.isFinite(eff) && (prev == null || eff > prev + EPS)) {
    stopRowNext = { version: STOP_RULES_VERSION, data: { effectiveStop: eff, anchorAt: plan.anchorAt, updatedAt: nowIso } };
  }
  const stopRaised = prev != null && Number.isFinite(eff) && eff > prev + EPS;

  // --- alert crossings (stale stop version → drop the stop rule's arming, like the client)
  const prevRules = alertState && typeof alertState === 'object' ? { ...alertState } : {};
  if (stopRow && stopRow.version !== STOP_RULES_VERSION) delete prevRules.stop;
  const rules = buildRules(plan, snapshot);
  const { state: alertStateNext, fired } = evaluateRules(rules, snapshot.price, prevRules);
  const alertsChanged = JSON.stringify(sortKeys(alertStateNext)) !== JSON.stringify(sortKeys(alertState || {}));

  // --- paper trading, every fill through the TSB guard (shared/guard.js)
  const paperInit = !paper;
  const book = paper || initPaper({ symbol, plan, price: snapshot.price, units: notionalUnits, unitsSource, nowIso });
  // Baseline = paper shares × plan avg cost. A fresh paper book (first run / restart) or a
  // guard without a baseline gets one; lock + pause flags always carry over.
  const guardInit = !guard || guard.baseline_value == null || paperInit;
  const guardIn = guardInit
    ? initGuard({ shares: book.data?.notional_units ?? n(book.core_units) + n(book.slice_units), avgCost: plan.avgCost, nowIso, prev: guard })
    : guard;
  const step = stepPaper(book, {
    plan,
    price: snapshot.price,
    effectiveStop: eff,
    nowIso,
    guard: guardIn,
  });
  const { paper: paperNext, trades: paperTrades, events, blocked, lockedNow } = step;
  const values = paperValues(paperNext, snapshot.price);

  // Blocked trades: log a blocked_* decision once per new blocked situation, not every 5 min.
  const guardNext = { ...step.guard, data: { ...(step.guard?.data || {}) } };
  const blockedKey = blocked.map((b) => `${b.decision}:${b.kind}`).join(',') || null;
  const newBlock = blockedKey && blockedKey !== (guardIn.data?.last_blocked ?? null);
  guardNext.data.last_blocked = blockedKey;
  const guardChanged = guardInit || !sameGuard(guardNext, guard);

  // --- decision (highest priority wins; reason lists everything)
  const candidates = events.map((e) => EVENT_DECISION[e]);
  if (lockedNow) candidates.push('locked');
  if (newBlock) candidates.push(blocked[0].decision);
  if (stopRaised) candidates.push('stop_raised');
  const decision = DECISION_PRIORITY.find((d) => candidates.includes(d)) || 'hold';

  const reasons = [];
  if (events.includes('exit_core')) reasons.push(`price ${fmt(snapshot.price)} ≤ stop ${fmt(eff)}: core would exit`);
  if (events.includes('sell_slice')) reasons.push(`price ${fmt(snapshot.price)} ≥ sell ${fmt(plan.sellLevel)}: slice would sell`);
  if (events.includes('buy_back')) reasons.push(`price ${fmt(snapshot.price)} ≤ buy-back ${fmt(plan.buyBackLevel)}: slice would buy back`);
  if (lockedNow) reasons.push(`LOCKED: ${lockedNow}`);
  for (const b of blocked) reasons.push(newBlock ? b.reason : `still blocked: ${b.reason}`);
  if (stopRaised) reasons.push(`stop raised ${fmt(prev)} → ${fmt(eff)}`);
  if (!reasons.length) {
    if (paperNext.data?.core_stopped) reasons.push('core stopped out (paper) — in cash');
    else reasons.push(`stage ${snapshot.stage}; stop ${fmt(eff)} (${snapshot.stopSource}); ${pct(snapshot.distToStopPct)} above stop`);
  }
  if (fired.length) reasons.push(`alerts: ${fired.map((f) => f.ruleId).join(', ')}`);

  return {
    plan,
    snapshot,
    prevStop: prev,
    stopRaised,
    stopRowNext,
    alertStateNext,
    alertsChanged,
    fired,
    paperInit,
    paperNext,
    paperTrades,
    paperEvents: events,
    paperValues: values,
    paperBook: paperBookValue(paperNext, snapshot.price),
    guardInit,
    guardNext,
    guardChanged,
    lockedNow,
    blocked,
    decision,
    reason: reasons.join('; '),
  };
}

/** Kraken Balance result → DOGE total (spot + earn variants) and the keys used. */
export function dogeFromKrakenBalance(result, assets = BOT_SYMBOLS.DOGE.krakenAssets) {
  if (!result || typeof result !== 'object') return { total: null, parts: {} };
  const parts = {};
  let total = 0;
  let found = false;
  for (const [k, v] of Object.entries(result)) {
    const base = k.split('.')[0];
    if (!assets.includes(base)) continue;
    const x = Number(v);
    if (!Number.isFinite(x)) continue;
    parts[k] = x;
    total += x;
    found = true;
  }
  return { total: found ? total : 0, parts };
}

function n(v) {
  return Number.isFinite(Number(v)) ? Number(v) : 0;
}
function sortKeys(o) {
  return Object.keys(o || {})
    .sort()
    .reduce((acc, k) => ((acc[k] = o[k]), acc), {});
}
function fmt(x) {
  return Number.isFinite(x) ? `$${x < 1 ? x.toFixed(5) : x.toFixed(2)}` : '—';
}
function pct(x) {
  return Number.isFinite(x) ? `${x.toFixed(1)}%` : '—';
}
