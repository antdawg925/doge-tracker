/** Spot + 24h change for crypto (CoinGecko → Kraken → Yahoo) or stock (Yahoo). */

import { fetchCoinGeckoJson } from './coingecko.js';
import { fetchKrakenSpot, krakenPairFor } from './history.js';
import { fetchYahooChart } from './yahoo.js';

/** Yahoo crypto tickers use SYMBOL-USD (BTC-USD, DOGE-USD, …). */
function yahooCryptoSymbol(asset) {
  const raw = String(asset?.symbol || '').trim().toUpperCase();
  if (!raw) return null;
  if (raw.includes('-')) return raw;
  if (raw === 'XBT') return 'BTC-USD';
  return `${raw}-USD`;
}

async function fetchCryptoSpotCoinGecko(asset, signal) {
  const coinId = asset.id || 'dogecoin';
  const path = `/simple/price?ids=${encodeURIComponent(coinId)}&vs_currencies=usd&include_24hr_change=true`;
  // Prefer fallback over hammering free-tier 429s (1–2 attempts max).
  const { data } = await fetchCoinGeckoJson(path, { signal, maxRetries: 2 });
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

async function fetchCryptoSpotKraken(asset, signal) {
  const pair = krakenPairFor(asset);
  if (!pair) {
    const err = new Error('No Kraken pair for symbol');
    err.skip = true;
    throw err;
  }
  return fetchKrakenSpot(pair, { signal });
}

async function fetchCryptoSpotYahoo(asset, signal) {
  const ySymbol = yahooCryptoSymbol(asset);
  if (!ySymbol) throw new Error('No Yahoo crypto symbol');
  const chart = await fetchYahooChart(ySymbol, '5d', { signal });
  if (chart.spot == null) throw new Error('No Yahoo crypto quote');
  return {
    price: chart.spot,
    change24h: chart.change24h,
    source: 'yahoo',
    name: chart.shortName || asset.name,
  };
}

/**
 * Returns `{ price, change24h, source, name?, warning? }`.
 * Stocks: Yahoo only. Crypto: CoinGecko, then Kraken pair map, then Yahoo *-USD.
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

  let lastErr = null;
  let rateLimited = false;

  try {
    return await fetchCryptoSpotCoinGecko(asset, signal);
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    lastErr = err;
    if (err?.rateLimited || /429/.test(err?.message || '')) {
      rateLimited = true;
    }
  }

  try {
    const spot = await fetchCryptoSpotKraken(asset, signal);
    return {
      ...spot,
      warning: rateLimited
        ? 'Spot via Kraken (CoinGecko rate-limited)'
        : 'Spot via Kraken (CoinGecko unavailable)',
    };
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    if (!err?.skip) lastErr = err;
  }

  try {
    const spot = await fetchCryptoSpotYahoo(asset, signal);
    return {
      ...spot,
      warning: rateLimited
        ? 'Spot via Yahoo (CoinGecko rate-limited)'
        : 'Spot via Yahoo (CoinGecko unavailable)',
    };
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    lastErr = err;
  }

  const wrapped = new Error(
    lastErr?.message ||
      (rateLimited
        ? 'HTTP 429 (CoinGecko rate limited)'
        : 'Failed to fetch crypto spot'),
  );
  wrapped.rateLimited = rateLimited || Boolean(lastErr?.rateLimited);
  throw wrapped;
}
