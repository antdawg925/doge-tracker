/**
 * Schwab broker adapter — PLACEHOLDER implementing the same interface as the paper adapter
 * (shared/broker/index.js): placeStop, modifyStop, cancel, getPositions, syncFills.
 * Not wired up: stocks are paper + watch-only until the Schwab Trader API app is approved.
 *
 * Going live = make brokerFor() (shared/broker/index.js) return createSchwabBroker(...) for
 * users who connected Schwab. The runner already routes every action through
 * shared/stockPaper.js, which calls shared/guard.js orderCheck() before each action and
 * afterBookFill() after each fill — adapters must never be called around that layer.
 * Server-only (OAuth tokens would live in server env / a server-only table, never the browser).
 */
export const STOCK_ORDERS_ENABLED = false

const notConnected = async () => {
  throw new Error('Schwab Trader API is not connected (paper / watch-only)')
}

export function createSchwabBroker(/* { accountHash, accessToken, nowIso } */) {
  return {
    kind: 'schwab',
    // POST /trader/v1/accounts/{accountHash}/orders  (STOP, SELL or BUY_TO_COVER, GTC)
    placeStop: notConnected,
    // PUT  /trader/v1/accounts/{accountHash}/orders/{orderId}  (replace with the new stopPrice)
    modifyStop: notConnected,
    // DELETE /trader/v1/accounts/{accountHash}/orders/{orderId}
    cancel: notConnected,
    // GET  /trader/v1/accounts/{accountHash}?fields=positions
    getPositions: notConnected,
    // GET  /trader/v1/accounts/{accountHash}/orders?status=FILLED  → executions for our stop orders
    syncFills: notConnected,
  }
}
