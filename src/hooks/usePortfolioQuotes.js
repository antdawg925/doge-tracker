import { useCallback, useEffect, useRef, useState } from 'react';
import { assetKey } from '../lib/assets';
import { loadJsonCache, saveJsonCache } from '../lib/coingecko';
import { fetchSpot } from '../lib/price';

// Same cache + cadence as the Research price card (useAssetPrice).
const PRICE_CACHE_KEY = 'doge-tracker-price-cache-v2';
const POLL_MS = 60_000;
const CONCURRENCY = 3;

function cachedQuotes(assets) {
  const all = loadJsonCache(PRICE_CACHE_KEY) || {};
  const out = {};
  for (const a of assets) {
    const k = assetKey(a);
    if (all[k]?.price != null) out[k] = { ...all[k], cached: true };
  }
  return out;
}

/** Live spot + 24h/day change for a list of assets, keyed by assetKey. */
export function usePortfolioQuotes(assets) {
  const [quotes, setQuotes] = useState(() => cachedQuotes(assets));
  const [updatedAt, setUpdatedAt] = useState(null);
  const [loading, setLoading] = useState(false);
  const assetsRef = useRef(assets);
  const sig = assets.map(assetKey).sort().join('|');

  useEffect(() => {
    assetsRef.current = assets;
  });

  const refresh = useCallback(async () => {
    const list = assetsRef.current;
    if (!list.length) return;
    setLoading(true);
    const queue = [...list];
    const results = {};
    const worker = async () => {
      while (queue.length) {
        const asset = queue.shift();
        const k = assetKey(asset);
        try {
          const spot = await fetchSpot(asset);
          results[k] = {
            price: spot.price,
            change24h: spot.change24h,
            source: spot.source,
            fetchedAt: Date.now(),
          };
        } catch (err) {
          results[k] = { error: err?.message || 'Quote failed' };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker));
    const cache = loadJsonCache(PRICE_CACHE_KEY) || {};
    for (const [k, q] of Object.entries(results)) {
      if (q.price != null) cache[k] = q;
    }
    saveJsonCache(PRICE_CACHE_KEY, cache);
    setQuotes((prev) => {
      const next = { ...prev };
      for (const [k, q] of Object.entries(results)) {
        // Keep the last good quote when a refresh fails.
        next[k] = q.price != null ? q : prev[k] ? { ...prev[k], stale: true } : q;
      }
      return next;
    });
    setUpdatedAt(Date.now());
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!sig) return undefined;
    setQuotes((prev) => ({ ...cachedQuotes(assetsRef.current), ...prev }));
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [sig, refresh]);

  return { quotes, updatedAt, loading, refresh };
}
