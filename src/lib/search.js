/** Unified symbol search: CoinGecko coins + Yahoo equities/ETFs. */

import { fetchCoinGeckoJson } from './coingecko.js';
import { searchYahoo } from './yahoo.js';

/**
 * Search both sources in parallel. Returns mixed list with `type` labels.
 * Soft-fails per source so one outage doesn't blank results.
 */
export async function searchSymbols(query, { signal, limit = 6 } = {}) {
  const q = String(query || '').trim();
  if (q.length < 1) return { results: [], warnings: [] };

  const warnings = [];
  let crypto = [];
  let stocks = [];

  const cryptoPromise = (async () => {
    try {
      const { data } = await fetchCoinGeckoJson(
        `/search?query=${encodeURIComponent(q)}`,
        { signal, maxRetries: 2 },
      );
      const coins = Array.isArray(data?.coins) ? data.coins : [];
      return coins.slice(0, limit).map((c) => ({
        symbol: String(c.symbol || '').toUpperCase(),
        name: c.name || c.symbol,
        type: 'crypto',
        id: c.id,
        marketCapRank: c.market_cap_rank ?? null,
        thumb: c.thumb || null,
      }));
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      warnings.push(
        err?.rateLimited || /429/.test(err?.message || '')
          ? 'Crypto search rate-limited'
          : `Crypto search failed (${err?.message || 'error'})`,
      );
      return [];
    }
  })();

  const stockPromise = (async () => {
    try {
      return await searchYahoo(q, { signal, limit });
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      warnings.push(
        err?.rateLimited || /429/.test(err?.message || '')
          ? 'Stock search rate-limited'
          : `Stock search failed (${err?.message || 'error'})`,
      );
      return [];
    }
  })();

  const [c, s] = await Promise.all([cryptoPromise, stockPromise]);
  crypto = c;
  stocks = s;

  // Interleave: prefer exact symbol matches first across both
  const upper = q.toUpperCase();
  const score = (item) => {
    let s = 0;
    if (item.symbol === upper) s += 100;
    else if (item.symbol?.startsWith(upper)) s += 50;
    if (item.type === 'crypto' && item.marketCapRank != null) {
      s += Math.max(0, 30 - Math.min(30, item.marketCapRank));
    }
    return s;
  };

  const merged = [...crypto, ...stocks].sort((a, b) => score(b) - score(a));

  return { results: merged.slice(0, limit * 2), warnings };
}
