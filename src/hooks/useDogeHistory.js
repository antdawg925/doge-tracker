import { useCallback, useEffect, useRef, useState } from 'react';
import {
  HISTORY_CACHE_KEY,
  aggregateMarketChartToDaily,
  fetchCoinGeckoJson,
  loadJsonCache,
  normalizeOhlc,
  saveJsonCache,
} from '../lib/coingecko';

function cacheBucket(days) {
  const all = loadJsonCache(HISTORY_CACHE_KEY) || {};
  return all[String(days)] || null;
}

function writeCache(days, bars, fetchedAt) {
  const all = loadJsonCache(HISTORY_CACHE_KEY) || {};
  all[String(days)] = { bars, fetchedAt };
  saveJsonCache(HISTORY_CACHE_KEY, all);
}

/**
 * Fetch daily bars for the selected lookback.
 *
 * CoinGecko market_chart intervals:
 *   days ≤ 90 → hourly (we aggregate to daily)
 *   days > 90 → daily natively (request 91 when UI asks for 90)
 * Free-tier OHLC for 90d is ~4-day candles — used only as 429/empty fallback.
 */
async function fetchDailyBars(days, signal) {
  const chartDays = days >= 90 ? Math.max(days, 91) : days;
  let lastErr = null;

  try {
    const { data } = await fetchCoinGeckoJson(
      `/coins/dogecoin/market_chart?vs_currency=usd&days=${chartDays}`,
      { signal, maxRetries: 3 },
    );
    const bars = aggregateMarketChartToDaily(data?.prices);
    if (bars.length) return bars.slice(-days);
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    lastErr = err;
  }

  try {
    const { data } = await fetchCoinGeckoJson(
      `/coins/dogecoin/ohlc?vs_currency=usd&days=${days}`,
      { signal, maxRetries: 2 },
    );
    const bars = normalizeOhlc(data);
    if (bars.length) return bars;
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    lastErr = err;
  }

  throw lastErr || new Error('Empty history response');
}

export function useDogeHistory(initialDays = 90) {
  const [days, setDays] = useState(initialDays);
  const initialCache = cacheBucket(initialDays);
  const [bars, setBars] = useState(initialCache?.bars ?? []);
  const [loading, setLoading] = useState(!initialCache?.bars?.length);
  const [error, setError] = useState(null);
  const [warning, setWarning] = useState(
    initialCache?.bars?.length
      ? 'Showing cached daily history until live refresh'
      : null,
  );
  const [lastUpdated, setLastUpdated] = useState(
    initialCache?.fetchedAt ?? null,
  );
  const abortRef = useRef(null);
  const daysRef = useRef(days);

  useEffect(() => {
    daysRef.current = days;
  }, [days]);

  const refresh = useCallback(async (overrideDays) => {
    const d = overrideDays ?? daysRef.current;
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const existing = cacheBucket(d);
    if (!existing?.bars?.length) setLoading(true);

    try {
      const next = await fetchDailyBars(d, controller.signal);
      if (daysRef.current !== d) return;
      setBars(next);
      const fetchedAt = Date.now();
      setLastUpdated(fetchedAt);
      writeCache(d, next, fetchedAt);
      setError(null);
      setWarning(null);
      setLoading(false);
    } catch (err) {
      if (err?.name === 'AbortError') return;
      if (daysRef.current !== d) return;
      const limited = Boolean(
        err?.rateLimited || /429/.test(err?.message || ''),
      );
      const fallback = cacheBucket(d)?.bars;
      if (fallback?.length) {
        setBars(fallback);
        setWarning(
          limited
            ? 'Rate limited (429) — using cached daily history'
            : `History refresh failed (${err?.message || 'error'}) — using cache`,
        );
        setError(null);
      } else {
        setError(err?.message || 'Failed to load DOGE history');
      }
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const hit = cacheBucket(days);
    // Show cache immediately for the newly selected window without blanking
    if (hit?.bars?.length) {
      setBars(hit.bars);
      setLastUpdated(hit.fetchedAt ?? null);
      setWarning('Showing cached daily history until live refresh');
      setError(null);
      setLoading(false);
    }
    refresh(days);
    return () => {
      if (abortRef.current) abortRef.current.abort();
    };
  }, [days, refresh]);

  return {
    days,
    setDays,
    bars,
    loading,
    error,
    warning,
    lastUpdated,
    refresh: () => refresh(days),
  };
}
