/**
 * node scripts/check-stocks.mjs — watch-only stock stop manager (shared/stockEngine.js,
 * shared/marketHours.js) on fixture daily candles. State is carried between runs the way
 * api/_stockRunner.js carries the stock_stops / stock_alert_state rows.
 */
import assert from 'node:assert/strict';
import { wilderAtr } from '../shared/atr.js';
import { etDate, stockPassFor } from '../shared/marketHours.js';
import {
  STOCK_RULES as R,
  completedDailyBars,
  computeStockStop,
  evaluateStockPosition,
  gapCushion,
  isSqueezeDay,
  maxGapUpPct,
  effectiveStop,
  planShort,
  planTrade,
  riskCapStop,
  riskIfHit,
  sizeLong,
  sizeShort,
} from '../shared/stockEngine.js';
import { assertBroker, brokerFor } from '../shared/broker/index.js';
import { bookParts, closeWithPosition, initStockGuard, paperTally, stepPaperStop } from '../shared/stockPaper.js';
import { orderCheck } from '../shared/guard.js';
import { createSchwabBroker } from '../api/_schwab.js';

let passed = 0;
const ok = (name, fn) => {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
};
const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ---- fixture calendar: consecutive weekdays from Mon 2026-06-01, bars stamped 9:30 ET
function weekdays(n, start = Date.UTC(2026, 5, 1)) {
  const out = [];
  for (let t = start; out.length < n; t += 86400000) {
    const d = new Date(t).getUTCDay();
    if (d !== 0 && d !== 6) out.push(t + 13.5 * 3600000);
  }
  return out;
}
/** closes → bars with a fixed high/low spread and a steady volume. */
function mkBars(closes, { spread = 1, volume = 1_000_000, opens = null, volumes = null } = {}) {
  const ts = weekdays(closes.length);
  return closes.map((c, i) => ({
    t: ts[i],
    date: etDate(ts[i]),
    open: opens?.[i] ?? (i ? closes[i - 1] : c),
    high: c + spread,
    low: c - spread,
    close: c,
    volume: volumes?.[i] ?? volume,
  }));
}
const afterClose = (bar) => bar.t + 7 * 3600000; // 4:30 pm ET that day
const flat = (n, c) => Array.from({ length: n }, (_, i) => c + (i % 2 ? 0.2 : -0.2));

console.log('check:stocks');

// ------------------------------------------------------------ market hours
ok('market hours: intraday / after-close pass / weekend / holiday', () => {
  const at = (iso) => Date.parse(iso);
  assert.equal(stockPassFor(at('2026-09-30T13:25:00Z')), null, '9:25 ET pre-open');
  assert.equal(stockPassFor(at('2026-09-30T13:30:00Z')), 'intraday', '9:30 ET open');
  assert.equal(stockPassFor(at('2026-09-30T19:55:00Z')), 'intraday', '3:55 ET');
  assert.equal(stockPassFor(at('2026-09-30T20:05:00Z')), null, '4:05 ET: waiting for the close pass');
  assert.equal(stockPassFor(at('2026-09-30T20:15:00Z')), 'close', '4:15 ET close pass');
  assert.equal(stockPassFor(at('2026-09-30T21:00:00Z'), '2026-09-30'), null, 'close pass only once per day');
  assert.equal(stockPassFor(at('2026-10-03T15:00:00Z')), null, 'Saturday');
  assert.equal(stockPassFor(at('2026-11-26T15:00:00Z')), null, 'Thanksgiving');
  assert.equal(stockPassFor(at('2026-11-27T18:05:00Z')), null, 'early close 1 pm ET');
  assert.equal(stockPassFor(at('2026-11-27T17:55:00Z')), 'intraday', '12:55 ET on early-close day');
  assert.equal(stockPassFor(at('2026-11-27T18:15:00Z')), 'close', 'close pass 1:15 pm ET on early-close day');
});

ok('stops use completed daily candles only (today counts after 4 pm ET)', () => {
  const bars = mkBars(flat(30, 100));
  const last = bars.at(-1);
  assert.equal(completedDailyBars(bars, last.t + 3600000).length, 29, 'forming bar dropped intraday');
  assert.equal(completedDailyBars(bars, afterClose(last)).length, 30, 'kept after the close');
});

// ------------------------------------------------------------ LONG
const upThenDown = [...flat(30, 100), 101, 103, 105, 108, 110, 112, 111, 109, 106, 104, 103];
const longBars = mkBars(upThenDown);
const entryDateL = longBars[30].date;

ok('long: initial = max(swing low − buffer, entry − 2.5 ATR)', () => {
  const pre = longBars.slice(0, 30);
  const s = computeStockStop({ side: 'long', entryPrice: 100.5, entryDate: entryDateL, bars: pre });
  const atr = wilderAtr(pre, 14).at(-1);
  const swing = Math.min(...pre.slice(-10).map((b) => b.low));
  const buf = Math.max(0.01, 0.1 * atr);
  assert.ok(close(s.initialStop, Math.max(swing - buf, 100.5 - 2.5 * atr)));
  assert.equal(s.stop, s.initialStop, 'no bars since entry → stop = initial');
});

ok('long: ratchet = highest close since entry − 2.5 ATR, only moves up', () => {
  let stopRow = null;
  let alertState = null;
  const stops = [];
  const position = { symbol: 'SPY', side: 'long', shares: 10, entry_price: 100.5, entry_date: entryDateL, risk_usd: 100 };
  for (let k = 31; k <= longBars.length; k += 1) {
    const bars = longBars.slice(0, k);
    const r = evaluateStockPosition({ position, market: { bars, price: bars.at(-1).close }, stopRow, alertState, nowMs: afterClose(bars.at(-1)), pass: 'close' });
    stopRow = r.stopRowNext;
    alertState = r.alertStateNext;
    stops.push(r.snapshot.stop);
  }
  for (let i = 1; i < stops.length; i += 1) assert.ok(stops[i] >= stops[i - 1] - 1e-12, `stop moved down at ${i}`);
  // At the peak close (112) the trail uses that day's ATR.
  const peakIdx = upThenDown.indexOf(112);
  const atrPeak = wilderAtr(longBars, 14)[peakIdx];
  assert.ok(stops.at(-1) >= 112 - 2.5 * atrPeak - 1e-9, 'stop keeps the peak trail after price falls');
  assert.ok(stops.at(-1) > stops[0], 'stop rose from the initial');
  // Stored stop higher than computed is kept.
  const s = computeStockStop({ side: 'long', entryPrice: 100.5, entryDate: entryDateL, bars: longBars, prevStop: 999 });
  assert.equal(s.stop, 999);
});

// ------------------------------------------------------------ SHORT
const downThenUp = [...flat(30, 50), 49, 48, 46.5, 45, 44, 43.5, 44.5, 46, 47, 48];
const shortBars = mkBars(downThenUp, { spread: 0.5 });
const entryDateS = shortBars[30].date;

ok('short: initial = max(20-day swing high + buffer, entry + 3 ATR)', () => {
  const pre = shortBars.slice(0, 30);
  const s = computeStockStop({ side: 'short', entryPrice: 49.5, entryDate: entryDateS, bars: pre });
  const atr = wilderAtr(pre, 14).at(-1);
  const swing = Math.max(...pre.slice(-20).map((b) => b.high));
  assert.ok(close(s.initialStop, Math.max(swing + Math.max(0.01, 0.1 * atr), 49.5 + 3 * atr)));
  assert.equal(s.mult, 3);
});

ok('short: trail = lowest low since entry + 3 ATR, only moves down', () => {
  let stopRow = null;
  let alertState = null;
  const stops = [];
  const position = { symbol: 'PLUG', side: 'short', shares: 20, entry_price: 49.5, entry_date: entryDateS, risk_usd: 100 };
  for (let k = 31; k <= shortBars.length; k += 1) {
    const bars = shortBars.slice(0, k);
    const r = evaluateStockPosition({ position, market: { bars, price: bars.at(-1).close }, stopRow, alertState, nowMs: afterClose(bars.at(-1)), pass: 'close' });
    stopRow = r.stopRowNext;
    alertState = r.alertStateNext;
    stops.push(r.snapshot.stop);
  }
  for (let i = 1; i < stops.length; i += 1) assert.ok(stops[i] <= stops[i - 1] + 1e-12, `buy-stop moved up at ${i}`);
  const lowIdx = downThenUp.indexOf(43.5);
  const atrLow = wilderAtr(shortBars, 14)[lowIdx];
  assert.ok(stops.at(-1) <= 43 + 3 * atrLow + 1e-9, 'bounce does not lift the buy-stop');
  const s = computeStockStop({ side: 'short', entryPrice: 49.5, entryDate: entryDateS, bars: shortBars, prevStop: 1 });
  assert.equal(s.stop, 1, 'stored lower buy-stop is kept');
});

ok('short: tightens to 2 ATR once profit ≥ 20%', () => {
  const closes = [...flat(30, 50), 48, 45, 42, 39.5, 39];
  const bars = mkBars(closes, { spread: 0.5 });
  const entryDate = bars[30].date;
  const s = computeStockStop({ side: 'short', entryPrice: 50, entryDate, bars });
  assert.equal(s.profitTight, true);
  assert.equal(s.mult, 2);
  const atr = wilderAtr(bars, 14).at(-1);
  assert.ok(close(s.stop, Math.min(s.initialStop, 38.5 + 2 * atr)) || s.stop <= 38.5 + 2 * atr + 1e-9);
  const before = computeStockStop({ side: 'short', entryPrice: 50, entryDate, bars: bars.slice(0, 33) });
  assert.equal(before.profitTight, false, '16% profit: not yet');
  assert.equal(before.mult, 3);
});

ok('short: squeeze day (up close, volume ≥ 3× 20-day avg) tightens to 1.5 ATR + one warning', () => {
  const closes = [...flat(30, 50), 48, 47, 49];
  const volumes = closes.map((_, i) => (i === 32 ? 3_500_000 : 1_000_000));
  const bars = mkBars(closes, { spread: 0.5, volumes });
  assert.equal(isSqueezeDay(bars, 32), true);
  assert.equal(isSqueezeDay(bars, 31), false);
  const entryDate = bars[30].date;
  const s = computeStockStop({ side: 'short', entryPrice: 49.8, entryDate, bars });
  assert.equal(s.mult, 1.5);
  assert.equal(s.squeezeAt, bars[32].date);
  const noSq = computeStockStop({ side: 'short', entryPrice: 49.8, entryDate, bars: mkBars(closes, { spread: 0.5 }) });
  assert.ok(s.stop < noSq.stop, 'squeeze stop is tighter');
  const position = { symbol: 'RUN', side: 'short', shares: 10, entry_price: 49.8, entry_date: entryDate, risk_usd: 100 };
  const r1 = evaluateStockPosition({ position, market: { bars, price: s.stop - 0.2 }, nowMs: afterClose(bars.at(-1)) });
  assert.ok(r1.fired.some((f) => f.kind === 'squeeze_warning'));
  assert.equal(r1.decision, 'squeeze_warning');
  const r2 = evaluateStockPosition({ position, market: { bars, price: s.stop - 0.2 }, stopRow: r1.stopRowNext, alertState: r1.alertStateNext, nowMs: afterClose(bars.at(-1)) + 600000 });
  assert.ok(!r2.fired.some((f) => f.kind === 'squeeze_warning'), 'warning is not repeated');
});

ok('short: high short interest (≥20% float or ≥5 days to cover) starts at 2.5 ATR', () => {
  const bars = shortBars.slice(0, 30);
  const base = computeStockStop({ side: 'short', entryPrice: 49.5, entryDate: entryDateS, bars });
  const si = computeStockStop({ side: 'short', entryPrice: 49.5, entryDate: entryDateS, bars, info: { shortPercentOfFloat: 0.23 } });
  const dtc = computeStockStop({ side: 'short', entryPrice: 49.5, entryDate: entryDateS, bars, info: { shortPercentOfFloat: 0.05, shortRatio: 6 } });
  const atr = wilderAtr(bars, 14).at(-1);
  assert.equal(si.si, true);
  assert.equal(dtc.si, true);
  assert.equal(si.mult, 2.5);
  assert.ok(close(si.initialStop, 49.5 + 2.5 * atr), 'ATR leg wins here');
  assert.ok(si.initialStop < base.initialStop);
  assert.equal(computeStockStop({ side: 'short', entryPrice: 49.5, entryDate: entryDateS, bars, info: { shortPercentOfFloat: 0.1, shortRatio: 2 } }).si, false);
});

// ------------------------------------------------------------ SIZE
ok('size: short shares = floor(risk / (stop − price + gap cushion)); cushion = max(ATR, max gap-up % × price)', () => {
  const closes = flat(70, 20);
  const opens = closes.map((c, i) => (i === 50 ? closes[49] * 1.12 : i ? closes[i - 1] : c));
  const bars = mkBars(closes, { spread: 0.3, opens });
  assert.ok(close(maxGapUpPct(bars), 0.12, 1e-9));
  const atr = wilderAtr(bars, 14).at(-1);
  const { cushion, gapPct } = gapCushion(bars, 20, atr);
  assert.ok(close(cushion, 0.12 * 20) && cushion > atr, 'gap cushion beats 1 ATR');
  assert.ok(close(gapPct, 0.12));
  assert.deepEqual(sizeShort({ price: 20, stop: 22, cushion: 2.4, riskUsd: 100 }), { perShare: 4.4, shares: 22 });
  // Old gap outside 60 days is ignored → cushion falls back to ATR.
  const quiet = gapCushion(bars.slice(0, 40).concat(bars.slice(51)), 20, 0.5);
  assert.ok(quiet.cushion >= 0.5);
  const p = planShort({ bars, price: 20, riskUsd: 100, nowMs: afterClose(bars.at(-1)) });
  assert.equal(p.shares, Math.floor(100 / (p.stop - 20 + p.cushion)));
  assert.ok(p.totalRisk <= 100);
});

ok('size: long shares = floor(risk / (entry − stop)); none needed once stop ≥ entry', () => {
  assert.deepEqual(sizeLong({ entry: 100, stop: 96, riskUsd: 100 }), { perShare: 4, shares: 25 });
  assert.equal(sizeLong({ entry: 100, stop: 101, riskUsd: 100 }).lockedIn, true);
});

// ------------------------------------------------------------ MAX-LOSS CAP (shares final, risk $ = whole-position cap)
ok('risk cap: long riskStop = entry − risk/shares; short = entry + risk/shares; none without risk', () => {
  assert.equal(riskCapStop({ side: 'long', entry: 762.63, shares: 5, riskUsd: 150 }), 732.63);
  assert.ok(Math.abs(riskCapStop({ side: 'short', entry: 20, shares: 100, riskUsd: 150 }) - 21.5) < 1e-9);
  assert.equal(riskCapStop({ side: 'long', entry: 100, shares: 5, riskUsd: 0 }), null);
  assert.equal(riskCapStop({ side: 'long', entry: 100, shares: 0, riskUsd: 100 }), null);
});

ok('risk cap: effective = tighter of ATR and cap (long max, short min) and says which is in charge', () => {
  assert.deepEqual(effectiveStop({ side: 'long', atrStop: 95, riskStop: 97 }), { stop: 97, rule: 'risk', held: false });
  assert.deepEqual(effectiveStop({ side: 'long', atrStop: 98, riskStop: 97 }), { stop: 98, rule: 'atr', held: false });
  assert.deepEqual(effectiveStop({ side: 'short', atrStop: 24, riskStop: 21.5 }), { stop: 21.5, rule: 'risk', held: false });
  assert.deepEqual(effectiveStop({ side: 'short', atrStop: 21, riskStop: 21.5 }), { stop: 21, rule: 'atr', held: false });
  assert.deepEqual(effectiveStop({ side: 'long', atrStop: 95, riskStop: null }), { stop: 95, rule: 'atr', held: false });
});

ok('risk cap: ratchet never loosens (long up-only, short down-only), tighter cap may tighten', () => {
  // Remembered long stop 97 (cap). Cap loosens to 90 (more risk $) → stays 97, still labelled cap.
  assert.deepEqual(effectiveStop({ side: 'long', atrStop: 95, riskStop: 90, prevStop: 97, prevRule: 'risk' }), { stop: 97, rule: 'risk', held: true });
  // Remembered ATR stop 95; a tighter cap 97 moves it up (protective).
  assert.deepEqual(effectiveStop({ side: 'long', atrStop: 95, riskStop: 97, prevStop: 95, prevRule: 'atr' }), { stop: 97, rule: 'risk', held: false });
  // Short: remembered 21.5; looser ATR 24 & looser cap 22 → held at 21.5; tighter ATR 21 → 21.
  assert.equal(effectiveStop({ side: 'short', atrStop: 24, riskStop: 22, prevStop: 21.5, prevRule: 'risk' }).stop, 21.5);
  assert.deepEqual(effectiveStop({ side: 'short', atrStop: 21, riskStop: 22, prevStop: 21.5, prevRule: 'risk' }), { stop: 21, rule: 'atr', held: false });
});

ok('risk cap: evaluate uses the tighter stop end to end, remembers the rule, never loosens on a bigger cap', () => {
  const bars = longBars.slice(0, 32);
  const nowMs = afterClose(bars.at(-1));
  const base = { symbol: 'QQQ', side: 'long', shares: 10, entry_price: 100.5, entry_date: entryDateL };
  const loose = evaluateStockPosition({ position: { ...base, risk_usd: 100000 }, market: { bars, price: bars.at(-1).close }, nowMs });
  const atrStop = loose.snapshot.atrStop;
  assert.equal(loose.snapshot.rule, 'atr');
  assert.equal(loose.snapshot.stop, atrStop);
  // Cap tight enough to beat the ATR stop: shares × (entry − atrStop) − 5 $.
  const riskUsd = Math.max(1, 10 * (100.5 - atrStop) - 5);
  const capped = evaluateStockPosition({ position: { ...base, risk_usd: riskUsd }, market: { bars, price: bars.at(-1).close }, nowMs, stopRow: loose.stopRowNext });
  assert.ok(atrStop < 100.5, 'fixture: ATR stop below entry so the cap can win');
  {
    assert.equal(capped.snapshot.rule, 'risk');
    assert.ok(Math.abs(capped.snapshot.stop - (100.5 - riskUsd / 10)) < 1e-9);
    assert.ok(capped.snapshot.stop > atrStop);
    assert.ok(Math.abs(capped.snapshot.riskIfHit + riskUsd) < 1e-6, 'risk if hit = −cap when the cap is in charge');
  }
  // Raise the cap again → stop held (never loosens), still labelled the cap.
  const again = evaluateStockPosition({ position: { ...base, risk_usd: 100000 }, market: { bars, price: bars.at(-1).close }, nowMs, stopRow: capped.stopRowNext });
  assert.equal(again.snapshot.stop, capped.snapshot.stop);
  assert.equal(again.snapshot.ruleHeld, atrStop < 100.5);
  // Short: cap above price but below the ATR buy-stop → cap is in charge.
  const sb = shortBars.slice(0, 30);
  const sp = { symbol: 'PLUG', side: 'short', shares: 100, entry_price: sb.at(-1).close, entry_date: sb.at(-1).date };
  const sAtr = evaluateStockPosition({ position: { ...sp, risk_usd: 1e6 }, market: { bars: sb, price: sb.at(-1).close }, nowMs: afterClose(sb.at(-1)) }).snapshot.atrStop;
  const sRisk = ((sAtr - sp.entry_price) / 2) * 100;
  const s2 = evaluateStockPosition({ position: { ...sp, risk_usd: sRisk }, market: { bars: sb, price: sb.at(-1).close }, nowMs: afterClose(sb.at(-1)) });
  assert.equal(s2.snapshot.rule, 'risk');
  assert.ok(s2.snapshot.stop < sAtr);
  assert.ok(Math.abs(s2.snapshot.riskIfHit + sRisk) < 1e-6);
});

ok('plan a trade: long = long ATR stop, shares = floor(max loss / (price − stop)), cost = shares × price; short unchanged', () => {
  const bars = longBars.slice(0, 40);
  const price = bars.at(-1).close;
  const nowMs = afterClose(bars.at(-1));
  const p = planTrade({ side: 'long', bars, price, riskUsd: 100, nowMs });
  const s = computeStockStop({ side: 'long', entryPrice: price, entryDate: etDate(nowMs), bars: completedDailyBars(bars, nowMs) });
  assert.equal(p.stop, s.stop);
  assert.ok(Math.abs(p.perShare - (price - p.stop)) < 1e-9);
  assert.equal(p.shares, Math.floor(100 / p.perShare));
  assert.ok(Math.abs(p.cost - p.shares * price) < 1e-9);
  assert.ok(p.totalRisk <= 100);
  const sb = shortBars.slice(0, 30);
  assert.deepEqual(planTrade({ side: 'short', bars: sb, price: 20, nowMs: afterClose(sb.at(-1)) }).shares, planShort({ bars: sb, price: 20, nowMs: afterClose(sb.at(-1)) }).shares);
});

ok('risk if hit: shares × |entry − stop| as a loss, or a locked gain past breakeven', () => {
  assert.equal(riskIfHit({ side: 'long', entry: 762.63, shares: 5, stop: 732.63 }).toFixed(2), '-150.00');
  assert.equal(riskIfHit({ side: 'long', entry: 100, shares: 10, stop: 104 }), 40);
  assert.equal(riskIfHit({ side: 'short', entry: 20, shares: 100, stop: 21.5 }).toFixed(2), '-150.00');
  assert.equal(riskIfHit({ side: 'short', entry: 20, shares: 100, stop: 18 }), 200);
  assert.equal(riskIfHit({ side: 'long', entry: 100, shares: 10, stop: null }), null);
});

// ------------------------------------------------------------ ALERTS
ok('alerts: set once, raise ≥0.25% max once per day, near/hit de-duplicated', () => {
  const position = { symbol: 'QQQ', side: 'long', shares: 10, entry_price: 100.5, entry_date: entryDateL, risk_usd: 100 };
  // Day k morning (bars through k−1): first run → "set your stop".
  const dayK = longBars[34];
  const morningK = dayK.t + 30 * 60000;
  let r = evaluateStockPosition({ position, market: { bars: longBars.slice(0, 35), price: 107 }, nowMs: morningK });
  assert.deepEqual(r.fired.map((f) => f.kind), ['stop_set']);
  assert.equal(r.decision, 'stop_set');
  // Day k after-close pass: stop rises on the completed candle, but one move alert per day max.
  const barsB = longBars.slice(0, 35);
  r = evaluateStockPosition({ position, market: { bars: barsB, price: 110 }, stopRow: r.stopRowNext, alertState: r.alertStateNext, nowMs: afterClose(dayK), pass: 'close' });
  assert.equal(r.fired.filter((f) => f.kind === 'raise_stop').length, 0, 'max one move alert per day');
  assert.equal(r.decision, 'stop_raised', 'the move is still logged');
  // Next morning → raise alert with the new level.
  const nowC = afterClose(dayK) + 18 * 3600000;
  r = evaluateStockPosition({ position, market: { bars: barsB, price: 110 }, stopRow: r.stopRowNext, alertState: r.alertStateNext, nowMs: nowC });
  const raise = r.fired.find((f) => f.kind === 'raise_stop');
  assert.ok(raise && raise.title.includes('raise your Schwab stop to'), 'raise alert fires');
  // Tiny move (< 0.25%) the following day → no alert.
  let st = r.alertStateNext;
  let row = r.stopRowNext;
  const tinyRow = { ...row, stop: row.stop * 0.999 };
  r = evaluateStockPosition({ position, market: { bars: barsB, price: 110 }, stopRow: tinyRow, alertState: { ...st, lastAlertStop: row.stop * 0.999, lastMoveDay: '2000-01-01' }, nowMs: nowC + 86400000 });
  assert.equal(r.fired.filter((f) => f.kind === 'raise_stop').length, 0, '0.1% move: no spam');
  // Near stop: once per day.
  const stop = row.stop;
  const atr = r.snapshot.atr;
  r = evaluateStockPosition({ position, market: { bars: barsB, price: stop + 0.5 * atr }, stopRow: row, alertState: st, nowMs: nowC + 60000 });
  assert.ok(r.fired.some((f) => f.kind === 'near_stop'));
  st = r.alertStateNext;
  r = evaluateStockPosition({ position, market: { bars: barsB, price: stop + 0.4 * atr }, stopRow: row, alertState: st, nowMs: nowC + 120000 });
  assert.ok(!r.fired.some((f) => f.kind === 'near_stop'), 'near alert once per day');
  // Stop hit: once per stop level.
  r = evaluateStockPosition({ position, market: { bars: barsB, price: stop - 0.1 }, stopRow: row, alertState: st, nowMs: nowC + 180000 });
  assert.ok(r.fired.some((f) => f.kind === 'stop_hit'));
  assert.equal(r.decision, 'stop_hit');
  st = r.alertStateNext;
  r = evaluateStockPosition({ position, market: { bars: barsB, price: stop - 0.3 }, stopRow: row, alertState: st, nowMs: nowC + 240000 });
  assert.equal(r.fired.length, 0, 'hit not repeated');
  // Editing the entry starts a new stop memory + alert state.
  r = evaluateStockPosition({ position: { ...position, entry_price: 101 }, market: { bars: barsB, price: 110 }, stopRow: row, alertState: st, nowMs: nowC + 300000 });
  assert.equal(r.prevStop, null);
  assert.ok(r.fired.some((f) => f.kind === 'stop_set'));
});

ok('alerts: short "lower your Schwab buy-stop" + earnings within 7 days (once per date)', () => {
  const position = { symbol: 'SNAP', side: 'short', shares: 10, entry_price: 49.5, entry_date: entryDateS, risk_usd: 100 };
  const b1 = shortBars.slice(0, 32);
  const now1 = afterClose(b1.at(-1));
  const info = { shortPercentOfFloat: 0.05, shortRatio: 1, earningsAt: now1 + 3 * 86400000 };
  let r = evaluateStockPosition({ position, market: { bars: b1, price: 48 }, info, nowMs: now1 });
  assert.ok(r.fired.some((f) => f.kind === 'earnings_soon'));
  assert.equal(r.snapshot.flags.earningsSoon, true);
  const b2 = shortBars.slice(0, 35);
  const now2 = afterClose(b2.at(-1));
  r = evaluateStockPosition({ position, market: { bars: b2, price: 45 }, info, stopRow: r.stopRowNext, alertState: r.alertStateNext, nowMs: now2 });
  assert.ok(r.fired.some((f) => f.kind === 'lower_stop' && f.title.includes('lower your Schwab buy-stop to')));
  assert.ok(!r.fired.some((f) => f.kind === 'earnings_soon'), 'earnings heads-up once per date');
  assert.equal(r.decision, 'stop_lowered');
  const far = evaluateStockPosition({ position, market: { bars: b1, price: 48 }, info: { earningsAt: now1 + 20 * 86400000 }, nowMs: now1 });
  assert.equal(far.snapshot.flags.earningsSoon, false);
});


// ------------------------------------------------------------ PAPER TRADING (broker adapter + guard)
const okA = async (name, fn) => {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
};
const armed = (over = {}) => ({ ...initStockGuard({ nowIso: '2026-09-01T00:00:00Z' }), ...over });
const pos = (over = {}) => ({ id: over.id || '11111111-aaaa-bbbb-cccc-000000000001', user_id: 'u1', symbol: 'SPY', side: 'long', shares: 10, entry_price: 100, entry_date: '2026-06-01', risk_usd: 100, status: 'active', ...over });
async function step(broker, position, snapshot, guard, nowMs, extra = {}) {
  return stepPaperStop({ broker, position, snapshot, guard, nowMs, activeIds: new Set([position.id]), ...extra });
}

await okA('paper: broker adapter implements placeStop / modifyStop / cancel / getPositions / syncFills', async () => {
  const b = assertBroker(brokerFor(null, { nowIso: '2026-09-30T20:00:00Z' }));
  assert.equal(b.kind, 'paper');
  assert.deepEqual(await b.getPositions(), []);
  const sch = assertBroker(createSchwabBroker());
  await assert.rejects(sch.placeStop({}), /not connected/, 'Schwab placeholder has the same interface, not live');
});

await okA('paper: stop placed on entry, then MODIFIED automatically when the after-close pass moves it', async () => {
  const position = pos({ symbol: 'SPY', entry_price: 100.5, entry_date: entryDateL });
  let broker = brokerFor(null, { nowIso: new Date(afterClose(longBars[30])).toISOString() });
  let guard = armed();
  let stopRow = null;
  const stops = [];
  const events = [];
  for (let k = 31; k <= 36; k += 1) {
    const bars = longBars.slice(0, k);
    const now = afterClose(bars.at(-1));
    const r = evaluateStockPosition({ position, market: { bars, price: bars.at(-1).close }, stopRow, nowMs: now, pass: 'close' });
    stopRow = r.stopRowNext;
    broker = brokerFor(null, { orders: broker.orders(), nowIso: new Date(now).toISOString() });
    const s = await step(broker, position, r.snapshot, guard, now, { canFill: false });
    guard = s.guard;
    events.push(...s.events);
    stops.push(r.snapshot.stop);
  }
  assert.equal(events[0].kind, 'placed');
  const mods = events.filter((e) => e.kind === 'modified');
  assert.ok(mods.length >= 3, 'order follows the rising stop');
  for (const m of mods) assert.ok(m.new_price > m.old_price, 'long: only raised');
  assert.ok(Math.abs(broker.get(position.id).stop_price - stops.at(-1)) < 1e-9, 'working order sits at the computed stop');
  assert.equal(broker.get(position.id).status, 'working');
  assert.ok(!events.some((e) => e.kind === 'filled'), 'no fills outside market hours');
});

await okA('paper: long fill at the price the check saw (below the stop), realized P/L', async () => {
  const position = pos();
  const now = Date.parse('2026-09-30T15:00:00Z');
  const broker = brokerFor(null, { nowIso: new Date(now).toISOString() });
  let r = await step(broker, position, { stop: 95, price: 99 }, armed(), now, { canFill: true });
  assert.equal(r.fill, null);
  r = await step(broker, position, { stop: 95, price: 94.6 }, r.guard, now + 300000, { canFill: true });
  assert.equal(r.fill.price, 94.6, 'fills at the quote, not 95');
  const o = broker.get(position.id);
  assert.equal(o.status, 'filled');
  assert.ok(Math.abs(o.realized_pnl - (94.6 - 100) * 10) < 1e-9);
  assert.ok(r.events.some((e) => e.kind === 'filled' && e.fill_price === 94.6 && e.old_price === 95));
  const again = await step(broker, position, { stop: 95, price: 93 }, r.guard, now + 600000, { canFill: true });
  assert.equal(again.events.length, 0, 'filled once');
});

await okA('paper: a max-loss cap stop that is hit closes the WHOLE position', async () => {
  const position = pos({ shares: 5, entry_price: 762.63, risk_usd: 150 });
  const cap = riskCapStop({ side: 'long', entry: 762.63, shares: 5, riskUsd: 150 });
  const { stop } = effectiveStop({ side: 'long', atrStop: 700, riskStop: cap });
  assert.equal(stop, cap);
  const now = Date.parse('2026-09-30T15:00:00Z');
  const broker = brokerFor(null, { nowIso: new Date(now).toISOString() });
  let r = await step(broker, position, { stop, price: 760 }, armed(), now, { canFill: true });
  r = await step(broker, position, { stop, price: 732 }, r.guard, now + 300000, { canFill: true });
  assert.equal(r.fill.units, 5, 'all 5 shares');
  const o = broker.get(position.id);
  assert.equal(o.status, 'filled');
  assert.equal(Number(o.qty), 5);
  assert.ok(Math.abs(o.realized_pnl - (732 - 762.63) * 5) < 1e-9);
});

await okA('paper: short buy-stop fill at the quote (above the stop)', async () => {
  const position = pos({ symbol: 'PLUG', side: 'short', shares: 300, entry_price: 2.05 });
  const now = Date.parse('2026-09-30T15:00:00Z');
  const broker = brokerFor(null, { nowIso: new Date(now).toISOString() });
  let r = await step(broker, position, { stop: 2.1, price: 1.97 }, armed(), now, { canFill: true });
  assert.equal(broker.get(position.id).order_side, 'buy');
  r = await step(broker, position, { stop: 2.1, price: 2.13 }, r.guard, now + 300000, { canFill: true });
  assert.equal(r.fill.price, 2.13);
  assert.ok(Math.abs(broker.get(position.id).realized_pnl - (2.05 - 2.13) * 300) < 1e-9);
});

await okA('paper: gap through the stop at the open fills at the open price (first check of the day)', async () => {
  const position = pos({ symbol: 'RUN', side: 'short', shares: 50, entry_price: 10 });
  const day1 = Date.parse('2026-09-29T19:00:00Z');
  const broker = brokerFor(null, { nowIso: new Date(day1).toISOString() });
  let r = await step(broker, position, { stop: 11, price: 10.2 }, armed(), day1, { canFill: true });
  const day2 = Date.parse('2026-09-30T13:35:00Z'); // 9:35 ET
  r = await step(broker, position, { stop: 11, price: 12.4 }, r.guard, day2, { canFill: true, open: 12.5 });
  assert.equal(r.fill.price, 12.4, 'filled at the gap price, not the $11 stop');
  assert.equal(r.fill.gap, true);
  assert.ok(r.events.find((e) => e.kind === 'filled').reason.startsWith('Gapped through'));
  assert.ok(Math.abs(r.fill.pnl - (10 - 12.4) * 50) < 1e-9);
});

await okA('paper: a losing fill locks the stocks book (max loss $1) — separate from DOGE', async () => {
  const position = pos();
  const now = Date.parse('2026-09-30T15:00:00Z');
  const broker = brokerFor(null, { nowIso: new Date(now).toISOString() });
  let r = await step(broker, position, { stop: 95, price: 99 }, armed(), now, { canFill: true });
  r = await step(broker, position, { stop: 95, price: 94 }, r.guard, now + 300000, { canFill: true });
  assert.ok(r.lockedNow && r.guard.locked, 'locked');
  assert.ok(Math.abs(r.guard.baseline_value - 1000) < 1e-9, 'baseline = entry basis 10 × $100');
  assert.ok(/book \$940\.00 is below starting \$1,000\.00/.test(r.guard.lock_reason), r.guard.lock_reason);
  assert.ok(Math.abs(r.guard.realized_pnl + 60) < 1e-9);
});

for (const [label, flag] of [['locked', { locked: true, lock_reason: 'test' }], ['paused', { paused: true }]]) {
  await okA(`paper: ${label} → new entries / re-entries blocked, tightening + stop fills still allowed`, async () => {
    const g = armed(flag);
    const now = Date.parse('2026-09-30T15:00:00Z');
    // New entry while blocked
    const nb = brokerFor(null, { nowIso: new Date(now).toISOString() });
    let r = await step(nb, pos({ id: 'new-1' }), { stop: 95, price: 99 }, g, now, { canFill: true });
    assert.deepEqual(r.events.map((e) => e.kind), ['blocked']);
    assert.equal(nb.get('new-1').status, 'blocked');
    r = await step(nb, pos({ id: 'new-1' }), { stop: 95, price: 99 }, g, now + 300000, { canFill: true });
    assert.equal(r.events.length, 0, 'blocked logged once');
    // Working order placed before the lock
    const position = pos({ id: 'w-1' });
    const b = brokerFor(null, { nowIso: new Date(now).toISOString() });
    await step(b, position, { stop: 95, price: 99 }, armed(), now, { canFill: false });
    r = await step(b, position, { stop: 96.5, price: 99 }, g, now + 60000, { canFill: false });
    const mod = r.events.find((e) => e.kind === 'modified');
    assert.ok(mod && mod.new_price === 96.5, 'tightening allowed');
    assert.equal(mod.guard_note, `protective: allowed while ${label}`);
    // Armed: an unrealized drawdown alone doesn't block entries (the lock is decided on fills)
    assert.equal(orderCheck(armed({ baseline_value: 1000 }), { kind: 'entry', bookValueNow: 900 }).allowed, true);
    // Loosening is risk-adding → blocked
    assert.equal(orderCheck(g, { kind: 'loosen_stop' }).allowed, false);
    // Re-entry (edited entry) → old trade closed, new one blocked
    r = await step(b, { ...position, entry_price: 98 }, { stop: 96.5, price: 99 }, g, now + 120000, { canFill: false });
    assert.deepEqual(r.events.map((e) => e.kind), ['closed', 'blocked']);
    assert.equal(b.get('w-1').status, 'blocked');
    assert.ok(Math.abs(b.get('w-1').data.prior_realized - (99 - 100) * 10) < 1e-9, 'old trade realized');
    // Stop fill while blocked is protective
    const fb = brokerFor(null, { nowIso: new Date(now).toISOString() });
    await step(fb, pos({ id: 'f-1' }), { stop: 95, price: 99 }, armed(), now, { canFill: false });
    r = await step(fb, pos({ id: 'f-1' }), { stop: 95, price: 94 }, g, now + 60000, { canFill: true });
    assert.ok(r.fill, 'stop fill allowed');
    assert.equal(r.events.find((e) => e.kind === 'filled').guard_note, `protective: allowed while ${label}`);
    // Unblocked → the blocked entry is placed on the next run
    r = await step(nb, pos({ id: 'new-1' }), { stop: 95, price: 99 }, armed(), now + 900000, { canFill: false });
    assert.deepEqual(r.events.map((e) => e.kind), ['placed']);
  });
}

await okA('paper: tally = realized + unrealized vs buy & hold (no stop)', async () => {
  const orders = [
    { position_id: 'a', position_side: 'long', qty: 10, entry_price: 100, status: 'working', last_price: 110 },
    { position_id: 'b', position_side: 'short', qty: 20, entry_price: 50, status: 'filled', fill_price: 52, realized_pnl: -40, last_price: 45 },
    { position_id: 'c', position_side: 'long', qty: 5, entry_price: 10, status: 'closed', fill_price: 12, realized_pnl: 10, last_price: 12 },
    { position_id: 'd', position_side: 'long', qty: 5, entry_price: 10, status: 'blocked', last_price: 30 },
    { position_id: 'e', position_side: 'long', qty: 1, entry_price: 10, status: 'working', last_price: 11, data: { prior_realized: -3, prior_hold: 2 } },
  ];
  const t = paperTally(orders);
  assert.ok(Math.abs(t.paper - (100 - 40 + 10 + 0 + (-3 + 1))) < 1e-9, `paper ${t.paper}`);
  assert.ok(Math.abs(t.hold - (100 + 100 + 10 + 0 + (2 + 1))) < 1e-9, `hold ${t.hold}`);
  assert.ok(Math.abs(t.realized - (-40 + 10 - 3)) < 1e-9);
  assert.ok(Math.abs(t.unrealized - (100 + 1)) < 1e-9);
  assert.equal(t.working, 2);
  const parts = bookParts(orders, new Set(['a', 'b', 'd', 'e']));
  assert.ok(Math.abs(parts.basis - (1000 + 1000 + 10)) < 1e-9, 'basis: active, entered positions only');
  assert.ok(Math.abs(parts.book - (parts.basis + t.paper)) < 1e-9);
  // Real position closed while working → paper closes at the last price
  const b = brokerFor(null, { orders: [orders[0]], nowIso: '2026-09-30T20:00:00Z' });
  const ev = await closeWithPosition({ broker: b, order: orders[0], guard: armed({ locked: true }), nowMs: Date.parse('2026-09-30T20:00:00Z') });
  assert.equal(ev[0].kind, 'closed');
  assert.equal(b.get('a').status, 'closed');
  assert.ok(Math.abs(b.get('a').realized_pnl - 100) < 1e-9);
});

console.log(`check:stocks OK (${passed} checks; rules: long ${R.longMult} ATR, short ${R.shortMult}/${R.shortSiMult}/${R.shortProfitMult}/${R.squeezeMult} ATR)`);
