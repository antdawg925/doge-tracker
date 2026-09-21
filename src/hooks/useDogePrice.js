import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PRICE_CACHE_KEY,
  fetchCoinGeckoJson,
  loadJsonCache,
  saveJsonCache,
} from '../lib/coingecko';

const PRICE_PATH =
  '/simple/price?ids=dogecoin&vs_currencies=usd&include_24hr_change=true';

const POLL_NORMAL_MS = 60_000;
const POLL_SLOW_MS = 120_000;

function readCachedPrice() {
  const cached = loadJsonCache(PRICE_CACHE_KEY);
  if (cached?.price != null) return cached;
  return null;
}

export function useDogePrice() {
  const initial = readCachedPrice();
  const [price, setPrice] = useState(initial?.price ?? null);
  const [change24h, setChange24h] = useState(initial?.change24h ?? null);
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

  useEffect(() => {
    priceRef.current = price;
  }, [price]);

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

    if (priceRef.current == null) setLoading(true);

    try {
      const { data } = await fetchCoinGeckoJson(PRICE_PATH, {
        signal: controller.signal,
        maxRetries: 3,
      });
      const doge = data?.dogecoin;
      if (doge?.usd == null) {
        throw new Error('Unexpected API response');
      }
      const fetchedAt = Date.now();
      setPrice(doge.usd);
      setChange24h(
        typeof doge.usd_24h_change === 'number' ? doge.usd_24h_change : null,
      );
      setLastUpdated(fetchedAt);
      setError(null);
      setWarning(null);
      const wasLimited = rateLimitedRef.current;
      setRateLimited(false);
      rateLimitedRef.current = false;
      saveJsonCache(PRICE_CACHE_KEY, {
        price: doge.usd,
        change24h:
          typeof doge.usd_24h_change === 'number'
            ? doge.usd_24h_change
            : null,
        fetchedAt,
      });
      setLoading(false);
      if (wasLimited) armPoll();
    } catch (err) {
      if (err?.name === 'AbortError') return;
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
        setError(err?.message || 'Failed to fetch DOGE price');
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
  }, [fetchPrice, armPoll]);

  return {
    price,
    change24h,
    loading,
    error,
    warning,
    rateLimited,
    lastUpdated,
    refresh: fetchPrice,
  };
}
