/** Dad-friendly Upside / Risk lines for Support, Resistance, and Stops. */

import { formatUsd } from './format.js';

/**
 * Resistance / upside line.
 * With a position: $ and % vs average cost.
 * Researching only: percent from today — never invent dollars.
 */
export function upsideFromHereCopy({
  hasPosition,
  usdVsCost,
  pctVsCost,
  pctFromSpot,
}) {
  if (
    hasPosition &&
    usdVsCost != null &&
    Number.isFinite(usdVsCost) &&
    pctVsCost != null &&
    Number.isFinite(pctVsCost)
  ) {
    const verb = usdVsCost >= 0 ? 'gain about' : 'lose about';
    return `Upside from here: ${verb} ${formatUsd(Math.abs(usdVsCost), {
      decimals: 0,
    })} (${Math.abs(pctVsCost).toFixed(1)}%) vs your average cost`;
  }
  if (pctFromSpot != null && Number.isFinite(pctFromSpot)) {
    return `Upside from here: about ${Math.abs(pctFromSpot).toFixed(1)}% from today`;
  }
  return 'Upside from here: —';
}

/**
 * Support / stop risk line.
 * With a position: $ and % vs average cost.
 * Researching only: percent below today — never invent dollars.
 */
export function riskFromHereCopy({
  hasPosition,
  usdVsCost,
  pctVsCost,
  pctFromSpot,
}) {
  if (
    hasPosition &&
    usdVsCost != null &&
    Number.isFinite(usdVsCost) &&
    pctVsCost != null &&
    Number.isFinite(pctVsCost)
  ) {
    const verb =
      usdVsCost >= 0 ? 'still ahead about' : 'lose about';
    return `Risk from here: ${verb} ${formatUsd(Math.abs(usdVsCost), {
      decimals: 0,
    })} (${Math.abs(pctVsCost).toFixed(1)}%) vs your average cost`;
  }
  if (pctFromSpot != null && Number.isFinite(pctFromSpot)) {
    return `Risk from here: about ${Math.abs(pctFromSpot).toFixed(1)}% below today`;
  }
  return 'Risk from here: —';
}
