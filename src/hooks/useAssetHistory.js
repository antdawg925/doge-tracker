import { useCallback, useEffect, useRef, useState } from 'react';
import { assetKey } from '../lib/assets';
import {
  loadJsonCache,
  saveJsonCache,
} from '../lib/coingecko.js';
import { fetchDailyBars, formatHistoryError } from '../lib/history.js';

const HISTORY_CACHE_KEY = 'doge-tracker-history-cache-v3';

function cacheBucket(aKey, days) {
  const all = loadJsonCache(HISTORY_CACHE_KEY) || {};
  const byAsset = all[aKey] || {};
  return byAsset[String(days)] || null;
}

function writeCache(aKey, days, bars, fetchedAt, source) {
  const all = loadJsonCache(HISTORY_CACHE_KEY) || {};
  if (!all[aKey]) all[aKey] = {};
  all[aKey][String(days)] = { bars, fetchedAt, source };
  saveJsonCache(HISTORY_CACHE_KEY, all);
}

export function useAssetHistory(asset, initialDays = 90) {
  const key = assetKey(asset);
  const [days, setDays] = useState(initialDays);
  const initialCache = cacheBucket(key, initialDays);
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
  const assetRef = useRef(asset);
  const keyRef = useRef(key);

  useEffect(() => {
    daysRef.current = days;
  }, [days]);

  useEffect(() => {
    assetRef.current = asset;
    keyRef.current = key;
  }, [asset, key]);

  const refresh = useCallback(async (overrideDays) => {
    const d = overrideDays ?? daysRef.current;
    const currentAsset = assetRef.current;
    const currentKey = keyRef.current;
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const existing = cacheBucket(currentKey, d);
    if (!existing?.bars?.length) setLoading(true);

    try {
      const result = await fetchDailyBars(currentAsset, d, controller.signal);
      if (keyRef.current !== currentKey || daysRef.current !== d) return;
      setBars(result.bars);
      const fetchedAt = Date.now();
      setLastUpdated(fetchedAt);
      writeCache(currentKey, d, result.bars, fetchedAt, result.source);
      setError(null);
      setWarning(result.warning ?? null);
      setLoading(false);
    } catch (err) {
      if (err?.name === 'AbortError') return;
      if (keyRef.current !== currentKey || daysRef.current !== d) return;
      const limited = Boolean(
        err?.rateLimited || /429/.test(err?.message || ''),
      );
      const fallback = cacheBucket(currentKey, d)?.bars;
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
        setBars([]);
      }
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const hit = cacheBucket(key, days);
    if (hit?.bars?.length) {
      setBars(hit.bars);
      setLastUpdated(hit.fetchedAt ?? null);
      setWarning('Showing cached daily history until live refresh');
      setError(null);
      setLoading(false);
    } else {
      setBars([]);
      setLoading(true);
      setError(null);
      setWarning(null);
    }
    refresh(days);
    return () => {
      if (abortRef.current) abortRef.current.abort();
    };
  }, [days, refresh, key]);

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
