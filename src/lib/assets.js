/** Asset identity helpers: crypto (CoinGecko id) vs stock (Yahoo symbol). */

export const DEFAULT_ASSET = {
  symbol: 'DOGE',
  name: 'Dogecoin',
  type: 'crypto',
  id: 'dogecoin',
};

/** Stable localStorage / cache key for an asset. */
export function assetKey(asset) {
  if (!asset) return 'crypto:dogecoin';
  if (asset.type === 'stock') {
    return `stock:${String(asset.symbol || '').toUpperCase()}`;
  }
  const id = asset.id || String(asset.symbol || 'dogecoin').toLowerCase();
  return `crypto:${id}`;
}

export function unitLabel(asset) {
  return asset?.type === 'stock' ? 'shares' : 'coins';
}

export function unitLabelSingular(asset) {
  return asset?.type === 'stock' ? 'share' : 'coin';
}

export function holdingFieldLabel(asset) {
  return asset?.type === 'stock' ? 'Share holding' : 'Coin holding';
}

export function avgCostHint(asset) {
  return asset?.type === 'stock'
    ? '$ per share you paid'
    : '$ per coin you paid';
}

export function sourceBadge(asset) {
  return asset?.type === 'stock' ? 'Yahoo' : 'CoinGecko';
}

export function displaySymbol(asset) {
  return (asset?.symbol || '—').toUpperCase();
}

/** Sensible empty defaults when switching to a new symbol. */
export function emptyPositionFor(asset) {
  if (asset?.type === 'stock') {
    return { coins: 10, avgCost: 100, targetPrice: 150 };
  }
  // Crypto: leave small illustrative amounts; DOGE keeps classic defaults elsewhere
  return { coins: 100, avgCost: 1, targetPrice: 2 };
}
