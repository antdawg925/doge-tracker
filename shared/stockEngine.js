/**
 * Watch-only stock stop manager + short assist. Pure functions (no I/O) shared by the
 * server run (api/_stockRunner.js), the plan endpoint and scripts/check-stocks.mjs.
 * Nothing here places orders: the output is where the user should move the stop at Schwab.
 *
 * Daily candles only; stops are computed on COMPLETED daily candles (today's bar counts
 * only after the 4:00 pm ET close). The latest quote is used only for "near stop" /
 * "stop hit" / intraday squeeze checks and for P/L.
 *
 * LONG (steady movers, e.g. SPY / QQQ)
 *   initial = max(10-day swing low − buffer, entry − 2.5 ATR)   (swing low ignored if ≥ entry)
 *   trail   = highest CLOSE since entry − 2.5 ATR                (closes, not highs: one intraday
 *                                                                 spike doesn't yank the stop up)
 *   stop    = max(initial, every daily trail since entry, stored stop)  → only moves up
 * SHORT
 *   base    = 3 ATR, or 2.5 ATR when short interest ≥ 20% of float or days-to-cover ≥ 5
 *   initial = max(20-day swing high + buffer, entry + base ATR)
 *   trail   = lowest LOW since entry + m ATR; m = base, 2 once profit ≥ 20% (on a close),
 *             1.5 on a squeeze day (up close with volume ≥ 3× its 20-day average)
 *   stop    = min(initial, every daily trail since entry, stored stop)  → only moves down
 * buffer = max($0.01, 0.1 ATR). ATR = Wilder ATR(14) on daily bars.
 * Swing windows use the completed bars BEFORE the entry date (what was known at entry).
 *
 * SIZE
 *   short: gap cushion = max(1 ATR, largest overnight gap-up % in the last 60 days × price)
 *          shares = floor(risk $ / (stop − price + cushion))
 *   long:  shares = floor(risk $ / (entry − stop))  (none needed once the stop is ≥ entry)
 */
import { wilderAtr } from './atr.js';
import { etDate, sessionClosed } from './marketHours.js';

export const STOCK_RULES_VERSION = 1;

export const STOCK_RULES = Object.freeze({
  atrPeriod: 14,
  longMult: 2.5,
  shortMult: 3,
  shortSiMult: 2.5,
  shortProfitMult: 2,
  squeezeMult: 1.5,
  profitTightenPct: 0.2,
  squeezeVolX: 3,
  volAvgDays: 20,
  swingHighDays: 20,
  swingLowDays: 10,
  bufferAtr: 0.1,
  minBuffer: 0.01,
  siFloat: 0.2,
  siDaysToCover: 5,
  earningsDays: 7,
  moveAlertPct: 0.0025,
  nearAtr: 1,
  gapDays: 60,
  defaultRiskUsd: 100,
});

const R = STOCK_RULES;
const fin = (x) => Number.isFinite(x);
const pos = (x) => (Number.isFinite(x) && x > 0 ? x : null);
const DAY_MS = 86400000;

export const money = (n) => (fin(n) ? `$${n.toFixed(n < 1 ? 4 : 2)}` : '—');

/** Normalise Yahoo v8 chart JSON → daily bars with ET dates. */
export function barsFromYahooChart(json) {
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(json?.chart?.error?.description || 'No chart data');
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < ts.length; i += 1) {
    const close = q.close?.[i];
    if (!fin(close)) continue;
    const t = ts[i] * 1000;
    bars.push({
      t,
      date: etDate(t),
      open: fin(q.open?.[i]) ? q.open[i] : close,
      high: fin(q.high?.[i]) ? q.high[i] : close,
      low: fin(q.low?.[i]) ? q.low[i] : close,
      close,
      volume: fin(q.volume?.[i]) ? q.volume[i] : null,
    });
  }
  const meta = result.meta || {};
  return {
    bars,
    price: fin(meta.regularMarketPrice) ? meta.regularMarketPrice : bars.at(-1)?.close ?? null,
    priceAt: fin(meta.regularMarketTime) ? meta.regularMarketTime * 1000 : null,
    dayVolume: fin(meta.regularMarketVolume) ? meta.regularMarketVolume : null,
    name: meta.shortName || meta.longName || null,
  };
}

/** Short interest + next earnings from a quoteSummary result (defaultKeyStatistics, calendarEvents). */
export function infoFromQuoteSummary(result) {
  const raw = (v) => (v == null ? null : typeof v === 'number' ? v : fin(Number(v?.raw)) ? Number(v.raw) : null);
  const stats = result?.defaultKeyStatistics || {};
  const dates = result?.calendarEvents?.earnings?.earningsDate;
  const first = Array.isArray(dates) ? raw(dates[0]) : null;
  return {
    shortPercentOfFloat: raw(stats.shortPercentOfFloat),
    shortRatio: raw(stats.shortRatio),
    earningsAt: first ? first * 1000 : null,
    earningsEstimate: Boolean(result?.calendarEvents?.earnings?.isEarningsDateEstimate),
  };
}

/** Daily bars whose session is finished at nowMs (drops today's forming bar before 4 pm ET). */
export function completedDailyBars(bars, nowMs) {
  const today = etDate(nowMs);
  const closed = sessionClosed(nowMs);
  return (bars || []).filter((b) => b.date < today || (b.date === today && closed));
}

export function siFlag(info) {
  const si = info?.shortPercentOfFloat;
  const dtc = info?.shortRatio;
  return (fin(si) && si >= R.siFloat) || (fin(dtc) && dtc >= R.siDaysToCover);
}

/** Up close with volume ≥ 3× the previous 20 sessions' average. */
export function isSqueezeDay(bars, i) {
  if (i < 1) return false;
  const b = bars[i];
  if (!(b.close > bars[i - 1].close) || !fin(b.volume)) return false;
  const avg = avgVolume(bars, i);
  return avg != null && b.volume >= R.squeezeVolX * avg;
}

/** Average volume of the `volAvgDays` bars before index i (needs ≥ 10 samples). */
export function avgVolume(bars, i) {
  const v = [];
  for (let k = Math.max(0, i - R.volAvgDays); k < i; k += 1) if (fin(bars[k].volume)) v.push(bars[k].volume);
  return v.length >= 10 ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

/** Largest overnight gap-up (open vs prior close) over the last `days` bars, as a fraction ≥ 0. */
export function maxGapUpPct(bars, days = R.gapDays) {
  let g = 0;
  for (let i = Math.max(1, bars.length - days); i < bars.length; i += 1) {
    const pc = bars[i - 1].close;
    if (pc > 0) g = Math.max(g, bars[i].open / pc - 1);
  }
  return g;
}

export function gapCushion(bars, price, atr) {
  const gapPct = maxGapUpPct(bars);
  return { gapPct, cushion: Math.max(fin(atr) ? atr : 0, gapPct * price) };
}

export function sizeShort({ price, stop, cushion, riskUsd }) {
  const perShare = stop - price + cushion;
  if (!(perShare > 0) || !(riskUsd > 0)) return { perShare: pos(perShare), shares: null };
  return { perShare, shares: Math.floor(riskUsd / perShare) };
}

export function sizeLong({ entry, stop, riskUsd }) {
  const perShare = entry - stop;
  if (!(perShare > 0)) return { perShare: 0, shares: null, lockedIn: true };
  if (!(riskUsd > 0)) return { perShare, shares: null };
  return { perShare, shares: Math.floor(riskUsd / perShare) };
}

/**
 * Max-loss cap: your shares are final, risk_usd is the most the WHOLE position may lose.
 * Long: entry − risk/shares. Short: entry + risk/shares. No cap when risk or shares ≤ 0.
 */
export function riskCapStop({ side, entry, shares, riskUsd }) {
  const e = Number(entry);
  const q = Number(shares);
  const r = Number(riskUsd);
  if (!(e > 0) || !(q > 0) || !(r > 0)) return null;
  return side === 'short' ? e + r / q : e - r / q;
}

/**
 * Effective stop = the TIGHTER of the ATR stop and the risk-cap stop, then ratcheted against the
 * remembered stop (long up-only, short down-only). rule = which one is in charge:
 * 'atr' | 'risk' | the remembered rule when the ratchet is holding an older, tighter stop.
 */
export function effectiveStop({ side, atrStop, riskStop = null, prevStop = null, prevRule = null }) {
  const long = side === 'long';
  const tighter = (a, b) => (long ? Math.max(a, b) : Math.min(a, b));
  let stop = atrStop;
  let rule = 'atr';
  if (fin(riskStop) && (long ? riskStop > atrStop + 1e-9 : riskStop < atrStop - 1e-9)) {
    stop = riskStop;
    rule = 'risk';
  }
  let held = false;
  if (fin(prevStop) && prevStop > 0 && (long ? prevStop > stop + 1e-9 : prevStop < stop - 1e-9)) {
    stop = tighter(stop, prevStop);
    held = true;
    rule = prevRule === 'risk' || prevRule === 'atr' ? prevRule : 'atr';
  }
  return { stop, rule, held };
}

/** $ result if the whole position fills at the stop: negative = loss, positive = locked-in gain. */
export function riskIfHit({ side, entry, shares, stop }) {
  const q = Number(shares);
  const e = Number(entry);
  if (!fin(stop) || !(q > 0) || !(e > 0)) return null;
  return (side === 'short' ? e - stop : stop - e) * q;
}

/** Anchor = what the stop memory belongs to; editing side / entry / date starts a new memory. */
export const stopAnchor = (p) => `${p.side}|${Number(p.entry_price)}|${p.entry_date}`;

/**
 * Stop for one position from completed daily bars.
 * @returns {{ stop, initialStop, trail, mult, atr, atrSeriesLast, extreme, swing, squeezeAt, profitTight, si, barsSinceEntry }}
 */
export function computeStockStop({ side, entryPrice, entryDate, bars, info = null, prevStop = null }) {
  const entry = Number(entryPrice);
  if (!(entry > 0)) throw new Error('Entry price must be > 0');
  if (!bars || bars.length < R.atrPeriod + 1) throw new Error(`Need ${R.atrPeriod + 1}+ daily candles`);
  const atrS = wilderAtr(bars, R.atrPeriod);
  const n = bars.length;
  let entryIdx = bars.findIndex((b) => b.date >= entryDate);
  if (entryIdx < 0) entryIdx = n; // entered today / after the last completed bar
  const preIdx = Math.max(0, entryIdx - 1);
  const atrE = atrS[preIdx];
  const buf = Math.max(R.minBuffer, R.bufferAtr * atrE);
  const si = side === 'short' && siFlag(info);
  const prev = pos(Number(prevStop));

  if (side === 'long') {
    let swing = Infinity;
    for (let k = Math.max(0, preIdx - R.swingLowDays + 1); k <= preIdx; k += 1) swing = Math.min(swing, bars[k].low);
    const swingCand = swing - buf < entry ? swing - buf : null;
    const atrCand = entry - R.longMult * atrE;
    const initialStop = Math.max(atrCand, swingCand ?? -Infinity);
    let hc = entry;
    let walked = initialStop;
    let trail = entry - R.longMult * atrS[n - 1];
    for (let i = entryIdx; i < n; i += 1) {
      hc = Math.max(hc, bars[i].close);
      trail = hc - R.longMult * atrS[i];
      walked = Math.max(walked, trail);
    }
    const stop = Math.max(walked, prev ?? -Infinity);
    return {
      stop,
      initialStop,
      trail,
      mult: R.longMult,
      atr: atrS[n - 1],
      extreme: hc,
      swing,
      squeezeAt: null,
      profitTight: false,
      si: false,
      barsSinceEntry: n - entryIdx,
    };
  }

  if (side !== 'short') throw new Error(`Unknown side ${side}`);
  const base = si ? R.shortSiMult : R.shortMult;
  let swing = -Infinity;
  for (let k = Math.max(0, preIdx - R.swingHighDays + 1); k <= preIdx; k += 1) swing = Math.max(swing, bars[k].high);
  const initialStop = Math.max(swing + buf, entry + base * atrE);
  let ll = entry;
  let walked = initialStop;
  let trail = entry + base * atrS[n - 1];
  let mult = base;
  let squeezeAt = null;
  let profitTight = false;
  for (let i = entryIdx; i < n; i += 1) {
    const b = bars[i];
    if (b.date > entryDate) ll = Math.min(ll, b.low);
    mult = base;
    if ((entry - b.close) / entry >= R.profitTightenPct) {
      mult = Math.min(mult, R.shortProfitMult);
      profitTight = true;
    }
    if (isSqueezeDay(bars, i)) {
      mult = Math.min(mult, R.squeezeMult);
      squeezeAt = b.date;
    }
    trail = ll + mult * atrS[i];
    walked = Math.min(walked, trail);
  }
  const stop = Math.min(walked, prev ?? Infinity);
  return {
    stop,
    initialStop,
    trail,
    mult,
    atr: atrS[n - 1],
    extreme: ll,
    swing,
    squeezeAt,
    profitTight,
    si,
    barsSinceEntry: n - entryIdx,
  };
}

/**
 * "Plan a trade" at the current price (research only, nothing saved): suggested shares so that a
 * fill at the stop loses about riskUsd. Long uses the long ATR rule; short adds the gap cushion.
 */
export function planTrade({ side = 'short', bars, price, info = null, riskUsd = R.defaultRiskUsd, nowMs = Date.now() }) {
  const done = completedDailyBars(bars, nowMs);
  const today = etDate(nowMs);
  const long = side === 'long';
  const s = computeStockStop({ side: long ? 'long' : 'short', entryPrice: price, entryDate: today, bars: done, info: long ? null : info });
  let size;
  let gapPct = null;
  let cushion = null;
  if (long) {
    size = sizeLong({ entry: price, stop: s.stop, riskUsd });
  } else {
    ({ gapPct, cushion } = gapCushion(done, price, s.atr));
    size = sizeShort({ price, stop: s.stop, cushion, riskUsd });
  }
  return {
    side: long ? 'long' : 'short',
    price,
    atr: s.atr,
    atrPct: (s.atr / price) * 100,
    swingHigh: long ? null : s.swing,
    swingLow: long ? s.swing : null,
    mult: long ? R.longMult : s.si ? R.shortSiMult : R.shortMult,
    stop: s.stop,
    gapPct,
    cushion,
    perShare: size.perShare,
    shares: size.shares,
    totalRisk: size.shares != null ? size.shares * size.perShare : null,
    cost: size.shares != null ? size.shares * price : null,
    riskUsd,
    flags: flagsFor({ info, nowMs, squeezeAt: null, si: s.si }),
  };
}

/** "Plan a short" (kept for callers/tests): planTrade with side short. */
export const planShort = (args) => planTrade({ ...args, side: 'short' });

function flagsFor({ info, nowMs, squeezeAt, si, profitTight = false }) {
  const e = info?.earningsAt;
  const days = fin(e) ? (e - nowMs) / DAY_MS : null;
  return {
    si,
    siPct: info?.shortPercentOfFloat ?? null,
    daysToCover: info?.shortRatio ?? null,
    squeezeAt,
    profitTight,
    earningsAt: fin(e) ? e : null,
    earningsDate: fin(e) ? etDate(e) : null,
    earningsSoon: days != null && days >= -0.5 && days <= R.earningsDays,
    infoAvailable: Boolean(info && (fin(info.shortPercentOfFloat) || fin(info.shortRatio) || fin(info.earningsAt))),
  };
}

export const STOCK_DECISIONS = Object.freeze([
  'hold', 'stop_set', 'stop_raised', 'stop_lowered', 'near_stop', 'stop_hit', 'squeeze_warning', 'earnings_soon', 'error',
]);

/**
 * One position, one run. Carries stop memory + alert state like the DOGE bot.
 * @param position   stock_positions row
 * @param market     { bars (all daily incl. forming), price, dayVolume }
 * @param info       { shortPercentOfFloat, shortRatio, earningsAt } or null
 * @param stopRow    stock_stops row or null
 * @param alertState stock_alert_state.data or null
 */
export function evaluateStockPosition({ position, market, info = null, stopRow = null, alertState = null, nowMs, pass = 'intraday' }) {
  const side = position.side;
  const entry = Number(position.entry_price);
  const shares = Number(position.shares);
  const riskUsd = fin(Number(position.risk_usd)) ? Number(position.risk_usd) : R.defaultRiskUsd;
  const anchor = stopAnchor(position);
  const sameMemory = stopRow && stopRow.version === STOCK_RULES_VERSION && stopRow.anchor === anchor;
  const prevStop = sameMemory ? pos(Number(stopRow.stop)) : null;

  const done = completedDailyBars(market.bars, nowMs);
  // ATR stop on its own (no memory), then the tighter of it and the max-loss cap, then the ratchet.
  const s = computeStockStop({ side, entryPrice: entry, entryDate: position.entry_date, bars: done, info });
  const riskStop = riskCapStop({ side, entry, shares, riskUsd });
  const eff = effectiveStop({ side, atrStop: s.stop, riskStop, prevStop, prevRule: sameMemory ? stopRow?.data?.rule : null });
  const price = market.price;
  const stop = eff.stop;
  const atr = s.atr;
  const today = etDate(nowMs);
  const isLong = side === 'long';

  // Intraday squeeze read: today's up move with volume already ≥ 3× the 20-day average.
  let squeezeToday = null;
  const last = market.bars?.at(-1);
  if (!isLong && last && last.date === today && !done.includes(last) && done.length) {
    const avg = avgVolume(done, done.length);
    const vol = fin(market.dayVolume) ? market.dayVolume : last.volume;
    if (avg != null && fin(vol) && price > done.at(-1).close && vol >= R.squeezeVolX * avg) squeezeToday = today;
  }
  const flags = flagsFor({ info, nowMs, squeezeAt: s.squeezeAt, si: s.si, profitTight: s.profitTight });
  flags.squeezeToday = squeezeToday;
  const squeezeKey = squeezeToday || (s.squeezeAt && s.squeezeAt === done.at(-1)?.date ? s.squeezeAt : null);

  const dist = isLong ? price - stop : stop - price; // $ of room before the stop
  const hit = dist <= 0;
  const near = !hit && fin(atr) && dist <= R.nearAtr * atr;
  const pnl = (isLong ? price - entry : entry - price) * shares;
  const pnlPct = ((isLong ? price - entry : entry - price) / entry) * 100;

  const hitPnl = riskIfHit({ side, entry, shares, stop });
  const ruleLabel = eff.rule === 'risk' ? `Risk cap ${money(riskUsd).replace(/\.00$/, '')}` : 'ATR stop';

  // ---- alerts (de-duplicated through alert state)
  const st = { ...(alertState || {}) };
  if (st.anchor !== anchor) {
    for (const k of Object.keys(st)) delete st[k];
    st.anchor = anchor;
  }
  const fired = [];
  const sym = position.symbol;
  const stopWord = isLong ? 'stop' : 'buy-stop';
  const fire = (kind, title, body, level = stop) => fired.push({ kind, title, body, level, price });

  if (st.lastAlertStop == null) {
    fire('stop_set', `${sym}: set your Schwab ${stopWord} at ${money(stop)}`, `${isLong ? 'Long' : 'Short'} ${shares} @ ${money(entry)}. ${ruleLabel} in charge (max loss ${money(riskUsd)}). ATR ${money(atr)}.`);
    st.lastAlertStop = stop;
    st.lastMoveDay = today;
  } else if (
    st.lastMoveDay !== today &&
    (isLong ? stop >= st.lastAlertStop * (1 + R.moveAlertPct) : stop <= st.lastAlertStop * (1 - R.moveAlertPct))
  ) {
    fire(
      isLong ? 'raise_stop' : 'lower_stop',
      `${sym}: ${isLong ? 'raise your Schwab stop' : 'lower your Schwab buy-stop'} to ${money(stop)}`,
      `Was ${money(st.lastAlertStop)}. Price ${money(price)}.`,
    );
    st.lastAlertStop = stop;
    st.lastMoveDay = today;
  }
  if (hit) {
    if (st.hitStop !== stop) {
      fire('stop_hit', `${sym}: stop hit at ${money(price)}`, `${isLong ? 'Price is at/below' : 'Price is at/above'} your ${stopWord} ${money(stop)}. Check your Schwab fill.`);
      st.hitStop = stop;
    }
  } else if (near && st.nearDay !== today) {
    fire('near_stop', `${sym}: within 1 ATR of your ${stopWord}`, `Price ${money(price)}, ${stopWord} ${money(stop)} (${money(dist)} away, ATR ${money(atr)}).`);
    st.nearDay = today;
  }
  if (!isLong && squeezeKey && st.squeezeDay !== squeezeKey) {
    fire('squeeze_warning', `${sym}: squeeze warning`, `Up day on ≥3× average volume. Trail tightens to 1.5 ATR on the close. Buy-stop now ${money(stop)}.`);
    st.squeezeDay = squeezeKey;
  }
  if (flags.earningsSoon && st.earningsFor !== flags.earningsDate) {
    fire('earnings_soon', `${sym}: earnings ${flags.earningsDate}`, `Earnings within ${R.earningsDays} days${info?.earningsEstimate ? ' (estimated date)' : ''}. Gap risk over the report.`);
    st.earningsFor = flags.earningsDate;
  }

  // ---- decision (one per run; real decisions are kept forever, holds 90 days)
  const moved = prevStop != null && Math.abs(stop - prevStop) > 1e-9;
  const kinds = new Set(fired.map((f) => f.kind));
  let decision = 'hold';
  if (kinds.has('stop_hit')) decision = 'stop_hit';
  else if (kinds.has('squeeze_warning')) decision = 'squeeze_warning';
  else if (prevStop == null && !sameMemory) decision = 'stop_set';
  else if (moved) decision = isLong ? 'stop_raised' : 'stop_lowered';
  else if (kinds.has('near_stop')) decision = 'near_stop';
  else if (kinds.has('earnings_soon')) decision = 'earnings_soon';

  if (moved) {
    st.moveFrom = prevStop;
    st.moveDay = today;
  }
  const action = hit
    ? `Stop hit: check Schwab`
    : `${isLong ? 'Stop' : 'Buy-stop'} at ${money(stop)}`;
  const reason =
    decision === 'stop_raised' || decision === 'stop_lowered'
      ? `${isLong ? 'Raise' : 'Lower'} Schwab ${stopWord} ${money(prevStop)} → ${money(stop)}`
      : decision === 'stop_set'
        ? `Set Schwab ${stopWord} at ${money(stop)} (initial ${money(s.initialStop)})`
        : `${action}; ${money(Math.abs(dist))} ${hit ? 'past' : 'away'} (${((dist / price) * 100).toFixed(1)}%)`;

  const snapshot = {
    price,
    priceAt: market.priceAt ?? null,
    atr,
    atrPct: (atr / price) * 100,
    stop,
    initialStop: s.initialStop,
    trail: s.trail,
    mult: s.mult,
    extreme: s.extreme,
    swing: s.swing,
    dist,
    distPct: (dist / price) * 100,
    hit,
    near,
    pnl,
    pnlPct,
    lastBar: done.at(-1)?.date ?? null,
    barsSinceEntry: s.barsSinceEntry,
    flags,
    atrStop: s.stop,
    riskStop,
    riskUsd,
    rule: eff.rule,
    ruleHeld: eff.held,
    ruleLabel,
    riskIfHit: hitPnl,
    action,
    move: st.moveFrom != null ? { from: st.moveFrom, day: st.moveDay } : null,
    pass,
  };
  return {
    snapshot,
    decision,
    reason,
    fired,
    prevStop,
    stopRowNext: { version: STOCK_RULES_VERSION, anchor, stop, initial_stop: s.initialStop, data: snapshot },
    alertStateNext: st,
  };
}
