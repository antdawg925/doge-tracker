/** Distance from spot to a level as percent (positive = level above spot). */
export function distanceToLevel(spot, level) {
  if (!spot || level == null) return null;
  return ((level - spot) / spot) * 100;
}

/** Coins from USD notional at a price. */
export function coinsFromUsd(usd, price) {
  if (!price || price <= 0) return 0;
  return usd / price;
}

/** Mark-to-market P&L for a sleeve given current coins and avg cost. */
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

/** Split current DOGE $ into core/sleeve by target weights. */
export function allocationSplit(dogeValue, coreUsd, sleeveUsd) {
  const target = (coreUsd || 0) + (sleeveUsd || 0);
  if (target <= 0) {
    return { coreValue: dogeValue, sleeveValue: 0, corePct: 100, sleevePct: 0 };
  }
  const corePct = (coreUsd / target) * 100;
  const sleevePct = (sleeveUsd / target) * 100;
  return {
    coreValue: dogeValue * (coreUsd / target),
    sleeveValue: dogeValue * (sleeveUsd / target),
    corePct,
    sleevePct,
  };
}

/** Progress toward DOGE book target. */
export function targetProgress(dogeValue, targetDogeUsd) {
  if (!targetDogeUsd || targetDogeUsd <= 0) return 0;
  return Math.min(100, (dogeValue / targetDogeUsd) * 100);
}

/** Status of spot vs a ladder band. */
export function ladderStatus(spot, low, high) {
  if (spot == null) return 'unknown';
  if (spot > high) return 'above';
  if (spot < low) return 'below';
  return 'at';
}

/** Midpoint of a ladder band for coin estimates. */
export function bandMid(low, high) {
  return (low + high) / 2;
}

/** Account totals at a mark price given current doge value at spot. */
export function scenarioRow(
  spot,
  mark,
  dogeValue,
  avgCost,
  coreUsd,
  sleeveUsd,
  cashUsd,
  accountSize,
) {
  const markPrice = mark == null ? spot : mark;
  if (!spot || !markPrice || dogeValue == null) {
    return null;
  }
  const coins = dogeValue / spot;
  const { coreValue: coreAtSpot, sleeveValue: sleeveAtSpot } = allocationSplit(
    dogeValue,
    coreUsd,
    sleeveUsd,
  );
  const coreCoins = coreAtSpot / spot;
  const sleeveCoins = sleeveAtSpot / spot;

  const core = sleevePnl(coreCoins, avgCost, markPrice);
  const sleeve = sleevePnl(sleeveCoins, avgCost, markPrice);
  const totalPnl = core.pnl + sleeve.pnl;
  const dogeMarkValue = coins * markPrice;
  // Hold non-DOGE capital constant so spot marks ~0% vs account size.
  const other = (accountSize || 0) - (cashUsd || 0) - (dogeValue || 0);
  const accountMark = other + (cashUsd || 0) + dogeMarkValue;
  const accountPct =
    accountSize > 0 ? ((accountMark - accountSize) / accountSize) * 100 : 0;

  return {
    mark: markPrice,
    isSpot: mark == null,
    corePnl: core.pnl,
    sleevePnl: sleeve.pnl,
    totalPnl,
    dogeMarkValue,
    accountMark,
    accountPct,
  };
}
