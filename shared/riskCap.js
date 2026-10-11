/**
 * Per-position emergency Risk cap (kill switch). Separate from the stop: it never moves the stop.
 * If the open (unrealized) $ loss exceeds risk_cap_usd, the position is halted (risk_tripped_at).
 */

/**
 * What tripping does. 'halt' = bot places / moves / cancels nothing more for the position; resting
 * Schwab stop orders stay in place (protection is not cancelled).
 * TODO(Anthony decision pending): 'halt_and_exit' would also flatten the position at market.
 * Not implemented — the runner only branches on this constant, so adding it is isolated.
 */
export const RISK_CAP_ACTION = 'halt'

/** Open $ loss (positive number, 0 if in profit) for side / entry / price / qty; null if unknown. */
export function openLoss({ side, entry, price, qty }) {
  const e = Number(entry)
  const p = Number(price)
  const q = Number(qty)
  if (!(e > 0) || !(p > 0) || !(q > 0)) return null
  const pnl = (side === 'short' ? e - p : p - e) * q
  return pnl < 0 ? -pnl : 0
}

/** True when a cap is set and the open loss is strictly above it. */
export function riskCapHit(cap, loss) {
  const c = Number(cap)
  return c > 0 && loss != null && loss > c
}
