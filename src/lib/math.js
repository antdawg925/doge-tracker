/** Distance from spot to a level as percent (positive = level above spot). */
export function distanceToLevel(spot, level) {
  if (!spot || level == null) return null;
  return ((level - spot) / spot) * 100;
}

/** Mark-to-market P&L for a holding given coins and avg cost. */
export function sleevePnl(coins, avgCost, markPrice) {
  if (!coins || avgCost == null || markPrice == null) {
    return { value: 0, cost: 0, pnl: 0, pnlPct: 0 };
  }
  const cost = coins * avgCost;
  const value = coins * markPrice;
  const pnl = value - cost;
  const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0;
  return { value, cost, pnl, pnlPct };
}

/**
 * Derived metrics for the simple three-field position model.
 * Avoids $0 / 0% bugs when coins or prices are missing.
 */
export function positionMetrics(coins, avgCost, spot, targetPrice) {
  const c = Number.isFinite(coins) && coins > 0 ? coins : 0;
  const cost =
    c > 0 && Number.isFinite(avgCost) ? c * avgCost : 0;
  const value =
    c > 0 && Number.isFinite(spot) && spot > 0 ? c * spot : 0;
  const pnl = value - cost;
  const pnlPct = cost > 0 ? (pnl / cost) * 100 : null;

  const atTarget =
    c > 0 && Number.isFinite(targetPrice) && targetPrice > 0
      ? c * targetPrice
      : null;
  const atTargetPnl =
    atTarget != null && cost > 0 ? atTarget - cost : null;
  const atTargetPnlPct =
    atTargetPnl != null && cost > 0 ? (atTargetPnl / cost) * 100 : null;

  return {
    coins: c,
    costBasis: cost,
    positionValue: value,
    unrealizedPnl: pnl,
    unrealizedPnlPct: pnlPct,
    atTargetValue: atTarget,
    atTargetPnl,
    atTargetPnlPct,
  };
}

/** True when the user entered a real holding (qty > 0 and avg cost > 0). */
export function hasEnteredPosition(coins, avgCost) {
  return (
    Number.isFinite(coins) &&
    coins > 0 &&
    Number.isFinite(avgCost) &&
    avgCost > 0
  );
}
