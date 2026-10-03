/**
 * DOGE live plan engine (pure: no fetch, no DB). Round 4 backtest rules
 * (/workspace/doge-backtest/protect.py + today_plan.py), turned into the exact Kraken orders
 * the bot keeps resting on XDGUSD. The same step runs in DRY-RUN (virtual book, orders only
 * logged) and LIVE (real Kraken balances / orders); api/_dogeLive.js does the I/O.
 *
 * Rules
 *  - Pot buy (once): on the first run after a UTC daily close (00:00 UTC = 5 PM PT) where
 *    close > highest close of the prior `breakoutDays` days, DOGE close > SMA50 and
 *    BTC close > SMA50, buy with the cash pot (marketable IOC limit).
 *  - Pot stop (pot DOGE only, until the account lock is active): highest completed 4h close
 *    since the fill − daily ATR14 × 3, tightening to ×2 when the last daily close is 20–50%
 *    above its SMA20 and ×1.5 above 50%. Only moves up.
 *  - Account lock: activates when the account (DOGE × last 4h close + USD) has reached
 *    lockActivate × start (1.5×). lock = start + lockKeep × (HWM − start); only rises.
 *    Enforced as ONE Kraken stop-loss for all DOGE at (lock − USD) ÷ DOGE. ≤ 0 → no stop.
 *    Lock stop fills → plan ENDS (no re-entry; "Start new plan" is manual).
 *  - Zones: resting sell limits at zone prices, selling down to keepPct% of max DOGE held.
 *    A zone limit rests only when price is within zoneArmPct% of it ("armed"); while armed
 *    the stop covers the rest, so stop + limit quantities never exceed the DOGE balance
 *    (Kraken holds balance for open orders). Disarms below the arm band − 3%.
 *  - Stop price per DOGE only ratchets up for the same quantity; it is recomputed (may
 *    drop) only after a fill / quantity change (e.g. zone 1 sale raises cash → lower price
 *    protects the same locked $). Raises < minStepPct are skipped (no churn); a raise bigger
 *    than maxStepPct in one step is capped at +maxStepPct this run. A stop at/above the bid
 *    is refused (it would fill at once) and flagged "stop crossed".
 */

export const KRAKEN_XDGUSD = Object.freeze({
  pair: 'XDGUSD',
  priceDecimals: 7, // pair_decimals / tick_size 0.0000001 (AssetPairs, verified Oct 2026)
  volumeDecimals: 8, // lot_decimals
  orderMin: 50, // ordermin (DOGE)
  costMin: 0.5, // costmin (USD)
});

export const DEFAULT_LIVE_CONFIG = Object.freeze({
  startValue: 19000,
  startDate: null,
  startDoge: 110000,
  startUsd: 9000,
  potUsd: 9000,
  breakoutDays: 20,
  smaDays: 50,
  btcSmaDays: 50,
  atrDays: 14,
  potAtr: Object.freeze({ base: 3, mid: 2, high: 1.5, midExt: 0.2, highExt: 0.5 }),
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
});

const DAY = 86400000;
const H4 = 4 * 3600000;
const EPS = 1e-9;
const fin = (v) => Number.isFinite(Number(v)) && v !== null && v !== '';
const num = (v, d) => (fin(v) ? Number(v) : d);
const pos = (v, d) => (fin(v) && Number(v) > 0 ? Number(v) : d);

export const floorTo = (v, dp) => Math.floor(v * 10 ** dp + 1e-6) / 10 ** dp;
export const ceilTo = (v, dp) => Math.ceil(v * 10 ** dp - 1e-6) / 10 ** dp;
export const roundTo = (v, dp) => Math.round(v * 10 ** dp) / 10 ** dp;
export const priceStr = (p, rules = KRAKEN_XDGUSD) => Number(p).toFixed(rules.priceDecimals);
export const volStr = (v, rules = KRAKEN_XDGUSD) => floorTo(Number(v), rules.volumeDecimals).toFixed(rules.volumeDecimals);
export const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Clean / default a user's plan config (throws on nonsense that would be unsafe). */
export function normalizeLiveConfig(c = {}, nowMs = Date.now()) {
  const d = DEFAULT_LIVE_CONFIG;
  const pa = c.potAtr || {};
  const zonesIn = Array.isArray(c.zones) && c.zones.length ? c.zones : d.zones;
  const zones = zonesIn
    .map((z) => ({ price: pos(z?.price, null), keepPct: Math.min(100, Math.max(0, num(z?.keepPct, NaN))) }))
    .filter((z) => z.price && Number.isFinite(z.keepPct))
    .sort((a, b) => a.price - b.price)
    .slice(0, 6);
  const startDate =
    typeof c.startDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(c.startDate) ? c.startDate : utcDay(nowMs);
  return {
    startValue: pos(c.startValue, d.startValue),
    startDate,
    startDoge: Math.max(0, num(c.startDoge, d.startDoge)),
    startUsd: Math.max(0, num(c.startUsd, d.startUsd)),
    potUsd: Math.max(0, num(c.potUsd, d.potUsd)),
    breakoutDays: Math.round(Math.min(120, Math.max(5, num(c.breakoutDays, d.breakoutDays)))),
    smaDays: Math.round(Math.min(200, Math.max(5, num(c.smaDays, d.smaDays)))),
    btcSmaDays: Math.round(Math.min(200, Math.max(5, num(c.btcSmaDays, d.btcSmaDays)))),
    atrDays: Math.round(Math.min(50, Math.max(5, num(c.atrDays, d.atrDays)))),
    potAtr: {
      base: pos(pa.base, d.potAtr.base),
      mid: pos(pa.mid, d.potAtr.mid),
      high: pos(pa.high, d.potAtr.high),
      midExt: num(pa.midExt, d.potAtr.midExt),
      highExt: num(pa.highExt, d.potAtr.highExt),
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
    hwm: config.startValue,
    lock: null,
    lockActive: false,
    lockActivatedAt: null,
    umax: config.startDoge,
    pot: { status: config.potUsd > 0 ? 'waiting' : 'none', qty: 0, price: null, at: null, hc: null, stop: null, triggerDay: null },
    breakoutCheckedDay: null,
    zonesDone: config.zones.map(() => false),
    orders: { stop: null, zone: null, pot: null },
    ordersMode: 'dry',
    virtual: { doge: config.startDoge, usd: config.startUsd },
    actions: { day: null, count: 0 },
    flags: [],
  };
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

/** Apply a fill (live: from Kraken; dry: simulated) to the plan state. */
export function applyFill(state, fill, { config, dry, nowIso }) {
  const s = state;
  const fee = config.feePct / 100;
  if (dry) {
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
    s.pot = { ...s.pot, status: 'held', qty: fill.qty, price: fill.price, at: nowIso, hc: fill.price, stop: null };
    s.orders.pot = null;
  } else if (fill.role === 'stop') {
    const kind = s.orders.stop?.kind || fill.kind;
    s.orders.stop = null;
    if (kind === 'lock') {
      s.status = 'ended';
      s.endedAt = nowIso;
      s.endReason = `Account lock stop filled at ${fill.price}`;
    } else {
      s.pot = { ...s.pot, status: 'stopped', qty: 0, stoppedAt: nowIso, stoppedPx: fill.price };
    }
  } else if (fill.role === 'zone') {
    const z = s.orders.zone;
    if (z && fill.full !== false) {
      s.zonesDone[z.index] = true;
      s.orders.zone = null;
    } else if (z) {
      s.orders.zone = { ...z, qty: Math.max(0, z.qty - fill.qty) };
    }
    // a zone sale reduces DOGE: pot DOGE can't exceed what's left
    if (s.pot.status === 'held') s.pot.qty = Math.max(0, s.pot.qty - fill.qty);
  }
  return s;
}

/**
 * One run. Returns { state, intents, snapshot }.
 * @param book   { doge, usd } — live: Kraken balances; dry: state.virtual (after fills)
 * @param market { price, bid, ask, bars4h, daily, btcDaily }
 * @param mode   'dry' | 'live'
 */
export function stepDogeLive({ config: cfgIn, state: stIn, mode = 'dry', market, book: bookIn = null, fills = [], guard = null, killSwitch = false, rules = KRAKEN_XDGUSD, nowMs = Date.now() }) {
  const config = normalizeLiveConfig(cfgIn, nowMs);
  const nowIso = new Date(nowMs).toISOString();
  const dry = mode !== 'live';
  let state = structuredClone(stIn || initLiveState(config, nowMs));
  if (state.zonesDone?.length !== config.zones.length) state.zonesDone = config.zones.map((_, i) => Boolean(state.zonesDone?.[i]));
  // switching modes: dry orders are virtual; never carry them into live (and vice versa)
  if (state.ordersMode !== mode) {
    state.orders = { stop: null, zone: null, pot: null };
    state.ordersMode = mode;
  }
  const flags = [];
  const today = utcDay(nowMs);
  if (state.actions?.day !== today) state.actions = { day: today, count: 0 };

  // ---- fills reported by Kraken (live) are applied first
  for (const f of fills) applyFill(state, f, { config, dry: false, nowIso });

  const price = Number(market.price);
  const bid = pos(market.bid, price);
  const ask = pos(market.ask, price);
  const bars4 = completed(market.bars4h, H4, nowMs);
  const last4 = bars4[bars4.length - 1] || null;

  // ---- dry-run: simulate fills of the virtual resting orders against the live price
  if (dry && state.status === 'active') {
    const st = state.orders.stop;
    if (st && price <= st.price + EPS) {
      applyFill(state, { role: 'stop', kind: st.kind, side: 'sell', qty: st.qty, price: Math.min(st.price, price) }, { config, dry: true, nowIso });
      flags.push({ code: 'dry_fill', message: `Dry-run: ${st.kind} stop would have filled at ~${fmtPx(Math.min(st.price, price))}` });
    }
    const z = state.orders.zone;
    if (z && state.status === 'active' && price >= z.price - EPS) {
      applyFill(state, { role: 'zone', side: 'sell', qty: z.qty, price: z.price, full: true }, { config, dry: true, nowIso });
      flags.push({ code: 'dry_fill', message: `Dry-run: zone ${fmtPx(z.price)} sale would have filled` });
    }
  }

  const book = dry ? { doge: state.virtual.doge, usd: state.virtual.usd } : { doge: Math.max(0, num(bookIn?.doge, 0)), usd: Math.max(0, num(bookIn?.usd, 0)) };
  const sig = market.daily ? dailySignal({ daily: market.daily, btcDaily: market.btcDaily || [], config, nowMs }) : null;
  const intents = [];
  const want = { stop: null, zone: null, pot: null };

  if (state.status === 'active') {
    // ---- pot buy (once, on a completed-day breakout)
    if (state.pot.status === 'waiting' && sig && state.breakoutCheckedDay !== sig.day) {
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

    // ---- HWM + account lock (on the last completed 4h close, as in the backtest)
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

    // ---- pot stop (pot DOGE only, until the lock is active)
    if (state.pot.status === 'held' && !state.lockActive && sig?.atr) {
      const since = Date.parse(state.pot.at || 0);
      // highest completed 4h close from the bar the pot filled in onward (backtest: phc)
      for (const b of bars4) if (b.t + H4 > since) state.pot.hc = Math.max(num(state.pot.hc, 0), b.close);
      const m = potMult(sig.ext, config.potAtr);
      const cand = state.pot.hc - m * sig.atr;
      state.pot.stop = Math.max(num(state.pot.stop, -Infinity), cand);
      state.pot.mult = m;
      state.pot.qty = Math.min(state.pot.qty, book.doge);
    }

    // ---- next zone (armed only near its price)
    const zi = config.zones.findIndex((_, i) => !state.zonesDone[i]);
    let zoneQty = 0;
    if (zi >= 0) {
      const z = config.zones[zi];
      const target = (z.keepPct / 100) * state.umax;
      const sellQty = floorTo(Math.max(0, book.doge - target), rules.volumeDecimals);
      const armAt = z.price * (1 - config.zoneArmPct / 100);
      const holdAt = z.price * (1 - (config.zoneArmPct + 3) / 100);
      const wasArmed = state.orders.zone && state.orders.zone.index === zi;
      if (sellQty < rules.orderMin || sellQty * z.price < rules.costMin) {
        // already at/below the zone's target (e.g. sold by hand): nothing to sell for it
        if (price >= z.price) state.zonesDone[zi] = true;
      } else if (price >= armAt || (wasArmed && price >= holdAt)) {
        if (guard?.paused && !wasArmed) flags.push({ code: 'zone_paused', message: `Zone ${fmtPx(z.price)} armed, but the bot is paused` });
        else {
          zoneQty = sellQty;
          want.zone = { role: 'zone', index: zi, side: 'sell', ordertype: 'limit', price: roundTo(z.price, rules.priceDecimals), qty: sellQty, reason: `Zone ${fmtPx(z.price)}: sell down to ${z.keepPct}% of max DOGE (${fmtQty(target)})` };
        }
      }
    }

    // ---- the ONE protective stop (lock for all DOGE, else pot stop for pot DOGE)
    const free = Math.max(0, book.doge - zoneQty);
    let s = null;
    if (state.lockActive) {
      const p = lockStopPrice({ lock: state.lock, usd: book.usd, doge: book.doge });
      if (p == null) flags.push({ code: 'cash_covers_lock', message: 'USD already covers the lock: no stop needed' });
      else s = { kind: 'lock', price: p, qty: free, reason: `Account lock $${fmtUsd(state.lock)}: (lock − USD $${fmtUsd(book.usd)}) ÷ ${fmtQty(book.doge)} DOGE` };
    } else if (state.pot.status === 'held' && fin(state.pot.stop) && state.pot.stop > 0) {
      s = { kind: 'pot', price: state.pot.stop, qty: Math.min(state.pot.qty, free), reason: `Pot stop: 4h high close ${fmtPx(state.pot.hc)} − ${state.pot.mult}×ATR ${fmtPx(sig?.atr)}` };
    }
    if (s) {
      s.qty = floorTo(s.qty, rules.volumeDecimals);
      let p = ceilTo(s.price, rules.priceDecimals);
      const cur = state.orders.stop;
      const sameBasis = cur && cur.kind === s.kind && Math.abs(cur.qty - s.qty) < 1e-6 && Math.abs(num(cur.usd, book.usd) - book.usd) < 0.01;
      if (cur && sameBasis) {
        if (p < cur.price) p = cur.price; // ratchet: never lower for the same quantity / cash
        else if (p > cur.price * (1 + config.maxStepPct / 100)) {
          flags.push({ code: 'step_capped', message: `Stop raise ${fmtPx(cur.price)} → ${fmtPx(p)} is > ${config.maxStepPct}% in one step: capped this run` });
          p = floorTo(cur.price * (1 + config.maxStepPct / 100), rules.priceDecimals);
        } else if (p < cur.price * (1 + config.minStepPct / 100)) p = cur.price; // not a meaningful step
      }
      if (s.qty < rules.orderMin || s.qty * p < rules.costMin) {
        flags.push({ code: 'below_min', message: `Stop for ${fmtQty(s.qty)} DOGE is below Kraken's minimum (${rules.orderMin} DOGE / $${rules.costMin})` });
      } else if (p >= bid - EPS) {
        flags.push({ code: 'stop_crossed', message: `Stop ${fmtPx(p)} is at/above the market ${fmtPx(bid)}: not placed (would fill at once). Review now.` });
        if (cur) want.stop = cur; // keep what's resting
      } else {
        want.stop = { role: 'stop', kind: s.kind, side: 'sell', ordertype: 'stop-loss', price: p, qty: s.qty, usd: book.usd, reason: s.reason };
      }
    }
  } else {
    flags.push({ code: 'ended', message: state.endReason || 'Plan ended. Start a new plan to continue.' });
  }

  // ---- kill switch: cancel every bot order, place nothing
  if (killSwitch) {
    want.stop = null;
    want.zone = null;
    want.pot = null;
    flags.push({ code: 'kill_switch', message: 'Kill switch ON: bot orders cancelled, nothing placed' });
  }

  // ---- diff → intents. Reductions/cancels first so Kraken never sees stop + limit > balance.
  const cur = state.orders;
  const same = (a, b) => a && b && Math.abs(a.price - b.price) < 1e-9 && Math.abs(a.qty - b.qty) < 1e-6;
  const pushI = (action, role, o, prev, reason) =>
    intents.push({ action, role, side: o?.side ?? prev?.side, ordertype: o?.ordertype ?? prev?.ordertype, kind: o?.kind ?? prev?.kind ?? null, index: o?.index ?? prev?.index ?? null, tif: o?.tif ?? null, price: o?.price ?? prev?.price, qty: o?.qty ?? prev?.qty, prev: prev ? { price: prev.price, qty: prev.qty, id: prev.id ?? null, clOrdId: prev.clOrdId ?? null } : null, usd: o?.usd ?? null, reason: reason || o?.reason || null });
  // zone first when it shrinks/cancels; stop first when it shrinks
  if (cur.zone && !want.zone) pushI('cancel', 'zone', null, cur.zone, killSwitch ? 'kill switch' : 'zone disarmed / done');
  if (cur.zone && want.zone && (cur.zone.index !== want.zone.index)) pushI('cancel', 'zone', null, cur.zone, 'next zone');
  if (cur.stop && !want.stop) pushI('cancel', 'stop', null, cur.stop, killSwitch ? 'kill switch' : 'no stop needed');
  const stopChange = cur.stop && want.stop && !same(cur.stop, want.stop);
  const stopShrinks = stopChange && want.stop.qty < cur.stop.qty - 1e-6;
  if (stopShrinks) pushI('amend', 'stop', want.stop, cur.stop);
  if (cur.zone && want.zone && cur.zone.index === want.zone.index && !same(cur.zone, want.zone)) pushI('amend', 'zone', want.zone, cur.zone);
  if (!cur.zone && want.zone) pushI('place', 'zone', want.zone, null);
  if (cur.zone && want.zone && cur.zone.index !== want.zone.index) pushI('place', 'zone', want.zone, null);
  if (stopChange && !stopShrinks) pushI('amend', 'stop', want.stop, cur.stop);
  if (!cur.stop && want.stop) pushI('place', 'stop', want.stop, null);
  if (want.pot && !cur.pot) pushI('place', 'pot', want.pot, null);

  // ---- daily action cap (cancels always pass: they only remove risk)
  for (const it of intents) {
    if (it.action === 'cancel') continue;
    if (state.actions.count >= config.dailyActionCap) {
      it.skip = `daily cap of ${config.dailyActionCap} order actions reached`;
      flags.push({ code: 'daily_cap', message: `Daily cap of ${config.dailyActionCap} order actions reached` });
    } else state.actions.count += 1;
  }

  state.flags = flags;
  const zNext = config.zones.findIndex((_, i) => !state.zonesDone[i]);
  const snapshot = {
    at: nowIso,
    mode,
    status: state.status,
    price,
    bid,
    ask,
    book,
    account: book.doge * price + book.usd,
    startValue: config.startValue,
    startDate: config.startDate,
    hwm: state.hwm,
    lock: state.lock,
    lockActive: state.lockActive,
    lockActivatesAt: config.startValue * config.lockActivate,
    stop: want.stop ? { kind: want.stop.kind, price: want.stop.price, qty: want.stop.qty } : null,
    pot: { status: state.pot.status, qty: state.pot.qty, price: state.pot.price, stop: state.pot.stop, mult: state.pot.mult ?? null },
    zone: zNext >= 0 ? { index: zNext, price: config.zones[zNext].price, keepPct: config.zones[zNext].keepPct, armed: Boolean(want.zone), sellQty: want.zone?.qty ?? floorTo(Math.max(0, book.doge - (config.zones[zNext].keepPct / 100) * state.umax), 2) } : null,
    signal: sig ? { day: sig.day, close: sig.close, trigger: sig.trigger, aboveSma: sig.aboveSma, sma50: sig.sma50, btcOk: sig.btcOk, btcClose: sig.btcClose, btcSma: sig.btcSma, atr: sig.atr, ext: sig.ext } : null,
    umax: state.umax,
    flags,
    actionsToday: state.actions.count,
  };
  return { state, intents, snapshot, config };
}

/** After an intent succeeded (live) or was "would-placed" (dry): record the resting order. */
export function commitIntent(state, it, result = {}) {
  if (it.role === 'pot') {
    state.orders.pot = null; // IOC: done after the call (fill read from Kraken / simulated)
    return state;
  }
  if (it.action === 'cancel') state.orders[it.role] = null;
  else state.orders[it.role] = { kind: it.kind, index: it.index, side: it.side, ordertype: it.ordertype, price: it.price, qty: it.qty, usd: it.usd, id: result.id ?? it.prev?.id ?? null, clOrdId: result.clOrdId ?? it.prev?.clOrdId ?? null, at: result.at ?? null };
  return state;
}

/**
 * DRY-RUN execution: every intent "succeeds" virtually. A pot buy fills at the ask
 * (marketable IOC) in the virtual book. Returns log rows (status would_*).
 */
export function dryExecute(state, intents, { config, market, nowIso }) {
  const rows = [];
  for (const it of intents) {
    if (it.skip) {
      rows.push({ ...it, status: 'skipped', note: it.skip });
      continue;
    }
    commitIntent(state, it, { at: nowIso });
    rows.push({ ...it, status: `would_${it.action}` });
    if (it.role === 'pot') {
      const px = Math.min(it.price, Number(market.ask) || it.price);
      applyFill(state, { role: 'pot', side: 'buy', qty: it.qty, price: px }, { config, dry: true, nowIso });
      rows.push({ action: 'fill', role: 'pot', side: 'buy', ordertype: 'limit', price: px, qty: it.qty, status: 'dry_fill', reason: 'Dry-run: pot buy assumed filled at the ask' });
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
