/**
 * Stock broker adapter interface. The stock runner only talks to an adapter, so moving a
 * user from paper to Schwab later means swapping the adapter returned by brokerFor().
 * Every method is async and every call is gated by shared/guard.js (orderCheck before,
 * afterBookFill after a fill) in shared/stockPaper.js — adapters never check the guard.
 *
 *   placeStop({ positionId, symbol, positionSide, qty, stopPrice, entryPrice, anchor }) → order
 *   modifyStop(positionId, { stopPrice })                                               → order
 *   cancel(positionId, { reason })                                                      → order
 *   getPositions()  → [{ positionId, symbol, side, qty, entryPrice, status, stopPrice }]
 *   syncFills(positionId, { price, at, open, firstCheckToday }) → fill | null
 *       paper: simulates the stop triggering on the quote the check saw (fills AT that price);
 *       Schwab: reports executions of the real stop order.
 *
 * Order objects use the stock_paper_orders column names (position_id, stop_price, status
 * 'working' | 'filled' | 'closed' | 'blocked', fill_price, …) so the runner can persist them.
 */
import { createPaperBroker } from './paper.js';

export const BROKER_METHODS = Object.freeze(['placeStop', 'modifyStop', 'cancel', 'getPositions', 'syncFills']);

/** Adapter per user. Paper for everyone until the Schwab Trader API is connected. */
export function brokerFor(_profile, { orders = [], nowIso } = {}) {
  return createPaperBroker({ orders, nowIso });
}

export function assertBroker(b) {
  for (const m of BROKER_METHODS) if (typeof b?.[m] !== 'function') throw new Error(`broker adapter missing ${m}()`);
  return b;
}
