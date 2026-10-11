/**
 * Paper vs real money, from actual flags. Real money needs every gate open:
 * Schwab connected + "Live Schwab stops" ON + live orders not paused (kill switch) + the row's own flag.
 */
export const schwabLiveOn = (conn) => Boolean(conn && conn.status === 'connected' && conn.liveEnabled && !conn.killSwitch);

/** My Bot → Stocks position row: its Live toggle AND the global Schwab gates. */
export const positionMode = (p, conn) => (p?.live && schwabLiveOn(conn) ? 'live' : 'paper');

/** Buy dips / Sell highs plan: not dry_run AND Stocks Live ON AND the global Schwab gates. */
export const planMode = (plan, stocksLive, conn) => (!plan?.dry_run && stocksLive && schwabLiveOn(conn) ? 'live' : 'paper');

/** What's still blocking real orders (empty = all gates open). */
export function liveBlockers(stocksLive, conn) {
  const out = [];
  if (!stocksLive) out.push('Stocks Live off');
  if (!conn || conn.status !== 'connected') out.push('Schwab not connected');
  else {
    if (!conn.liveEnabled) out.push('Live Schwab stops off');
    if (conn.killSwitch) out.push('live orders paused');
  }
  return out;
}

/**
 * Buy dips / Sell highs plan: 'live' (real orders now) · 'waiting' (real plan, a live gate is off:
 * nothing sent yet) · 'paper' (dry-run plan). reason = first blocker for 'waiting'.
 */
export function planState(plan, stocksLive, conn) {
  if (plan?.dry_run) return { mode: 'paper', reason: null };
  const b = liveBlockers(stocksLive, conn);
  return b.length ? { mode: 'waiting', reason: b[0] } : { mode: 'live', reason: null };
}

/** Regular session right now (9:30 to the close, NYSE days) — same calendar the server uses. */
export { etParts, isTradingDay, closeMinutes } from '../../shared/marketHours.js';
