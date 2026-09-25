import { useCallback, useEffect, useRef, useState } from 'react';
import { assetKey } from '../lib/assets';
import {
  deletePositionBySymbol,
  importLocalPositionsOnce,
  listPositions,
  rowMatchesAsset,
  upsertPosition,
} from '../lib/positionsStore';

const SAVE_DEBOUNCE_MS = 700;

/**
 * Research rail holding (shares + avg cost) for the selected asset, backed by
 * the user's `positions` rows. Edits apply instantly and save back (debounced).
 *   { holding: { coins, avgCost }, row, loaded, status, error, setHolding }
 */
export function useDeskPosition(userId, asset) {
  const [rows, setRows] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [drafts, setDrafts] = useState({});
  const [status, setStatus] = useState('idle'); // idle | saving | saved | error
  const [error, setError] = useState(null);
  const pendingRef = useRef(null);
  const timerRef = useRef(null);
  const rowsRef = useRef(rows);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  useEffect(() => {
    if (!userId) return undefined;
    let cancelled = false;
    (async () => {
      try {
        await importLocalPositionsOnce(userId);
        const list = await listPositions();
        if (!cancelled) setRows(list);
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Could not load your positions');
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const flush = useCallback(async () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    const job = pendingRef.current;
    pendingRef.current = null;
    if (!job || !userId) return;
    const symbol = String(job.asset.symbol || '').toUpperCase();
    setStatus('saving');
    try {
      if (!(job.coins > 0) && !(job.avgCost > 0)) {
        if (rowsRef.current.some((r) => r.symbol === symbol)) {
          await deletePositionBySymbol(symbol);
          setRows((prev) => prev.filter((r) => r.symbol !== symbol));
        }
      } else {
        const saved = await upsertPosition(userId, job.asset, {
          shares: job.coins,
          avgCost: job.avgCost,
        });
        setRows((prev) => [...prev.filter((r) => r.symbol !== saved.symbol), saved]);
      }
      setError(null);
      setStatus('saved');
    } catch (err) {
      setError(err?.message || 'Save failed');
      setStatus('error');
    }
  }, [userId]);

  // Save anything pending when switching symbols or leaving Research.
  const key = assetKey(asset);
  useEffect(() => () => void flush(), [key, flush]);

  const row = rows.find((r) => rowMatchesAsset(r, asset)) || null;
  const draft = drafts[key];
  const holding = draft || {
    coins: row?.shares ?? 0,
    avgCost: row?.avg_cost ?? 0,
  };

  const setHolding = useCallback(
    (target, next) => {
      const k = assetKey(target);
      const value = {
        coins: Number.isFinite(next.coins) ? next.coins : 0,
        avgCost: Number.isFinite(next.avgCost) ? next.avgCost : 0,
      };
      setDrafts((prev) => ({ ...prev, [k]: value }));
      pendingRef.current = { asset: target, ...value };
      setStatus('pending');
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
    },
    [flush],
  );

  return { holding, row, loaded, status, error, setHolding };
}
