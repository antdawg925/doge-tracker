/**
 * Paper vs real money, from actual flags. Real money needs every gate open:
 * Schwab connected + "Live Schwab stops" ON + live orders not paused (kill switch) + the row's own flag.
 */
export const schwabLiveOn = (conn) => Boolean(conn && conn.status === 'connected' && conn.liveEnabled && !conn.killSwitch);

/** My Bot → Stocks position row: its Live toggle AND the global Schwab gates. */
export const positionMode = (p, conn) => (p?.live && schwabLiveOn(conn) ? 'live' : 'paper');

/** Buy dips / Sell highs plan: not dry_run AND Stocks Live ON AND the global Schwab gates. */
export const planMode = (plan, stocksLive, conn) => (!plan?.dry_run && stocksLive && schwabLiveOn(conn) ? 'live' : 'paper');
