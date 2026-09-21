import { useCallback, useEffect, useRef, useState } from 'react';
import { assetKey } from '../lib/assets';
import {
  loadJsonCache,
  saveJsonCache,
} from '../lib/coingecko';
import { fetchSpot } from '../lib/price';

const PRICE_CACHE_KEY = 'doge-tracker-price-cache-v2';

const POLL_NORMAL_MS = 60_000;
const POLL_SLOW_MS = 120_000;

function readCachedPrice(key) {
  const all = loadJsonCache(PRICE_CACHE_KEY) || {};
  return all[key] || null;
}

function writeCachedPrice(key, value) {
  const all = loadJsonCache(PRICE_CACHE_KEY) || {};
  all[key] = value;
  saveJsonCache(PRICE_CACHE_KEY, all);
}

export function useAssetPrice(asset) {
  const key = assetKey(asset);
  const initial = readCachedPrice(key);
  const [price, setPrice] = useState(initial?.price ?? null);
  const [change24h, setChange24h] = useState(initial?.change24h ?? null);
  const [source, setSource] = useState(initial?.source ?? null);
  const [loading, setLoading] = useState(initial?.price == null);
  const [error, setError] = useState(null);
  const [warning, setWarning] = useState(
    initial?.price != null ? 'Showing cached spot until live refresh' : null,
  );
  const [lastUpdated, setLastUpdated] = useState(initial?.fetchedAt ?? null);
  const [rateLimited, setRateLimited] = useState(false);

  const abortRef = useRef(null);
  const priceRef = useRef(price);
  const pollRef = useRef(null);
  const rateLimitedRef = useRef(false);
  const fetchPriceRef = useRef(async () => {});
  const assetRef = useRef(asset);
  const keyRef = useRef(key);

  useEffect(() => {
    priceRef.current = price;
  }, [price]);

  useEffect(() => {
    assetRef.current = asset;
    keyRef.current = key;
  }, [asset, key]);

  // Reset visible state when asset changes (show that symbol's cache)
  useEffect(() => {
    const cached = readCachedPrice(key);
    setPrice(cached?.price ?? null);
    setChange24h(cached?.change24h ?? null);
    setSource(cached?.source ?? null);
    setLastUpdated(cached?.fetchedAt ?? null);
    setError(null);
    setWarning(
      cached?.price != null ? 'Showing cached spot until live refresh' : null,
    );
    setLoading(cached?.price == null);
    rateLimitedRef.current = false;
    setRateLimited(false);
  }, [key]);

  const armPoll = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    const ms = rateLimitedRef.current ? POLL_SLOW_MS : POLL_NORMAL_MS;
    pollRef.current = setInterval(() => {
      fetchPriceRef.current();
    }, ms);
  }, []);

  const fetchPrice = useCallback(async () => {
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const currentKey = keyRef.current;
    const currentAsset = assetRef.current;

    if (priceRef.current == null) setLoading(true);

    try {
      const spot = await fetchSpot(currentAsset, { signal: controller.signal });
      if (keyRef.current !== currentKey) return;
      const fetchedAt = Date.now();
      setPrice(spot.price);
      setChange24h(spot.change24h);
      setSource(spot.source);
      setLastUpdated(fetchedAt);
      setError(null);
      setWarning(null);
      const wasLimited = rateLimitedRef.current;
      setRateLimited(false);
      rateLimitedRef.current = false;
      writeCachedPrice(currentKey, {
        price: spot.price,
        change24h: spot.change24h,
        source: spot.source,
        fetchedAt,
      });
      setLoading(false);
      if (wasLimited) armPoll();
    } catch (err) {
      if (err?.name === 'AbortError') return;
      if (keyRef.current !== currentKey) return;
      const limited = Boolean(
        err?.rateLimited || /429/.test(err?.message || ''),
      );
      if (limited && !rateLimitedRef.current) {
        setRateLimited(true);
        rateLimitedRef.current = true;
        armPoll();
      }
      if (priceRef.current != null) {
        setWarning(
          limited
            ? 'Rate limited (429) — using last good spot; polling slowed'
            : `Live refresh failed (${err?.message || 'error'}) — using last good spot`,
        );
        setError(null);
      } else {
        setError(err?.message || 'Failed to fetch price');
      }
      setLoading(false);
    }
  }, [armPoll]);

  useEffect(() => {
    fetchPriceRef.current = fetchPrice;
  }, [fetchPrice]);

  useEffect(() => {
    fetchPrice();
    armPoll();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, [fetchPrice, armPoll, key]);

  return {
    price,
    change24h,
    source,
    loading,
    error,
    warning,
    rateLimited,
    lastUpdated,
    refresh: fetchPrice,
  };
}
