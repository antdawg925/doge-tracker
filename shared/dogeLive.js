/**
 * DOGE live plan engine (pure: no fetch, no DB). The bot's MAIN job: keep ONE real Kraken
 * stop-loss under ALL the DOGE Anthony holds, and only ever move it UP.
 *
 * Bottom stop (always on)
 *  - Starts at config.bottomStop (his choice, e.g. $0.089). state.stopPx is the committed level.
 *  - Auto-raise: effective = max(current, ATR trail, account-lock price), never lowered (also
 *    not after fills: when DOGE is sold the stop RESIZES, the price stays).
 *      ATR trail  = highest completed 4h close since the plan started − daily ATR14 × 3
 *                   (×2 when the last daily close is 20–50% above its SMA20, ×1.5 above 50%).
 *      Lock price = (lock − USD) ÷ DOGE, lock = start + 70% × (HWM − start) once the account
 *                   reached 1.5× start; the lock $ only rises.
 *    Raises < minStepPct are skipped (no churn), > maxStepPct per run are capped.
 *    A raise that would put the stop at/above the bid is skipped (kept where it is) + flagged.
 *  - Manual raise / lower happen in the API routes (lower = owner + typed confirmation).
 *  - Quantity = DOGE available to the bot − DOGE in the bot's own resting sells (zone / manual
 *    sell), so stop + limits never oversell. Grows at once when DOGE is added (his buys fill).
 *  - Placement safety: a stop at/above the bid is never placed; the plan flags it loudly and
 *    sells nothing (no market dump without his confirmation).
 *  - Stop fills → status "stopped": alert and wait. No re-entry ("Start new plan" re-arms).
 *
 * Optional, OFF by default (he manages tops and dips himself): zone sells, the breakout pot buy.
 * Manual "Sell 30% now": one marketable IOC sell limit (bid − sellSlipPct), stop shrinks first.
 */

export const KRAKEN_XDGUSD = Object.freeze({
  pair: 'XDGUSD',
  priceDecimals: 7, // pair_decimals / tick_size 0.0000001 (AssetPairs, verified Oct 2026)
  volumeDecimals: 8, // lot_decimals
  orderMin: 50, // ordermin (DOGE)
  costMin: 0.5, // costmin (USD)
});

export const DEFAULT_LIVE_CONFIG = Object.freeze({
  bottomStop: null,
  trailEnabled: true,
  startValue: 19000,
  startDate: null,
  startDoge: 110000,
  startUsd: 9000,
  potEnabled: false,
  potUsd: 9000,
  zonesEnabled: false,
  breakoutDays: 20,
  smaDays: 50,
  btcSmaDays: 50,
  atrDays: 14,
  trailAtr: Object.freeze({ base: 3, mid: 2, high: 1.5, midExt: 0.2, highExt: 0.5 }),
  lockActivate: 1.5,
  lockKeep: 0.7,
  zones: Object.freeze([
    Object.freeze({ price: 0.2, keepPct: 40 }),
    Object.freeze({ price: 0.3, keepPct: 20 }),
    Object.freeze({ price: 0.4, keepPct: 10 }),
  ]),
  zoneArmPct: 5,
  minStepPct: 0.5,
  maxStepPct: 15,
  dailyActionCap: 20,
  feePct: 0.4,
  potLimitPct: 0.5,
  sellPct: 30,
  sellSlipPct: 0.5,
});

const DAY = 86400000;
const H4 = 4 * 3600000;
const EPS = 1e-9;
const fin = (v) => Number.isFinite(Number(v)) && v !== null && v !== '';
const num = (v, d) => (fin(v) ? Number(v) : d);
const pos = (v, d) => (fin(v) && Number(v) > 0 ? Number(v) : d);
const bool = (v, d) => (typeof v === 'boolean' ? v : d);

export const floorTo = (v, dp) => Math.floor(v * 10 ** dp + 1e-6) / 10 ** dp;
export const ceilTo = (v, dp) => Math.ceil(v * 10 ** dp - 1e-6) / 10 ** dp;
export const roundTo = (v, dp) => Math.round(v * 10 ** dp) / 10 ** dp;
export const priceStr = (p, rules = KRAKEN_XDGUSD) => Number(p).toFixed(rules.priceDecimals);
export const volStr = (v, rules = KRAKEN_XDGUSD) => floorTo(Number(v), rules.volumeDecimals).toFixed(rules.volumeDecimals);
export const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Clean / default a user's plan config. */
export function normalizeLiveConfig(c = {}, nowMs = Date.now()) {
  const d = DEFAULT_LIVE_CONFIG;
  const pa = c.trailAtr || c.potAtr || {};
  const zonesIn = Array.isArray(c.zones) && c.zones.length ? c.zones : d.zones;
  const zones = zonesIn
    .map((z) => ({ price: pos(z?.price, null), keepPct: Math.min(100, Math.max(0, num(z?.keepPct, NaN))) }))
    .filter((z) => z.price && Number.isFinite(z.keepPct))
    .sort((a, b) => a.price - b.price)
    .slice(0, 6);
  const startDate =
    typeof c.startDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(c.startDate) ? c.startDate : utcDay(nowMs);
  return {
    bottomStop: pos(c.bottomStop, null) ? roundTo(Number(c.bottomStop), KRAKEN_XDGUSD.priceDecimals) : null,
    trailEnabled: bool(c.trailEnabled, d.trailEnabled),
    startValue: pos(c.startValue, d.startValue),
    startDate,
    startDoge: Math.max(0, num(c.startDoge, d.startDoge)),
    startUsd: Math.max(0, num(c.startUsd, d.startUsd)),
    potEnabled: bool(c.potEnabled, d.potEnabled),
    potUsd: Math.max(0, num(c.potUsd, d.potUsd)),
    zonesEnabled: bool(c.zonesEnabled, d.zonesEnabled),
    breakoutDays: Math.round(Math.min(120, Math.max(5, num(c.breakoutDays, d.breakoutDays)))),
    smaDays: Math.round(Math.min(200, Math.max(5, num(c.smaDays, d.smaDays)))),
    btcSmaDays: Math.round(Math.min(200, Math.max(5, num(c.btcSmaDays, d.btcSmaDays)))),
    atrDays: Math.round(Math.min(50, Math.max(5, num(c.atrDays, d.atrDays)))),
    trailAtr: {
      base: pos(pa.base, d.trailAtr.base),
      mid: pos(pa.mid, d.trailAtr.mid),
      high: pos(pa.high, d.trailAtr.high),
      midExt: num(pa.midExt, d.trailAtr.midExt),
      highExt: num(pa.highExt, d.trailAtr.highExt),
    },
    lockActivate: Math.max(1.01, num(c.lockActivate, d.lockActivate)),
    lockKeep: Math.min(0.99, Math.max(0.05, num(c.lockKeep, d.lockKeep))),
    zones,
    zoneArmPct: Math.min(25, Math.max(0.5, num(c.zoneArmPct, d.zoneArmPct))),
    minStepPct: Math.min(5, Math.max(0, num(c.minStepPct, d.minStepPct))),
    maxStepPct: Math.min(50, Math.max(1, num(c.maxStepPct, d.maxStepPct))),
    dailyActionCap: Math.round(Math.min(100, Math.max(1, num(c.dailyActionCap, d.dailyActionCap)))),
    feePct: Math.min(2, Math.max(0, num(c.feePct, d.feePct))),
    potLimitPct: Math.min(3, Math.max(0.05, num(c.potLimitPct, d.potLimitPct))),
    sellPct: Math.min(100, Math.max(1, num(c.sellPct, d.sellPct))),
    sellSlipPct: Math.min(3, Math.max(0.05, num(c.sellSlipPct, d.sellSlipPct))),
  };
}

/** Fresh plan state (also used by "Start new plan"). */
export function initLiveState(config, nowMs = Date.now()) {
  return {
    planId: `p${nowMs.toString(36)}`,
    status: 'active',
    startedAt: new Date(nowMs).toISOString(),
    endedAt: null,
    endReason: null,
    stopPx: config.bottomStop ?? null,
    stopSetAt: config.bottomStop ? new Date(nowMs).toISOString() : null,
    stopReason: config.bottomStop ? 'Bottom stop (your choice)' : null,
    stopHist: config.bottomStop ? [{ at: new Date(nowMs).toISOString(), from: null, to: config.bottomStop, by: 'user', reason: 'Bottom stop (your choice)' }] : [],
    hc: null,
    hwm: config.startValue,
    lock: null,
    lockActive: false,
    lockActivatedAt: null,
    umax: config.startDoge,
    pot: { status: config.potEnabled && config.potUsd > 0 ? 'waiting' : 'off', qty: 0, price: null, at: null, triggerDay: null },
    breakoutCheckedDay: null,
    zonesDone: config.zones.map(() => false),
    orders: { stop: null, zone: null, pot: null, sell: null },
    ordersMode: 'dry',
    pendingSell: null,
    virtual: { doge: config.startDoge, usd: config.startUsd },
    actions: { day: null, count: 0 },
    flags: [],
  };
}

/** Record a committed stop level change (raise; lower only via the explicit route). */
export function setStop(state, to, { by = 'bot', reason = '', nowIso = new Date().toISOString() } = {}) {
  const from = state.stopPx ?? null;
  state.stopPx = to;
  state.stopSetAt = nowIso;
  state.stopReason = reason;
  state.stopHist = [...(state.stopHist || []), { at: nowIso, from, to, by, reason }].slice(-20);
  return { from, to };
}

// ---------------------------------------------------------------- indicators (daily, UTC)
export const completed = (bars, periodMs, nowMs) => (bars || []).filter((b) => b.t + periodMs <= nowMs);

export function sma(values, n) {
  if (values.length < n) return null;
  let s = 0;
  for (let i = values.length - n; i < values.length; i++) s += values[i];
  return s / n;
}

/** Wilder-style ATR as in the backtest (EWM alpha 1/n, seeded with the first TR). */
export function ewmAtr(bars, n = 14) {
  let prev = null;
  let out = null;
  bars.forEach((b, i) => {
    const pc = i ? bars[i - 1].close : null;
    const tr = pc == null ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
    prev = prev == null ? tr : prev + (tr - prev) / n;
    out = prev;
  });
  return out;
}

/**
 * Daily signal from COMPLETED daily candles: the last completed day's close vs the prior
 * N-day closing high, SMA50 (incl. that day) and BTC's close vs its SMA50; plus "trigger"
 * = the close needed on the day in progress (highest of the last N completed closes).
 */
export function dailySignal({ daily, btcDaily, config, nowMs }) {
  const d = completed(daily, DAY, nowMs);
  const b = completed(btcDaily, DAY, nowMs);
  const N = config.breakoutDays;
  if (d.length < Math.max(N + 1, config.smaDays)) return null;
  const closes = d.map((x) => x.close);
  const last = d[d.length - 1];
  const prior = closes.slice(-N - 1, -1);
  const hiPrior = Math.max(...prior);
  const sma50 = sma(closes, config.smaDays);
  const sma20 = sma(closes, 20);
  const atr = ewmAtr(d, config.atrDays);
  const bc = b.map((x) => x.close);
  const btcLast = b.length ? b[b.length - 1] : null;
  const btcSma = sma(bc, config.btcSmaDays);
  const btcSameDay = btcLast && utcDay(btcLast.t) === utcDay(last.t);
  const trigger = Math.max(...closes.slice(-N));
  return {
    day: utcDay(last.t),
    close: last.close,
    hiPrior,
    newHigh: last.close > hiPrior,
    sma50,
    aboveSma: sma50 != null && last.close > sma50,
    sma20,
    ext: sma20 ? last.close / sma20 - 1 : null,
    atr,
    btcClose: btcLast?.close ?? null,
    btcSma,
    btcOk: Boolean(btcSameDay && btcSma != null && btcLast.close > btcSma),
    btcDay: btcLast ? utcDay(btcLast.t) : null,
    trigger, // close needed on the day in progress
    breakout: Boolean(last.close > hiPrior && sma50 != null && last.close > sma50 && btcSameDay && btcSma != null && btcLast.close > btcSma),
  };
}

export function potMult(ext, pa) {
  if (ext == null) return pa.base;
  if (ext >= pa.highExt) return pa.high;
  if (ext >= pa.midExt) return pa.mid;
  return pa.base;
}

export const lockFor = (config, hwm) =>
  hwm >= config.startValue * config.lockActivate - EPS ? config.startValue + config.lockKeep * (hwm - config.startValue) : null;

/** Stop price per DOGE that sells everything at the lock: (lock − USD) ÷ DOGE; null = none needed. */
export function lockStopPrice({ lock, usd, doge }) {
  if (lock == null || !(doge > 0)) return null;
  const p = (lock - usd) / doge;
  return p > 0 ? p : null;
}

export const trailMult = potMult;

/** Apply a fill (live: from Kraken; dry: simulated) to the plan state. */
export function applyFill(state, fill, { config, dry, nowIso }) {
  const s = state;
  const fee = config.feePct / 100;
  if (dry && s.virtual) {
    if (fill.side === 'buy') {
      s.virtual.usd = Math.max(0, s.virtual.usd - fill.qty * fill.price * (1 + fee));
      s.virtual.doge += fill.qty;
    } else {
      const q = Math.min(fill.qty, s.virtual.doge);
      s.virtual.doge -= q;
      s.virtual.usd += q * fill.price * (1 - fee);
    }
  }
  if (fill.role === 'pot') {
    s.pot = { ...s.pot, status: 'held', qty: fill.qty, price: fill.price, at: nowIso };
    s.orders.pot = null;
  } else if (fill.role === 'stop') {
    s.orders.stop = null;
    s.status = 'stopped';
    s.endedAt = nowIso;
    s.endReason = `Bottom stop filled at ~${fmtPx(fill.price)} (${fmtQty(fill.qty)} DOGE). Waiting: no re-entry.`;
  } else if (fill.role === 'zone') {
    const z = s.orders.zone;
    if (z && fill.full !== false) {
      s.zonesDone[z.index] = true;
      s.orders.zone = null;
    } else if (z) {
      s.orders.zone = { ...z, qty: Math.max(0, z.qty - fill.qty) };
    }
  } else if (fill.role === 'sell') {
    s.orders.sell = null;
  }
  return s;
}

/**
 * One run. Returns { state, intents, snapshot, events }.
 * @param book   { doge, usd } — real Kraken balances when available (live always; dry when a
 *               key can read them), else null → the virtual book (start DOGE/USD + simulated fills)
 * @param market { price, bid, ask, bars4h, daily, btcDaily }
 */
export function stepDogeLive({ config: cfgIn, state: stIn, mode = 'dry', market, book: bookIn = null, fills = [], guard = null, killSwitch = false, rules = KRAKEN_XDGUSD, nowMs = Date.now() }) {
  const config = normalizeLiveConfig(cfgIn, nowMs);
  const nowIso = new Date(nowMs).toISOString();
  const dry = mode !== 'live';
  const state = structuredClone(stIn || initLiveState(config, nowMs));
  // older states (pre bottom-stop) → upgrade in place
  if (state.stopPx === undefined) state.stopPx = config.bottomStop ?? null;
  state.orders = { stop: null, zone: null, pot: null, sell: null, ...(state.orders || {}) };
  if (state.status === 'ended') state.status = 'stopped';
  if (state.zonesDone?.length !== config.zones.length) state.zonesDone = config.zones.map((_, i) => Boolean(state.zonesDone?.[i]));
  if (state.ordersMode !== mode) {
    // dry orders are virtual; never carry them into live (and vice versa)
    state.orders = { stop: null, zone: null, pot: null, sell: null };
    state.ordersMode = mode;
  }
  const flags = [];
  const events = [];
  const today = utcDay(nowMs);
  if (state.actions?.day !== today) state.actions = { day: today, count: 0 };

  for (const f of fills) applyFill(state, f, { config, dry: false, nowIso });

  const price = Number(market.price);
  const bid = pos(market.bid, price);
  const ask = pos(market.ask, price);
  const bars4 = completed(market.bars4h, H4, nowMs);
  const last4 = bars4[bars4.length - 1] || null;
  const virtualBook = !bookIn;

  // ---- dry-run: the virtual resting stop/zone "fills" against the live price
  if (dry && state.status === 'active') {
    const st = state.orders.stop;
    if (st && price <= st.price + EPS) {
      const fp = Math.min(st.price, price);
      applyFill(state, { role: 'stop', side: 'sell', qty: st.qty, price: fp }, { config, dry: virtualBook, nowIso });
      flags.push({ code: 'dry_fill', message: `Dry-run: the bottom stop ${fmtPx(st.price)} would have filled (${fmtQty(st.qty)} DOGE @ ~${fmtPx(fp)})` });
      events.push({ type: 'fill', role: 'stop', qty: st.qty, price: fp, dry: true });
    }
    const z = state.orders.zone;
    if (z && state.status === 'active' && price >= z.price - EPS) {
      applyFill(state, { role: 'zone', side: 'sell', qty: z.qty, price: z.price, full: true }, { config, dry: virtualBook, nowIso });
      flags.push({ code: 'dry_fill', message: `Dry-run: zone ${fmtPx(z.price)} sale would have filled` });
    }
  }

  const book = virtualBook ? { doge: state.virtual.doge, usd: state.virtual.usd } : { doge: Math.max(0, num(bookIn.doge, 0)), usd: Math.max(0, num(bookIn.usd, 0)) };
  const sig = market.daily ? dailySignal({ daily: market.daily, btcDaily: market.btcDaily || [], config, nowMs }) : null;
  const intents = [];
  const want = { stop: null, zone: null, pot: null, sell: null };
  let trail = null;
  let lockPx = null;
  let mult = null;

  if (state.status === 'active') {
    // ---- optional pot buy (OFF by default)
    if (config.potEnabled && state.pot.status === 'off' && config.potUsd > 0) state.pot.status = 'waiting';
    if (!config.potEnabled && state.pot.status === 'waiting') state.pot.status = 'off';
    if (config.potEnabled && state.pot.status === 'waiting' && sig && state.breakoutCheckedDay !== sig.day) {
      state.breakoutCheckedDay = sig.day;
      if (sig.breakout && !state.lockActive) {
        const cash = Math.min(config.potUsd, book.usd);
        const limit = ceilTo(ask * (1 + config.potLimitPct / 100), rules.priceDecimals);
        const qty = floorTo(cash / (limit * (1 + config.feePct / 100)), rules.volumeDecimals);
        if (guard?.paused) flags.push({ code: 'pot_paused', message: 'Breakout, but the bot is paused: pot buy skipped' });
        else if (killSwitch) flags.push({ code: 'pot_killed', message: 'Breakout, but the kill switch is on: pot buy skipped' });
        else if (qty < rules.orderMin || qty * limit < rules.costMin) flags.push({ code: 'pot_no_cash', message: `Breakout, but only $${cash.toFixed(2)} cash for the pot` });
        else {
          want.pot = { role: 'pot', side: 'buy', ordertype: 'limit', tif: 'IOC', price: limit, qty, reason: `Breakout: ${sig.day} close ${fmtPx(sig.close)} > 20d high ${fmtPx(sig.hiPrior)}, > SMA50 ${fmtPx(sig.sma50)}, BTC > SMA50` };
          state.pot.triggerDay = sig.day;
        }
      }
    }

    // ---- HWM + account lock (last completed 4h close)
    const markPx = last4 ? last4.close : price;
    const acct = book.doge * markPx + book.usd;
    state.hwm = Math.max(num(state.hwm, config.startValue), acct);
    const nl = lockFor(config, state.hwm);
    if (nl != null) {
      if (!state.lockActive) state.lockActivatedAt = nowIso;
      state.lockActive = true;
      state.lock = Math.max(num(state.lock, 0), nl);
    }
    state.umax = Math.max(num(state.umax, 0), book.doge);

    // ---- highest completed 4h close since the plan started (trail anchor)
    const startMs = Date.parse(state.startedAt || nowIso);
    if (state.hc == null && last4) state.hc = last4.close;
    for (const b of bars4) if (b.t + H4 > startMs) state.hc = Math.max(num(state.hc, 0), b.close);

    // ---- optional zone (OFF by default; armed only near its price)
    let zoneQty = 0;
    const zi = config.zonesEnabled ? config.zones.findIndex((_, i) => !state.zonesDone[i]) : -1;
    if (zi >= 0) {
      const z = config.zones[zi];
      const target = (z.keepPct / 100) * state.umax;
      const sellQty = floorTo(Math.max(0, book.doge - target), rules.volumeDecimals);
      const armAt = z.price * (1 - config.zoneArmPct / 100);
      const holdAt = z.price * (1 - (config.zoneArmPct + 3) / 100);
      const wasArmed = state.orders.zone && state.orders.zone.index === zi;
      if (sellQty < rules.orderMin || sellQty * z.price < rules.costMin) {
        if (price >= z.price) state.zonesDone[zi] = true;
      } else if (price >= armAt || (wasArmed && price >= holdAt)) {
        if (guard?.paused && !wasArmed) flags.push({ code: 'zone_paused', message: `Zone ${fmtPx(z.price)} armed, but the bot is paused` });
        else {
          zoneQty = sellQty;
          want.zone = { role: 'zone', index: zi, side: 'sell', ordertype: 'limit', price: roundTo(z.price, rules.priceDecimals), qty: sellQty, reason: `Zone ${fmtPx(z.price)}: sell down to ${z.keepPct}% of max DOGE (${fmtQty(target)})` };
        }
      }
    }

    // ---- manual "Sell N% now" (one marketable IOC sell limit; the stop shrinks first)
    let sellQty = 0;
    if (state.pendingSell) {
      const ps = state.pendingSell;
      const q = floorTo(Math.max(0, book.doge - zoneQty) * (num(ps.pct, config.sellPct) / 100), rules.volumeDecimals);
      const lp = floorTo(bid * (1 - config.sellSlipPct / 100), rules.priceDecimals);
      if (killSwitch) {
        flags.push({ code: 'sell_killed', message: 'Sell now skipped: kill switch is on' });
        state.pendingSell = null;
      } else if (q < rules.orderMin || q * lp < rules.costMin) {
        flags.push({ code: 'sell_below_min', message: `Sell now: ${fmtQty(q)} DOGE is below Kraken's minimum (${rules.orderMin} DOGE / $${rules.costMin})` });
        state.pendingSell = null;
      } else {
        sellQty = q;
        want.sell = { role: 'sell', side: 'sell', ordertype: 'limit', tif: 'IOC', price: lp, qty: q, reason: `Your Sell ${num(ps.pct, config.sellPct)}% now (IOC limit ${config.sellSlipPct}% under the bid ${fmtPx(bid)})` };
      }
    }

    // ---- the bottom stop: max(current, ATR trail, lock price); never lowered
    if (config.trailEnabled && sig?.atr && state.hc) {
      mult = potMult(sig.ext, config.trailAtr);
      trail = state.hc - mult * sig.atr;
    }
    if (state.lockActive) {
      lockPx = lockStopPrice({ lock: state.lock, usd: book.usd, doge: book.doge });
      if (lockPx == null) flags.push({ code: 'cash_covers_lock', message: 'USD already covers the account lock; the bottom stop still protects the DOGE' });
    }
    const cands = [];
    if (trail != null && trail > 0) cands.push({ px: trail, why: `ATR trail: 4h high close ${fmtPx(state.hc)} − ${mult}×ATR ${fmtPx(sig.atr)}` });
    if (lockPx != null) cands.push({ px: lockPx, why: `account lock $${fmtUsd(state.lock)} (70% of gains) ÷ ${fmtQty(book.doge)} DOGE` });
    const best = cands.sort((a, b) => b.px - a.px)[0] || null;
    const cur = fin(state.stopPx) ? Number(state.stopPx) : null;
    if (best) {
      let to = ceilTo(best.px, rules.priceDecimals);
      let why = best.why;
      if (cur == null || to >= cur * (1 + config.minStepPct / 100)) {
        if (cur != null && to > cur * (1 + config.maxStepPct / 100)) {
          flags.push({ code: 'step_capped', message: `Stop raise ${fmtPx(cur)} → ${fmtPx(to)} is > ${config.maxStepPct}% in one run: capped` });
          to = floorTo(cur * (1 + config.maxStepPct / 100), rules.priceDecimals);
          why = `${why} (capped +${config.maxStepPct}% this run)`;
        }
        if (to >= bid - EPS) flags.push({ code: 'raise_crossed', message: `Raise to ${fmtPx(to)} skipped: at/above the market ${fmtPx(bid)}; stop stays ${fmtPx(cur)}` });
        else if (cur == null || to > cur + EPS) {
          setStop(state, to, { by: 'bot', reason: why, nowIso });
          events.push({ type: 'raise', from: cur, to, reason: why });
        }
      }
    }

    const stopPx = fin(state.stopPx) ? Number(state.stopPx) : null;
    const free = floorTo(Math.max(0, book.doge - zoneQty - sellQty), rules.volumeDecimals);
    if (stopPx == null) {
      if (book.doge >= rules.orderMin) flags.push({ code: 'no_stop_level', message: 'No bottom stop set: enter one so the bot can protect your DOGE' });
    } else if (free < rules.orderMin || free * stopPx < rules.costMin) {
      if (book.doge > EPS) flags.push({ code: 'below_min', message: `Stop for ${fmtQty(free)} DOGE is below Kraken's minimum (${rules.orderMin} DOGE / $${rules.costMin})` });
    } else if (stopPx >= bid - EPS) {
      const resting = state.orders.stop;
      if (resting && Math.abs(resting.price - stopPx) < EPS) want.stop = resting; // Kraken triggers it
      else flags.push({ code: 'stop_crossed', message: `⚠️ DOGE ${fmtPx(bid)} is at/below your stop ${fmtPx(stopPx)}: stop NOT placed and nothing sold. Decide: sell (Sell now / Kraken) or lower the stop.` });
    } else {
      want.stop = { role: 'stop', kind: 'bottom', side: 'sell', ordertype: 'stop-loss', price: stopPx, qty: free, reason: state.stopReason || 'Bottom stop' };
    }
  } else {
    flags.push({ code: 'stopped', message: state.endReason || 'Bottom stop filled. Waiting: start a new plan to protect again.' });
    if (state.pendingSell) state.pendingSell = null;
  }

  // ---- kill switch: cancel every bot order, place nothing
  if (killSwitch) {
    want.stop = null;
    want.zone = null;
    want.pot = null;
    want.sell = null;
    flags.push({ code: 'kill_switch', message: 'Kill switch ON: bot orders cancelled, nothing placed' });
  }

  // ---- diff → intents. Shrinks/cancels first so Kraken never sees sells > balance.
  const cur = state.orders;
  const pushI = (action, role, o, prev, reason) =>
    intents.push({ action, role, side: o?.side ?? prev?.side, ordertype: o?.ordertype ?? prev?.ordertype, kind: o?.kind ?? prev?.kind ?? null, index: o?.index ?? prev?.index ?? null, tif: o?.tif ?? null, price: o?.price ?? prev?.price, qty: o?.qty ?? prev?.qty, prev: prev ? { price: prev.price, qty: prev.qty, id: prev.id ?? null, clOrdId: prev.clOrdId ?? null } : null, usd: o?.usd ?? null, reason: reason || o?.reason || null });
  const pxDiff = (a, b) => Math.abs(a.price - b.price) > 1e-12;
  const growMin = rules.orderMin; // grow the stop as soon as ≥ ordermin more DOGE is held
  const stopShrinks = cur.stop && want.stop && want.stop.qty < cur.stop.qty - 1e-6;
  const stopGrows = cur.stop && want.stop && want.stop.qty >= cur.stop.qty + growMin;
  const stopChange = cur.stop && want.stop && (pxDiff(cur.stop, want.stop) || stopShrinks || stopGrows);
  if (cur.zone && !want.zone) pushI('cancel', 'zone', null, cur.zone, killSwitch ? 'kill switch' : 'zone disarmed / done');
  if (cur.zone && want.zone && cur.zone.index !== want.zone.index) pushI('cancel', 'zone', null, cur.zone, 'next zone');
  if (cur.stop && !want.stop) pushI('cancel', 'stop', null, cur.stop, killSwitch ? 'kill switch' : state.status !== 'active' ? 'plan stopped' : 'no stop possible');
  if (stopChange && stopShrinks) pushI('amend', 'stop', want.stop, cur.stop);
  if (cur.zone && want.zone && cur.zone.index === want.zone.index && (pxDiff(cur.zone, want.zone) || Math.abs(cur.zone.qty - want.zone.qty) > 1e-6)) pushI('amend', 'zone', want.zone, cur.zone);
  if (want.zone && (!cur.zone || cur.zone.index !== want.zone.index)) pushI('place', 'zone', want.zone, null);
  if (want.sell) pushI('place', 'sell', want.sell, null);
  if (stopChange && !stopShrinks) pushI('amend', 'stop', stopGrows ? want.stop : { ...want.stop, qty: cur.stop.qty }, cur.stop);
  if (!cur.stop && want.stop) pushI('place', 'stop', want.stop, null);
  if (want.pot && !cur.pot) pushI('place', 'pot', want.pot, null);

  // ---- daily action cap: protective stop actions and cancels always pass
  for (const it of intents) {
    if (it.action === 'cancel' || it.role === 'stop' || it.role === 'sell') continue;
    if (state.actions.count >= config.dailyActionCap) {
      it.skip = `daily cap of ${config.dailyActionCap} order actions reached`;
      flags.push({ code: 'daily_cap', message: `Daily cap of ${config.dailyActionCap} order actions reached` });
    } else state.actions.count += 1;
  }
  for (const it of intents) if (it.role === 'stop' && it.action !== 'cancel') state.actions.count += 1;

  state.flags = flags;
  const zNext = config.zonesEnabled ? config.zones.findIndex((_, i) => !state.zonesDone[i]) : -1;
  const stopNow = fin(state.stopPx) ? Number(state.stopPx) : null;
  const snapshot = {
    at: nowIso,
    mode,
    status: state.status,
    price,
    bid,
    ask,
    book,
    bookSource: virtualBook ? 'virtual' : 'kraken',
    account: book.doge * price + book.usd,
    startValue: config.startValue,
    startDate: config.startDate,
    hwm: state.hwm,
    lock: state.lock,
    lockActive: state.lockActive,
    lockActivatesAt: config.startValue * config.lockActivate,
    bottom: {
      price: stopNow,
      distPct: stopNow && price ? (price / stopNow - 1) * 100 : null,
      qty: want.stop?.qty ?? null,
      setAt: state.stopSetAt ?? null,
      reason: state.stopReason ?? null,
      trail,
      trailMult: mult,
      lockPx,
      hc: state.hc,
      startStop: config.bottomStop,
    },
    stop: want.stop ? { kind: want.stop.kind, price: want.stop.price, qty: want.stop.qty } : null,
    pot: { enabled: config.potEnabled, status: state.pot.status, qty: state.pot.qty, price: state.pot.price },
    zonesEnabled: config.zonesEnabled,
    zone: zNext >= 0 ? { index: zNext, price: config.zones[zNext].price, keepPct: config.zones[zNext].keepPct, armed: Boolean(want.zone) } : null,
    signal: sig ? { day: sig.day, close: sig.close, trigger: sig.trigger, aboveSma: sig.aboveSma, sma50: sig.sma50, btcOk: sig.btcOk, btcClose: sig.btcClose, btcSma: sig.btcSma, atr: sig.atr, ext: sig.ext } : null,
    umax: state.umax,
    flags,
    actionsToday: state.actions.count,
  };
  return { state, intents, snapshot, events, config };
}

/** After an intent succeeded (live) or was "would-placed" (dry): record the resting order. */
export function commitIntent(state, it, result = {}) {
  if (it.role === 'pot' || it.role === 'sell') {
    state.orders[it.role] = null; // IOC: done after the call (fill read from Kraken / simulated)
    if (it.role === 'sell') state.pendingSell = null;
    return state;
  }
  if (it.action === 'cancel') state.orders[it.role] = null;
  else state.orders[it.role] = { kind: it.kind, index: it.index, side: it.side, ordertype: it.ordertype, price: it.price, qty: it.qty, usd: it.usd, id: result.id ?? it.prev?.id ?? null, clOrdId: result.clOrdId ?? it.prev?.clOrdId ?? null, at: result.at ?? null };
  return state;
}

/**
 * DRY-RUN execution: every intent "succeeds" virtually (status would_*). IOC buys/sells fill
 * at the touch in the virtual book (only when the book is virtual).
 */
export function dryExecute(state, intents, { config, market, nowIso, virtualBook = true }) {
  const rows = [];
  for (const it of intents) {
    if (it.skip) {
      rows.push({ ...it, status: 'skipped', note: it.skip });
      continue;
    }
    commitIntent(state, it, { at: nowIso });
    rows.push({ ...it, status: `would_${it.action}` });
    if (it.role === 'pot' || it.role === 'sell') {
      const px = it.role === 'pot' ? Math.min(it.price, Number(market.ask) || it.price) : Math.max(it.price, Number(market.bid) || it.price);
      applyFill(state, { role: it.role, side: it.side, qty: it.qty, price: px }, { config, dry: virtualBook, nowIso });
      rows.push({ action: 'fill', role: it.role, side: it.side, ordertype: 'limit', price: px, qty: it.qty, status: 'dry_fill', reason: `Dry-run: ${it.role === 'pot' ? 'pot buy' : 'sell'} assumed filled` });
    }
  }
  return rows;
}

export function fmtPx(p) {
  return fin(p) ? `$${Number(p).toFixed(4)}` : '—';
}
export function fmtQty(q) {
  return fin(q) ? Math.round(Number(q)).toLocaleString('en-US') : '—';
}
export function fmtUsd(v) {
  return fin(v) ? Math.round(Number(v)).toLocaleString('en-US') : '—';
}
