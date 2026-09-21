import { useCallback, useEffect, useRef, useState } from 'react';
import {
  HISTORY_CACHE_KEY,
  loadJsonCache,
  saveJsonCache,
} from '../lib/coingecko.js';
import { fetchDailyBars, formatHistoryError } from '../lib/history.js';

function cacheBucket(days) {
  const all = loadJsonCache(HISTORY_CACHE_KEY) || {};
  return all[String(days)] || null;
}

function writeCache(days, bars, fetchedAt) {
  const all = loadJsonCache(HISTORY_CACHE_KEY) || {};
  all[String(days)] = { bars, fetchedAt };
  saveJsonCache(HISTORY_CACHE_KEY, all);
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
      const result = await fetchDailyBars(d, controller.signal);
      if (daysRef.current !== d) return;
      setBars(result.bars);
      const fetchedAt = Date.now();
      setLastUpdated(fetchedAt);
      writeCache(d, result.bars, fetchedAt);
      setError(null);
      setWarning(result.warning ?? null);
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
            : `History refresh failed (${formatHistoryError(err)}) — using cache`,
        );
        setError(null);
      } else {
        setError(formatHistoryError(err));
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
