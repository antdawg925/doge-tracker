import { useEffect, useState } from 'react';
import {
  fetchStockFundamentals,
  getCachedFundamentals,
} from '../lib/fundamentals.js';

/**
 * Load fundamentals for a stock symbol. Crypto / missing → data null, no fetch.
 */
export function useStockFundamentals(asset) {
  const isStock = asset?.type === 'stock' && asset?.symbol;
  const symbol = isStock ? String(asset.symbol).toUpperCase() : null;

  const [data, setData] = useState(() =>
    symbol ? getCachedFundamentals(symbol) : null,
  );
  const [loading, setLoading] = useState(Boolean(symbol && !getCachedFundamentals(symbol)));
  const [warning, setWarning] = useState(null);

  useEffect(() => {
    if (!symbol) {
      setData(null);
      setLoading(false);
      setWarning(null);
      return undefined;
    }

    const cached = getCachedFundamentals(symbol);
    if (cached) {
      setData(cached);
      setWarning(cached.warning || null);
      setLoading(false);
    } else {
      setLoading(true);
    }

    const ac = new AbortController();
    fetchStockFundamentals(symbol, { signal: ac.signal })
      .then((result) => {
        if (ac.signal.aborted) return;
        setData(result);
        setWarning(result?.warning || null);
      })
      .catch((err) => {
        if (err?.name === 'AbortError') return;
        setData(null);
        setWarning(err?.message || 'Fundamentals unavailable');
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });

    return () => ac.abort();
  }, [symbol]);

  return { data, loading, warning, symbol, isStock: Boolean(isStock) };
}
