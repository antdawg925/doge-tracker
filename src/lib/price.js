/** Spot + 24h change for crypto (CoinGecko) or stock (Yahoo). */

import { fetchCoinGeckoJson } from './coingecko.js';
import { fetchYahooChart } from './yahoo.js';

/**
 * Returns `{ price, change24h, source, name? }`.
 */
export async function fetchSpot(asset, { signal } = {}) {
  if (!asset) throw new Error('No asset selected');

  if (asset.type === 'stock') {
    const chart = await fetchYahooChart(asset.symbol, '1mo', { signal });
    if (chart.spot == null) throw new Error('No Yahoo quote for symbol');
    return {
      price: chart.spot,
      change24h: chart.change24h,
      source: 'yahoo',
      name: chart.shortName || asset.name,
    };
  }

  const coinId = asset.id || 'dogecoin';
  const path = `/simple/price?ids=${encodeURIComponent(coinId)}&vs_currencies=usd&include_24hr_change=true`;
  const { data } = await fetchCoinGeckoJson(path, { signal, maxRetries: 3 });
  const row = data?.[coinId];
  if (row?.usd == null) {
    throw new Error('Symbol not found on CoinGecko');
  }
  return {
    price: row.usd,
    change24h:
      typeof row.usd_24h_change === 'number' ? row.usd_24h_change : null,
    source: 'coingecko',
  };
}
