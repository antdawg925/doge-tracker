import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { assetKey } from '../lib/assets';
import {
  loadJsonCache,
  saveJsonCache,
} from '../lib/coingecko.js';
import {
  buildTfBarSets,
  fetchLongDailyBars,
  formatHistoryError,
} from '../lib/history.js';

const LONG_CACHE_KEY = 'doge-tracker-long-history-v1';

function cacheBucket(aKey) {
  const all = loadJsonCache(LONG_CACHE_KEY) || {};
  return all[aKey] || null;
}

function writeCache(aKey, payload) {
  const all = loadJsonCache(LONG_CACHE_KEY) || {};
  all[aKey] = payload;
  saveJsonCache(LONG_CACHE_KEY, all);
}

/**
 * Long daily history for multi-TF resistance (independent of chart 30/90 window).
 */
export function useLongHistory(asset) {
  const key = assetKey(asset);
  const initial = cacheBucket(key);
  const [bars, setBars] = useState(initial?.bars ?? []);
  const [spanMeta, setSpanMeta] = useState(initial?.spanMeta ?? null);
  const [source, setSource] = useState(initial?.source ?? null);
  const [actualDays, setActualDays] = useState(initial?.actualDays ?? null);
  const [loading, setLoading] = useState(!initial?.bars?.length);
  const [error, setError] = useState(null);
  const [warning, setWarning] = useState(
    initial?.bars?.length
      ? 'Showing cached long history until live refresh'
      : null,
  );
  const [lastUpdated, setLastUpdated] = useState(initial?.fetchedAt ?? null);
  const abortRef = useRef(null);
  const assetRef = useRef(asset);
  const keyRef = useRef(key);

  useEffect(() => {
    assetRef.current = asset;
    keyRef.current = key;
  }, [asset, key]);

  const refresh = useCallback(async () => {
    const currentAsset = assetRef.current;
    const currentKey = keyRef.current;
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const existing = cacheBucket(currentKey);
    if (!existing?.bars?.length) setLoading(true);

    try {
      const result = await fetchLongDailyBars(currentAsset, controller.signal);
      if (keyRef.current !== currentKey) return;
      setBars(result.bars);
      setSpanMeta(result.spanMeta);
      setSource(result.source);
      setActualDays(result.actualDays);
      const fetchedAt = Date.now();
      setLastUpdated(fetchedAt);
      writeCache(currentKey, {
        bars: result.bars,
        spanMeta: result.spanMeta,
        source: result.source,
        actualDays: result.actualDays,
        fetchedAt,
        warning: result.warning ?? null,
      });
      setError(null);
      setWarning(result.warning ?? null);
      setLoading(false);
    } catch (err) {
      if (err?.name === 'AbortError') return;
      if (keyRef.current !== currentKey) return;
      const limited = Boolean(
        err?.rateLimited || /429/.test(err?.message || ''),
      );
      const fallback = cacheBucket(currentKey);
      if (fallback?.bars?.length) {
        setBars(fallback.bars);
        setSpanMeta(fallback.spanMeta ?? null);
        setSource(fallback.source ?? null);
        setActualDays(fallback.actualDays ?? null);
        setWarning(
          limited
            ? 'Rate limited (429) — using cached long history'
            : `Long history refresh failed (${formatHistoryError(err)}) — using cache`,
        );
        setError(null);
      } else {
        setError(formatHistoryError(err));
        setBars([]);
        setSpanMeta(null);
      }
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const hit = cacheBucket(key);
    if (hit?.bars?.length) {
      setBars(hit.bars);
      setSpanMeta(hit.spanMeta ?? null);
      setSource(hit.source ?? null);
      setActualDays(hit.actualDays ?? null);
      setLastUpdated(hit.fetchedAt ?? null);
      setWarning('Showing cached long history until live refresh');
      setError(null);
      setLoading(false);
    } else {
      setBars([]);
      setSpanMeta(null);
      setLoading(true);
      setError(null);
      setWarning(null);
    }
    refresh();
    return () => {
      if (abortRef.current) abortRef.current.abort();
    };
  }, [key, refresh]);

  const tfSets = useMemo(
    () => buildTfBarSets(bars, spanMeta),
    [bars, spanMeta],
  );

  return {
    bars,
    tfSets,
    spanMeta,
    source,
    actualDays,
    loading,
    error,
    warning,
    lastUpdated,
    refresh,
  };
}
