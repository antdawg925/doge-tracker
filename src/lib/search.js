/** Unified symbol search: CoinGecko coins + Yahoo equities/ETFs. */

import { fetchCoinGeckoJson } from './coingecko.js';
import { searchYahoo } from './yahoo.js';

/**
 * Tickers that are overwhelmingly equities/ETFs. Same-symbol CoinGecko coins
 * should not outrank Yahoo stock hits for these.
 */
const KNOWN_STOCK_TICKERS = new Set([
  'SPY',
  'QQQ',
  'IWM',
  'DIA',
  'VTI',
  'VOO',
  'TQQQ',
  'SQQQ',
  'IVV',
  'VEA',
  'IEFA',
  'AGG',
  'BND',
  'GLD',
  'SLV',
  'XLF',
  'XLE',
  'XLK',
  'ARKK',
  'AAPL',
  'MSFT',
  'GOOG',
  'GOOGL',
  'AMZN',
  'META',
  'NVDA',
  'TSLA',
  'BRK.B',
  'BRK-B',
  'JPM',
  'V',
  'MA',
  'UNH',
  'JNJ',
  'WMT',
  'XOM',
  'CVX',
]);

/** Top-N CoinGecko market-cap ranks treated as "real" coins for ambiguous tickers. */
const HIGH_CRYPTO_RANK = 50;

function isEquityLike(item) {
  if (item?.type !== 'stock') return false;
  const qt = String(item.quoteType || '').toUpperCase();
  return (
    qt === 'EQUITY' ||
    qt === 'ETF' ||
    qt === 'MUTUALFUND' ||
    qt === 'INDEX' ||
    !qt
  );
}

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

  const upper = q.toUpperCase();
  const exactStockSymbols = new Set(
    stocks.filter((item) => item.symbol === upper).map((item) => item.symbol),
  );
  const knownStockQuery = KNOWN_STOCK_TICKERS.has(upper);

  // Keep notable (high market-cap) coins even when a same-ticker stock exists
  // so the user can choose Stock vs Crypto (e.g. XRP). Drop only obscure
  // same-ticker CoinGecko noise for known mega stocks / exact Yahoo equities.
  // Ranking still prefers SPY/QQQ stocks; UI never auto-picks.
  const filteredCrypto = crypto.filter((item) => {
    if (item.symbol !== upper) return true;
    const rank = item.marketCapRank;
    const isHighRank =
      rank != null && rank > 0 && rank <= HIGH_CRYPTO_RANK;
    if (isHighRank) return true;
    if (exactStockSymbols.has(item.symbol) || knownStockQuery) return false;
    return true;
  });

  const score = (item) => {
    let s = 0;
    const exact = item.symbol === upper;
    if (exact) s += 100;
    else if (item.symbol?.startsWith(upper)) s += 50;

    if (item.type === 'stock') {
      // Exact-match stocks beat exact-match crypto
      if (exact) s += 40;
      if (isEquityLike(item)) s += 25;
      const qt = String(item.quoteType || '').toUpperCase();
      if (qt === 'ETF' || qt === 'EQUITY') s += 10;
      if (KNOWN_STOCK_TICKERS.has(item.symbol)) s += 50;
    } else if (item.type === 'crypto') {
      if (item.marketCapRank != null) {
        s += Math.max(0, 30 - Math.min(30, item.marketCapRank));
      }
      if (exact && exactStockSymbols.has(item.symbol)) s -= 80;
      if (KNOWN_STOCK_TICKERS.has(item.symbol)) s -= 100;
    }
    return s;
  };

  const merged = [...filteredCrypto, ...stocks].sort(
    (a, b) => score(b) - score(a),
  );

  return { results: merged.slice(0, limit * 2), warnings };
}
