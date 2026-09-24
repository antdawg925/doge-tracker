import { useCallback, useEffect, useRef, useState } from 'react';
import { assetKey } from '../lib/assets';
import {
  loadJsonCache,
  saveJsonCache,
} from '../lib/coingecko.js';
import {
  fetchChartBars,
  formatHistoryError,
  researchRangeById,
} from '../lib/history.js';

const HISTORY_CACHE_KEY = 'doge-tracker-history-cache-v6';

function cacheBucket(aKey, rangeId) {
  const all = loadJsonCache(HISTORY_CACHE_KEY) || {};
  const byAsset = all[aKey] || {};
  return byAsset[String(rangeId)] || null;
}

function writeCache(aKey, rangeId, payload) {
  const all = loadJsonCache(HISTORY_CACHE_KEY) || {};
  if (!all[aKey]) all[aKey] = {};
  all[aKey][String(rangeId)] = payload;
  saveJsonCache(HISTORY_CACHE_KEY, all);
}

/**
 * Chart history for Research lookbacks (5D hourly … 10Y monthly).
 * `initialRangeId` defaults to 90D.
 */
export function useAssetHistory(asset, initialRangeId = '90D') {
  const key = assetKey(asset);
  const [rangeId, setRangeId] = useState(initialRangeId);
  // Free crypto history rarely exceeds ~5y — drop 10Y for crypto
  useEffect(() => {
    if (asset?.type === 'crypto' && rangeId === '10Y') {
      setRangeId('5Y');
    }
  }, [asset?.type, rangeId]);

  const rangeMeta = researchRangeById(rangeId);
  const initialCache = cacheBucket(key, initialRangeId);
  const [bars, setBars] = useState(initialCache?.bars ?? []);
  const [tfLabel, setTfLabel] = useState(
    initialCache?.tfLabel ?? rangeMeta?.tfLabel ?? 'daily',
  );
  const [chartInterval, setChartInterval] = useState(
    initialCache?.interval ?? rangeMeta?.yahooInterval ?? '1d',
  );
  const [loading, setLoading] = useState(!initialCache?.bars?.length);
  const [error, setError] = useState(null);
  const [warning, setWarning] = useState(
    initialCache?.bars?.length
      ? 'Showing cached chart history until live refresh'
      : null,
  );
  const [lastUpdated, setLastUpdated] = useState(
    initialCache?.fetchedAt ?? null,
  );
  const abortRef = useRef(null);
  const rangeRef = useRef(rangeId);
  const assetRef = useRef(asset);
  const keyRef = useRef(key);

  useEffect(() => {
    rangeRef.current = rangeId;
  }, [rangeId]);

  useEffect(() => {
    assetRef.current = asset;
    keyRef.current = key;
  }, [asset, key]);

  const refresh = useCallback(async (overrideRangeId) => {
    const rid = overrideRangeId ?? rangeRef.current;
    const currentAsset = assetRef.current;
    const currentKey = keyRef.current;
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const existing = cacheBucket(currentKey, rid);
    if (!existing?.bars?.length) setLoading(true);

    try {
      const result = await fetchChartBars(currentAsset, rid, controller.signal);
      if (keyRef.current !== currentKey || rangeRef.current !== rid) return;
      setBars(result.bars);
      setTfLabel(result.tfLabel || researchRangeById(rid).tfLabel);
      setChartInterval(result.interval || researchRangeById(rid).yahooInterval);
      const fetchedAt = Date.now();
      setLastUpdated(fetchedAt);
      writeCache(currentKey, rid, {
        bars: result.bars,
        fetchedAt,
        source: result.source,
        tfLabel: result.tfLabel,
        interval: result.interval,
        warning: result.warning ?? null,
      });
      setError(null);
      setWarning(result.warning ?? null);
      setLoading(false);
    } catch (err) {
      if (err?.name === 'AbortError') return;
      if (keyRef.current !== currentKey || rangeRef.current !== rid) return;
      const limited = Boolean(
        err?.rateLimited || /429/.test(err?.message || ''),
      );
      const fallback = cacheBucket(currentKey, rid);
      if (fallback?.bars?.length) {
        setBars(fallback.bars);
        setTfLabel(fallback.tfLabel || researchRangeById(rid).tfLabel);
        setChartInterval(fallback.interval || researchRangeById(rid).yahooInterval);
        setWarning(
          limited
            ? 'Rate limited (429) — using cached chart history'
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
    const hit = cacheBucket(key, rangeId);
    const meta = researchRangeById(rangeId);
    if (hit?.bars?.length) {
      setBars(hit.bars);
      setTfLabel(hit.tfLabel || meta.tfLabel);
      setChartInterval(hit.interval || meta.yahooInterval);
      setLastUpdated(hit.fetchedAt ?? null);
      setWarning('Showing cached chart history until live refresh');
      setError(null);
      setLoading(false);
    } else {
      setBars([]);
      setTfLabel(meta.tfLabel);
      setChartInterval(meta.yahooInterval);
      setLoading(true);
      setError(null);
      setWarning(null);
    }
    refresh(rangeId);
    return () => {
      if (abortRef.current) abortRef.current.abort();
    };
  }, [rangeId, refresh, key]);

  // Backward-compat aliases: days ≈ approx calendar days for the range
  const days = rangeMeta?.approxDays ?? 90;

  return {
    rangeId,
    setRangeId,
    days,
    setDays: (d) => {
      // Map legacy day numbers → nearest Research range
      const n = Number(d);
      if (n <= 7) setRangeId('5D');
      else if (n <= 35) setRangeId('30D');
      else if (n <= 100) setRangeId('90D');
      else if (n <= 400) setRangeId('1Y');
      else if (n <= 2000) setRangeId('5Y');
      else setRangeId('10Y');
    },
    bars,
    tfLabel,
    interval: chartInterval,
    loading,
    error,
    warning,
    lastUpdated,
    refresh: () => refresh(rangeId),
  };
}
