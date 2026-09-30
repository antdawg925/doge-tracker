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
  planShort,
  sizeLong,
  sizeShort,
} from '../shared/stockEngine.js';

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

ok('size: warns when your shares risk more than risk $', () => {
  const position = { symbol: 'PLUG', side: 'short', shares: 5000, entry_price: 49.5, entry_date: entryDateS, risk_usd: 100 };
  const bars = shortBars.slice(0, 32);
  const r = evaluateStockPosition({ position, market: { bars, price: bars.at(-1).close }, nowMs: afterClose(bars.at(-1)) });
  assert.equal(r.snapshot.size.overRisk, true);
  const small = evaluateStockPosition({ position: { ...position, shares: 1 }, market: { bars, price: bars.at(-1).close }, nowMs: afterClose(bars.at(-1)) });
  assert.equal(small.snapshot.size.overRisk, false);
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

console.log(`check:stocks OK (${passed} checks; rules: long ${R.longMult} ATR, short ${R.shortMult}/${R.shortSiMult}/${R.shortProfitMult}/${R.squeezeMult} ATR)`);
