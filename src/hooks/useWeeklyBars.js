import { useEffect, useMemo, useState } from 'react';
import { assetKey } from '../lib/assets';
import { fetchKrakenDailyBars, krakenPairFor } from '../lib/history.js';
import { fetchYahooChart } from '../lib/yahoo.js';
import { toPeriod } from '../lib/majorLevels.js';

/**
 * Multi-year weekly candles for the major levels: stocks Yahoo 10y × 1wk, crypto Kraken 1w
 * (back to listing). Falls back to the long daily history rolled up into weeks.
 */
const mem = new Map();
export function useWeeklyBars(asset, longBars) {
  const key = assetKey(asset);
  const [state, setState] = useState(() => ({ key, bars: mem.get(key) || null }));
  useEffect(() => {
    if (!asset) return undefined;
    if (mem.has(key)) return undefined;
    const ac = new AbortController();
    const run = async () => {
      if (asset.type === 'stock') {
        const { bars } = await fetchYahooChart(asset.symbol, '10y', { signal: ac.signal, interval: '1wk' });
        return bars;
      }
      const pair = krakenPairFor(asset);
      if (!pair) return null;
      return fetchKrakenDailyBars(pair, 5000, ac.signal, 10080);
    };
    run()
      .then((bars) => {
        if (bars?.length >= 20) {
          mem.set(key, bars);
          setState({ key, bars });
        }
      })
      .catch(() => {});
    return () => ac.abort();
  }, [asset, key]);
  const fetched = state.key === key ? state.bars || mem.get(key) : mem.get(key);
  const rolled = useMemo(() => (longBars?.length ? toPeriod(longBars, 'week') : null), [longBars]);
  return fetched?.length ? { bars: fetched, source: 'weekly' } : { bars: rolled, source: 'daily→weekly' };
}
