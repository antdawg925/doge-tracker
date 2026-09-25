/** Editable defaults + per-symbol localStorage persistence. */

import {
  DEFAULT_ASSET,
  assetKey,
  emptyPositionFor,
} from './assets.js';

export const STORAGE_KEY = 'doge-tracker-state-v2';
export const LEGACY_STORAGE_KEY = 'doge-tracker-position-v1';

/** Classic DOGE shareable defaults. */
export const DEFAULTS = {
  coins: 24324, // ~$1,800 at $0.074
  avgCost: 0.074,
  targetPrice: 0.2,
};

export function defaultPositionFor(asset) {
  if (
    asset?.type === 'crypto' &&
    (asset.id === 'dogecoin' || asset.symbol === 'DOGE')
  ) {
    return { ...DEFAULTS };
  }
  return emptyPositionFor(asset);
}

/**
 * Load app state: selected asset + positions map + watchlist.
 * Migrates legacy v1 single-position DOGE storage.
 */
export function loadAppState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return normalizeState(parsed);
    }
  } catch {
    /* fall through to legacy */
  }

  // Legacy v1: only DOGE position fields
  try {
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy) {
      const parsed = JSON.parse(legacy);
      const pos = migratePosition(parsed);
      const asset = { ...DEFAULT_ASSET };
      return {
        selected: asset,
        positions: {
          [assetKey(asset)]: { ...DEFAULTS, ...pos },
        },
        watchlist: [{ ...asset }],
      };
    }
  } catch {
    /* ignore */
  }

  return {
    selected: { ...DEFAULT_ASSET },
    positions: {
      [assetKey(DEFAULT_ASSET)]: { ...DEFAULTS },
    },
    watchlist: [{ ...DEFAULT_ASSET }],
  };
}

function normalizeAsset(raw) {
  if (!raw || !raw.symbol) return null;
  return {
    symbol: String(raw.symbol).toUpperCase(),
    name: raw.name || raw.symbol,
    type: raw.type === 'stock' ? 'stock' : 'crypto',
    id: raw.id || undefined,
  };
}

function normalizeWatchlist(raw, selected) {
  const out = [];
  const seen = new Set();
  const push = (asset) => {
    if (!asset) return;
    const key = assetKey(asset);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(asset);
  };

  if (Array.isArray(raw)) {
    for (const item of raw) {
      push(normalizeAsset(item));
    }
  }

  // Ensure selected is on the list so the rail isn't empty after migrate
  push(selected);
  return out;
}

function normalizeState(raw) {
  const selected =
    normalizeAsset(raw?.selected) || { ...DEFAULT_ASSET };

  const positions = {};
  if (raw?.positions && typeof raw.positions === 'object') {
    for (const [k, v] of Object.entries(raw.positions)) {
      if (!v || typeof v !== 'object') continue;
      positions[k] = {
        coins: Number.isFinite(v.coins) ? v.coins : 0,
        avgCost: Number.isFinite(v.avgCost) ? v.avgCost : 0,
        targetPrice: Number.isFinite(v.targetPrice) ? v.targetPrice : 0,
      };
    }
  }

  const key = assetKey(selected);
  if (!positions[key]) {
    positions[key] = defaultPositionFor(selected);
  }

  const watchlist = normalizeWatchlist(raw?.watchlist, selected);

  return { selected, positions, watchlist };
}

export function saveAppState(state) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        selected: state.selected,
        positions: state.positions,
        watchlist: Array.isArray(state.watchlist) ? state.watchlist : [],
      }),
    );
  } catch {
    /* quota / private mode */
  }
}

/**
 * Load + migrate a single position object.
 * Old shape used dogeValue ($) + avgCost; new shape uses coins.
 */
export function loadPosition(spot = null) {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...migratePosition(parsed, spot) };
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

/** Resolve position for an asset from the positions map. */
export function positionFor(positions, asset) {
  const key = assetKey(asset);
  if (positions?.[key]) return positions[key];
  return defaultPositionFor(asset);
}

/** Select an asset on the Research desk (used when navigating from other tabs). */
export function openAssetOnDesk(asset) {
  const prev = loadAppState();
  const key = assetKey(asset);
  const positions = { ...(prev.positions || {}) };
  if (!positions[key]) positions[key] = emptyPositionFor(asset);
  const list = Array.isArray(prev.watchlist) ? prev.watchlist : [];
  const watchlist = list.some((a) => assetKey(a) === key) ? list : [...list, { ...asset }];
  saveAppState({ selected: { ...asset }, positions, watchlist });
}
