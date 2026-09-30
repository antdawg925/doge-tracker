/**
 * FUTURE live-order path for stocks (Schwab Trader API). Not wired up: the stock
 * manager is WATCH-ONLY today and nothing in the app calls this.
 *
 * Rule for whoever builds it: every order MUST go through shared/guard.js first —
 *   preTradeCheck(guard, { kind, bookValueNow })  before placing / modifying an order
 *   afterFill(guard, { fill, bookValueAtFill, nowIso }) after each fill
 * (the same Profit lock / Pause functions the DOGE paper book uses), with the guard row
 * read from bot_guard for (user_id, symbol) and written back with an updated_at check.
 */
import { preTradeCheck } from '../shared/guard.js'

export const STOCK_ORDERS_ENABLED = false

export async function placeStockStopOrder({ guard, kind = 'stop_update', bookValueNow = null } = {}) {
  const gate = preTradeCheck(guard, { kind, bookValueNow })
  if (!gate.allowed) return { placed: false, ...gate }
  if (!STOCK_ORDERS_ENABLED) return { placed: false, reason: 'watch-only: move the stop at Schwab yourself' }
  throw new Error('Schwab Trader API is not connected')
}
