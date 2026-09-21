/** Editable default position — single DOGE holding for shareable view. */
export const STORAGE_KEY = 'doge-tracker-position-v1';

/** Simplified shareable defaults (coins × illustrative avg cost). */
export const DEFAULTS = {
  coins: 24324, // ~$1,800 at $0.074
  avgCost: 0.074,
  targetPrice: 0.2,
};

/**
 * Load + migrate position from localStorage.
 * Old shape used dogeValue ($) + avgCost; new shape uses coins.
 */
export function loadPosition(spot = null) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };

    const parsed = JSON.parse(raw);
    const migrated = migratePosition(parsed, spot);
    return { ...DEFAULTS, ...migrated };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Convert legacy keys → { coins, avgCost, targetPrice }. */
export function migratePosition(raw, spot = null) {
  if (!raw || typeof raw !== 'object') return {};

  const avgCost =
    Number.isFinite(raw.avgCost) && raw.avgCost > 0
      ? raw.avgCost
      : DEFAULTS.avgCost;

  const targetPrice =
    Number.isFinite(raw.targetPrice) && raw.targetPrice > 0
      ? raw.targetPrice
      : DEFAULTS.targetPrice;

  let coins = null;
  if (Number.isFinite(raw.coins) && raw.coins > 0) {
    coins = raw.coins;
  } else if (Number.isFinite(raw.dogeValue) && raw.dogeValue > 0) {
    // Prefer avgCost (stable), else live spot, else default avgCost
    const divisor =
      avgCost > 0
        ? avgCost
        : Number.isFinite(spot) && spot > 0
          ? spot
          : DEFAULTS.avgCost;
    coins = raw.dogeValue / divisor;
  }

  return {
    coins: coins != null && Number.isFinite(coins) ? coins : DEFAULTS.coins,
    avgCost,
    targetPrice,
  };
}
