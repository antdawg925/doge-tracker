/**
 * Stock PAPER trading: simulates the bot managing a protective stop order per position
 * through a broker adapter (shared/broker/*), with every action gated by shared/guard.js.
 *
 *   entry        position added → paper opens it at YOUR entry price and places the stop at
 *                the computed level (risk-adding: blocked while locked / paused)
 *   modify       computed stop tightens (after-close pass) → the order moves automatically,
 *                old → new logged (protective: always allowed)
 *   fill         in market hours the latest quote crosses the stop (long ≤, short ≥) → fills
 *                at THAT quote, not the stop level; first check of the day with the open
 *                already beyond the stop is logged as a gap fill (protective: always allowed)
 *   re-entry     you edit side / entry / date / shares → the old paper trade is closed at the
 *                current price and a new one opens (risk-adding: blocked while locked / paused)
 *   closed       you mark the real position closed → paper closes at the last price seen
 *
 * Tally: paper P/L = realized (fills) + unrealized (working, marked to the last price);
 * hold = the same positions marked to market with no stop.
 * Book (for the Profit lock) = Σ entry basis of your active positions + paper P/L;
 * baseline = Σ entry basis (+ paper P/L at your last "Authorize"); max loss default $1.
 */
import { afterBookFill, orderCheck } from './guard.js';
import { etDate } from './marketHours.js';
import { stopAnchor } from './stockEngine.js';

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const EPS = 1e-9;

export const paperAnchor = (p) => `${stopAnchor(p)}|${Number(p.shares)}`;

/** Mark-to-market P/L of one paper order at a price. */
export function markPnl(o, price) {
  if (!Number.isFinite(Number(price))) return 0;
  const q = n(o.qty);
  const e = n(o.entry_price);
  return (o.position_side === 'long' ? n(price) - e : e - n(price)) * q;
}

/** Per-order paper and hold P/L. */
export function orderPnl(o) {
  const d = o.data || {};
  const priorR = n(d.prior_realized);
  const priorH = n(d.prior_hold);
  if (o.status === 'working') {
    const m = markPnl(o, o.last_price);
    return { paper: priorR + m, hold: priorH + m, realized: priorR, unrealized: m };
  }
  if (o.status === 'filled') {
    return { paper: priorR + n(o.realized_pnl), hold: priorH + markPnl(o, o.last_price), realized: priorR + n(o.realized_pnl), unrealized: 0 };
  }
  if (o.status === 'closed') {
    return { paper: priorR + n(o.realized_pnl), hold: priorH + markPnl(o, o.fill_price), realized: priorR + n(o.realized_pnl), unrealized: 0 };
  }
  return { paper: priorR, hold: priorH, realized: priorR, unrealized: 0 }; // blocked
}

/** Per-user tally across every paper order. */
export function paperTally(orders) {
  const t = { paper: 0, hold: 0, realized: 0, unrealized: 0, working: 0, filled: 0, blocked: 0, closed: 0, orders: 0 };
  for (const o of orders || []) {
    const p = orderPnl(o);
    t.paper += p.paper;
    t.hold += p.hold;
    t.realized += p.realized;
    t.unrealized += p.unrealized;
    t[o.status] = (t[o.status] || 0) + 1;
    t.orders += 1;
  }
  t.vsHold = t.paper - t.hold;
  return t;
}

/** Book parts for the guard: basis of active, entered positions + total paper P/L. */
export function bookParts(orders, activeIds) {
  let basis = 0;
  for (const o of orders) {
    if ((o.status === 'working' || o.status === 'filled') && activeIds.has(o.position_id)) basis += n(o.qty) * n(o.entry_price);
  }
  const pnl = paperTally(orders).paper;
  return { basis, pnl, book: basis + pnl };
}

/** Baseline = basis + P/L at the last re-authorization; returns the guard with it set. */
export function withBaseline(guard, basis) {
  if (!guard) return guard;
  return { ...guard, baseline_value: basis + n(guard.data?.reauth_pnl) };
}

/** Fresh stocks guard row (armed; max loss $1 unless carried over). */
export function initStockGuard({ nowIso, prev = null }) {
  return {
    locked: Boolean(prev?.locked),
    locked_at: prev?.locked_at ?? null,
    lock_reason: prev?.lock_reason ?? null,
    paused: Boolean(prev?.paused),
    paused_at: prev?.paused_at ?? null,
    paused_by: prev?.paused_by ?? null,
    unlocked_at: prev?.unlocked_at ?? null,
    unlocked_by: prev?.unlocked_by ?? null,
    baseline_value: null,
    baseline_source: 'entry_basis',
    baseline_set_at: nowIso,
    realized_pnl: n(prev?.realized_pnl),
    max_loss_usd: prev?.max_loss_usd ?? 1,
    data: { reauth_pnl: 0, ...(prev?.data || {}) },
  };
}

/**
 * One position, one run.
 * @param broker    adapter (paper today)
 * @param position  stock_positions row (active)
 * @param snapshot  evaluateStockPosition(...).snapshot (stop, price)
 * @param guard     stocks guard (mutable copy returned)
 * @param ctx       { nowMs, canFill (US market open), open (today's open or null), activeIds:Set }
 * @returns {{ guard, events: [], fill: object|null, lockedNow: string|null }}
 */
export async function stepPaperStop({ broker, position, snapshot, guard, nowMs, canFill = false, open = null, activeIds }) {
  const nowIso = new Date(nowMs).toISOString();
  const today = etDate(nowMs);
  const anchor = paperAnchor(position);
  const stop = snapshot.stop;
  const price = snapshot.price;
  const long = position.side === 'long';
  const events = [];
  let g = guard;
  let fill = null;
  let lockedNow = null;
  const ev = (kind, extra = {}) => events.push({ kind, position_id: position.id, symbol: position.symbol, at: nowIso, qty: n(position.shares), ...extra });
  const book = () => bookParts(broker.orders(), activeIds);
  const check = (kind) => orderCheck(g, { kind, bookValueNow: book().book });

  const place = async (kind, prior = {}) => {
    const gate = check(kind);
    if (!gate.allowed) {
      const cur = broker.get(position.id);
      const reason = gate.reason;
      if (!(cur?.status === 'blocked' && cur.anchor === anchor)) ev('blocked', { new_price: stop, reason });
      broker.put({
        ...(cur || {}),
        position_id: position.id,
        user_id: position.user_id,
        symbol: position.symbol,
        position_side: position.side,
        order_side: long ? 'sell' : 'buy',
        qty: n(position.shares),
        entry_price: n(position.entry_price),
        stop_price: stop,
        status: 'blocked',
        anchor,
        broker: 'paper',
        last_price: price,
        last_price_at: nowIso,
        data: { ...(cur?.data || {}), ...prior, blocked_reason: reason },
      });
      return false;
    }
    await broker.placeStop({
      positionId: position.id,
      userId: position.user_id,
      symbol: position.symbol,
      positionSide: position.side,
      qty: n(position.shares),
      stopPrice: stop,
      entryPrice: n(position.entry_price),
      anchor,
      data: prior,
    });
    broker.put({ ...broker.get(position.id), last_price: price, last_price_at: nowIso });
    ev('placed', { new_price: stop, reason: `${kind === 'reentry' ? 'Re-entry' : 'Entry'} ${long ? 'long' : 'short'} ${n(position.shares)} @ ${n(position.entry_price)}; paper stop placed`, guard_note: gate.note ?? null });
    return true;
  };

  let o = broker.get(position.id);

  // --- re-entry: you changed side / entry / date / shares
  if (o && o.anchor !== anchor) {
    const d = { ...(o.data || {}) };
    if (o.status === 'working') {
      const gate = orderCheck(g, { kind: 'cancel_stop' });
      const pnl = markPnl(o, price);
      d.prior_realized = n(d.prior_realized) + pnl;
      d.prior_hold = n(d.prior_hold) + pnl;
      await broker.cancel(position.id, { reason: 'position edited' });
      ev('closed', { old_price: o.stop_price, fill_price: price, pnl, reason: 'Position edited: old paper trade closed at the current price', guard_note: gate.note ?? null });
    } else if (o.status === 'filled' || o.status === 'closed') {
      d.prior_realized = n(d.prior_realized) + n(o.realized_pnl);
      d.prior_hold = n(d.prior_hold) + markPnl(o, o.status === 'filled' ? price : o.fill_price);
    }
    broker.put({ ...broker.get(position.id), data: d });
    await place('reentry', { prior_realized: n(d.prior_realized), prior_hold: n(d.prior_hold) });
  } else if (!o) {
    await place('entry');
  } else if (o.status === 'blocked') {
    await place('entry', { prior_realized: n(o.data?.prior_realized), prior_hold: n(o.data?.prior_hold) });
  } else if (o.status === 'working' && Math.abs(stop - o.stop_price) > EPS) {
    const tighter = long ? stop > o.stop_price : stop < o.stop_price;
    const gate = check(tighter ? 'tighten_stop' : 'loosen_stop');
    if (gate.allowed) {
      await broker.modifyStop(position.id, { stopPrice: stop });
      ev('modified', { old_price: o.stop_price, new_price: stop, reason: `Paper stop ${tighter ? (long ? 'raised' : 'lowered') : 'loosened'} automatically`, guard_note: gate.note ?? null });
    } else if (o.data?.loosen_blocked !== stop) {
      ev('blocked', { old_price: o.stop_price, new_price: stop, reason: gate.reason });
      broker.put({ ...o, data: { ...o.data, loosen_blocked: stop } });
    }
  }

  // --- fills (market hours only), then mark to market
  o = broker.get(position.id);
  if (o?.status === 'working' && canFill) {
    const firstCheckToday = o.data?.last_check_day !== today;
    const gate = orderCheck(g, { kind: 'stop_fill' }); // protective: always allowed
    fill = await broker.syncFills(position.id, { price, at: nowIso, open, firstCheckToday });
    if (fill) {
      ev('filled', {
        old_price: fill.stopPrice,
        fill_price: fill.price,
        pnl: fill.pnl,
        reason: `${fill.gap ? 'Gapped through' : 'Hit'} the paper stop ${fill.stopPrice.toFixed(2)}; filled at ${fill.price.toFixed(2)} (price the check saw)`,
        guard_note: gate.note ?? null,
      });
      const parts = book();
      g = withBaseline(g, parts.basis);
      const after = afterBookFill(g, { fill: { kind: 'stop_fill', symbol: position.symbol, side: fill.side, units: fill.units, price: fill.price, pnl: fill.pnl }, bookValueAtFill: parts.book, nowIso });
      g = after.guard;
      if (after.locked) lockedNow = after.reason;
    }
    o = broker.get(position.id);
    broker.put({ ...o, data: { ...o.data, last_check_day: today } });
  }
  o = broker.get(position.id);
  if (o && (o.status === 'working' || o.status === 'filled' || o.status === 'blocked')) {
    broker.put({ ...o, last_price: price, last_price_at: nowIso });
  }
  return { guard: g, events, fill, lockedNow };
}

/** Real position marked closed while its paper order is working → close at the last price. */
export async function closeWithPosition({ broker, order, guard, nowMs }) {
  const nowIso = new Date(nowMs).toISOString();
  const gate = orderCheck(guard, { kind: 'cancel_stop' });
  const price = n(order.last_price) || n(order.entry_price);
  const pnl = markPnl(order, price);
  await broker.cancel(order.position_id, { reason: 'position closed' });
  broker.put({ ...broker.get(order.position_id), fill_price: price, realized_pnl: pnl, filled_at: nowIso });
  return [{ kind: 'closed', position_id: order.position_id, symbol: order.symbol, at: nowIso, qty: n(order.qty), old_price: order.stop_price, fill_price: price, pnl, reason: 'You closed the position; paper closed at the last price seen', guard_note: gate.note ?? null }];
}
