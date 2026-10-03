/**
 * LIVE Schwab stop management: pure rules (no I/O), fixtures in scripts/check-schwab.mjs.
 *
 * Live mode only manages PROTECTIVE stop orders for shares you actually hold at Schwab:
 *   - quantity = min(app position shares, Schwab shares on that side), never more;
 *   - no Schwab position / wrong side → nothing is placed ("Not found at Schwab");
 *   - never opens positions, never market orders (orderType STOP only, GTC, session NORMAL);
 *   - stops only tighten (the engine ratchet + "never loosen" here);
 *   - a stop on the wrong side of the price (would fill now) is refused and flagged;
 *   - one step may not move the stop more than 15%; at most 20 order actions per user per day;
 *   - at most one stop modify per position per day, from the after-close pass (plus the first
 *     placement when Live is turned on, an explicit "Let bot manage this order", and quantity
 *     reductions when you hold fewer shares, which are always protective);
 *   - your own stop at Schwab for the symbol is detected and never duplicated;
 *   - every action passes shared/guard.js liveOrderCheck (kill switch blocks all).
 */
import { liveOrderCheck } from './guard.js';

export const LIVE_RULES = Object.freeze({
  maxStepPct: 0.15,
  dailyActionCap: 20,
  reminderHours: Object.freeze([48, 12]),
  refreshDays: 7,
  accessSkewMs: 90_000,
});

/** Schwab order statuses that are still live at the exchange / broker. */
export const OPEN_STATUSES = Object.freeze(
  new Set([
    'AWAITING_PARENT_ORDER', 'AWAITING_CONDITION', 'AWAITING_STOP_CONDITION', 'AWAITING_MANUAL_REVIEW', 'ACCEPTED',
    'AWAITING_UR_OUT', 'PENDING_ACTIVATION', 'QUEUED', 'WORKING', 'NEW', 'AWAITING_RELEASE_TIME',
    'PENDING_ACKNOWLEDGEMENT', 'PENDING_REPLACE', 'PENDING_CANCEL', 'PENDING_RECALL',
  ]),
);
export const STOP_TYPES = Object.freeze(new Set(['STOP', 'STOP_LIMIT', 'TRAILING_STOP', 'TRAILING_STOP_LIMIT']));

const fin = (x) => Number.isFinite(x);
export const instructionFor = (side) => (side === 'short' ? 'BUY_TO_COVER' : 'SELL');

/** Valid equity tick: $0.01 at/above $1, $0.0001 below. */
export const tickSize = (price) => (price >= 1 ? 0.01 : 0.0001);

/**
 * Round a stop to a valid tick in the PROTECTIVE direction (long sell stop rounds up,
 * short buy-to-cover stop rounds down) so rounding never adds risk beyond the computed stop.
 */
export function roundStop(price, side) {
  if (!(price > 0)) throw new Error('stop must be > 0');
  let tick = tickSize(price);
  const steps = price / tick;
  let n = side === 'short' ? Math.floor(steps + 1e-7) : Math.ceil(steps - 1e-7);
  let out = n * tick;
  if (tick < 0.01 && out >= 1) {
    tick = 0.01;
    n = side === 'short' ? Math.floor(price / tick + 1e-7) : Math.ceil(price / tick - 1e-7);
    out = n * tick;
  }
  return Number(out.toFixed(tick >= 0.01 ? 2 : 4));
}
export const stopString = (p) => (p >= 1 ? p.toFixed(2) : p.toFixed(4));

/** Schwab equity STOP order JSON (Trader API order schema; GTC, NORMAL session). */
export function buildStopOrder({ symbol, side, qty, stopPrice }) {
  if (!(qty > 0) || !Number.isInteger(qty)) throw new Error('quantity must be a whole number > 0');
  if (!(stopPrice > 0)) throw new Error('stopPrice must be > 0');
  return {
    orderType: 'STOP',
    session: 'NORMAL',
    duration: 'GOOD_TILL_CANCEL',
    orderStrategyType: 'SINGLE',
    stopPrice: stopString(stopPrice),
    orderLegCollection: [{ instruction: instructionFor(side), quantity: qty, instrument: { symbol: String(symbol).toUpperCase(), assetType: 'EQUITY' } }],
  };
}

/** Holdings from GET /trader/v1/accounts/{hash}?fields=positions → [{ symbol, longQty, shortQty }]. */
export function holdingsFromAccount(json) {
  const list = json?.securitiesAccount?.positions || [];
  const by = new Map();
  for (const p of list) {
    const sym = String(p?.instrument?.symbol || '').toUpperCase();
    if (!sym || p?.instrument?.assetType === 'OPTION') continue;
    const h = by.get(sym) || { symbol: sym, longQty: 0, shortQty: 0 };
    h.longQty += Number(p.longQuantity) || 0;
    h.shortQty += Number(p.shortQuantity) || 0;
    by.set(sym, h);
  }
  return [...by.values()];
}

/**
 * Shares the bot may protect = min(app shares, shares held at Schwab on that side), whole shares.
 * @returns {{ qty, held, status: 'ok'|'not_found'|'side_mismatch', message }}
 */
export function sharesToProtect({ symbol, side, appShares, holdings }) {
  const h = (holdings || []).find((x) => x.symbol === String(symbol).toUpperCase());
  const held = h ? (side === 'short' ? h.shortQty : h.longQty) : 0;
  const other = h ? (side === 'short' ? h.longQty : h.shortQty) : 0;
  if (!(held > 0)) {
    if (other > 0) return { qty: 0, held: 0, status: 'side_mismatch', message: `Not found at Schwab: you hold ${symbol} ${side === 'short' ? 'long' : 'short'}, not ${side}` };
    return { qty: 0, held: 0, status: 'not_found', message: `Not found at Schwab: no ${side} ${symbol} position in this account` };
  }
  const qty = Math.floor(Math.min(Number(appShares) || 0, held) + 1e-9);
  if (!(qty > 0)) return { qty: 0, held, status: 'not_found', message: `Not found at Schwab: under 1 whole share of ${symbol} to protect` };
  return { qty, held, status: 'ok', message: null };
}

function walkOrders(orders, out = [], child = false) {
  for (const o of orders || []) {
    out.push({ o, child });
    if (o?.childOrderStrategies?.length) walkOrders(o.childOrderStrategies, out, true);
  }
  return out;
}

/** Your own open stop orders at Schwab for this symbol + instruction (excluding the bot's order). */
export function findOwnStops({ orders, symbol, side, excludeOrderId = null }) {
  const sym = String(symbol).toUpperCase();
  const ins = instructionFor(side);
  const out = [];
  for (const { o, child } of walkOrders(orders)) {
    if (!STOP_TYPES.has(o?.orderType) || !OPEN_STATUSES.has(o?.status)) continue;
    const legs = o.orderLegCollection || [];
    const leg = legs.find((l) => String(l?.instrument?.symbol || '').toUpperCase() === sym && l?.instruction === ins);
    if (!leg) continue;
    const id = o.orderId != null ? String(o.orderId) : null;
    if (id && excludeOrderId != null && id === String(excludeOrderId)) continue;
    const manageable = !child && o.orderType === 'STOP' && (o.orderStrategyType || 'SINGLE') === 'SINGLE' && legs.length === 1 && id != null;
    out.push({
      orderId: id,
      orderType: o.orderType,
      status: o.status,
      duration: o.duration ?? null,
      stopPrice: fin(Number(o.stopPrice)) ? Number(o.stopPrice) : null,
      qty: fin(Number(o.remainingQuantity)) && Number(o.remainingQuantity) > 0 ? Number(o.remainingQuantity) : Number(leg.quantity) || null,
      manageable,
      why: manageable ? null : child ? 'part of a bracket / OCO order' : `${o.orderType} order (bot manages plain STOP orders only)`,
    });
  }
  return out;
}

/** Fill summary for one order (GET /orders/{id}). */
export function fillFromOrder(o) {
  const status = o?.status || 'UNKNOWN';
  let q = 0;
  let notional = 0;
  for (const a of o?.orderActivityCollection || []) {
    for (const leg of a?.executionLegs || []) {
      const lq = Number(leg.quantity) || 0;
      q += lq;
      notional += lq * (Number(leg.price) || 0);
    }
  }
  return {
    status,
    open: OPEN_STATUSES.has(status),
    filled: status === 'FILLED',
    filledQty: Number(o?.filledQuantity) || q,
    price: q > 0 ? notional / q : null,
    stopPrice: fin(Number(o?.stopPrice)) ? Number(o.stopPrice) : null,
    qty: Number(o?.quantity) || null,
    closeTime: o?.closeTime ?? null,
  };
}

/** Refresh-token expiry reminders still due (48h and 12h before; once each). */
export function remindersDue({ refreshExpiresAt, sent = {}, nowMs }) {
  const left = Date.parse(refreshExpiresAt) - nowMs;
  if (!fin(left)) return { expired: false, due: [] };
  if (left <= 0) return { expired: true, due: [] };
  const due = LIVE_RULES.reminderHours.filter((h) => left <= h * 3600_000 && !sent[`h${h}`]);
  // Only the most urgent one (e.g. reconnect with 10h left → just the 12h reminder).
  return { expired: false, due: due.length ? [Math.min(...due)] : [], leftMs: left };
}

/** User-level live gate: connection usable for orders right now? */
export function connectionLive(conn, nowMs) {
  if (!conn || conn.status !== 'connected') return { ok: false, code: 'watch_only', message: 'Schwab not connected: watch-only' };
  if (!(Date.parse(conn.refresh_expires_at) > nowMs)) return { ok: false, code: 'expired', message: 'Schwab connection expired: watch-only until you reconnect' };
  if (!conn.account_hash) return { ok: false, code: 'no_account', message: 'Pick the Schwab account the bot manages' };
  if (conn.kill_switch) return { ok: false, code: 'kill_switch', message: 'Live orders paused entirely (kill switch)' };
  if (!conn.live_enabled) return { ok: false, code: 'live_off', message: 'Live Schwab stops are off' };
  return { ok: true };
}

const flag = (code, message, extra = {}) => ({ code, message, ...extra });

/**
 * One position, one run → at most one broker action.
 * @param liveOrder stock_live_orders row (or null): { order_id, status, stop_price, qty, last_modified_day, data }
 * @param price     current price for the wrong-side check (Schwab quote when available)
 * @returns {{ action: 'none'|'place'|'modify', qty?, stopPrice?, kind?, flag, foreign, note }}
 */
export function planLiveAction({ conn, position, snapshot, liveOrder = null, holdings, openOrders = [], price, pass, today, actionsToday = 0, guard = null, nowMs }) {
  const side = position.side;
  const long = side !== 'short';
  const gate = connectionLive(conn, nowMs);
  if (!gate.ok) return { action: 'none', flag: gate.code === 'live_off' ? null : flag(gate.code, gate.message), foreign: [] };
  if (!position.live) return { action: 'none', flag: null, foreign: [] };
  if (!snapshot || !(snapshot.stop > 0)) return { action: 'none', flag: flag('no_stop', 'No computed stop yet'), foreign: [] };

  const st = liveOrder?.status;
  if (st === 'filled') return { action: 'none', flag: flag('filled', 'Stop filled at Schwab'), foreign: [] };
  if (st === 'gone') return { action: 'none', flag: flag('gone', liveOrder?.data?.goneReason || 'The bot’s order was canceled or replaced at Schwab. Turn Live off and on to place a new one.'), foreign: [] };

  const prot = sharesToProtect({ symbol: position.symbol, side, appShares: position.shares, holdings });
  if (prot.status !== 'ok') return { action: 'none', flag: flag('not_found', prot.message), foreign: [] };

  const managed = liveOrder?.order_id && st === 'working' ? liveOrder : null;
  const foreign = findOwnStops({ orders: openOrders, symbol: position.symbol, side, excludeOrderId: managed?.order_id ?? null });
  const stop = roundStop(snapshot.stop, side);
  const px = Number(price);
  const crossed = fin(px) && px > 0 && (long ? stop >= px : stop <= px);
  const capped = actionsToday >= LIVE_RULES.dailyActionCap;

  if (!managed) {
    if (foreign.length) {
      return { action: 'none', flag: flag('own_stop', `You already have ${foreign.length === 1 ? 'a stop order' : `${foreign.length} stop orders`} for ${position.symbol} at Schwab; the bot won't add another.`), foreign };
    }
    if (crossed) return { action: 'none', flag: flag('stop_crossed', `Stop already crossed, review: ${stopString(stop)} vs price ${stopString(px)} would fill immediately. Not placed.`), foreign };
    if (capped) return { action: 'none', flag: flag('daily_cap', `Daily cap of ${LIVE_RULES.dailyActionCap} Schwab order actions reached`), foreign };
    const g = liveOrderCheck(guard, { kind: 'place_stop', killSwitch: conn.kill_switch });
    if (!g.allowed) return { action: 'none', flag: flag('guard', g.reason), foreign };
    return { action: 'place', kind: 'place_stop', qty: prot.qty, stopPrice: stop, flag: null, foreign, note: g.note ?? null, held: prot.held };
  }

  const cur = Number(managed.stop_price);
  const curQty = Number(managed.qty);
  const tick = tickSize(cur);
  const tighter = long ? stop > cur + tick / 2 : stop < cur - tick / 2;
  const jump = tighter && cur > 0 && Math.abs(stop - cur) / cur > LIVE_RULES.maxStepPct;
  const qtyDown = curQty > prot.qty;
  const qtyUp = curQty < prot.qty;
  const window = pass === 'close' || Boolean(managed.data?.allowModifyOnce);
  const modifiedToday = managed.last_modified_day === today;
  let wantStop = cur;
  let f = null;
  if (tighter) {
    if (crossed) f = flag('stop_crossed', `Stop already crossed, review: new stop ${stopString(stop)} vs price ${stopString(px)} would fill immediately. Kept ${stopString(cur)}.`);
    else if (jump) f = flag('jump_cap', `Refused: stop would move ${(((stop - cur) / cur) * 100).toFixed(1)}% in one step (max ${LIVE_RULES.maxStepPct * 100}%). Kept ${stopString(cur)}.`);
    else if (!window) f = null; // waits for the after-close pass
    else if (modifiedToday) f = null; // one modify per day
    else wantStop = stop;
  }
  const qtyTarget = qtyDown ? prot.qty : qtyUp && window && !modifiedToday ? prot.qty : curQty;
  if (wantStop === cur && qtyTarget === curQty) return { action: 'none', flag: f, foreign, pending: tighter && !f ? (modifiedToday ? 'modified today' : 'after-close pass') : null };
  if (capped) return { action: 'none', flag: flag('daily_cap', `Daily cap of ${LIVE_RULES.dailyActionCap} Schwab order actions reached`), foreign };
  const g = liveOrderCheck(guard, { kind: 'tighten_stop', killSwitch: conn.kill_switch });
  if (!g.allowed) return { action: 'none', flag: flag('guard', g.reason), foreign };
  return { action: 'modify', kind: 'tighten_stop', qty: qtyTarget, stopPrice: wantStop, fromStop: cur, fromQty: curQty, flag: f, foreign, note: g.note ?? null, held: prot.held };
}
