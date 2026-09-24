import { useCallback, useEffect, useMemo, useState } from 'react';
import Header from '../components/Header';
import SymbolSearch from '../components/SymbolSearch';
import Watchlist from '../components/Watchlist';
import StageBox from '../components/StageBox';
import PumpDumpBanner from '../components/PumpDumpBanner';
import PriceCard from '../components/PriceCard';
import PriceChart from '../components/PriceChart';
import SupportPanel from '../components/SupportPanel';
import ResistancePanel from '../components/ResistancePanel';
import SuggestedStops from '../components/SuggestedStops';
import PositionSummary from '../components/PositionSummary';
import PositionEditor from '../components/PositionEditor';
import NewsPanel from '../components/NewsPanel';
import FundamentalsPanel from '../components/FundamentalsPanel';
import { useAssetPrice } from '../hooks/useAssetPrice';
import { useAssetHistory } from '../hooks/useAssetHistory';
import { useLongHistory } from '../hooks/useLongHistory';
import {
  defaultPositionFor,
  loadAppState,
  positionFor,
  saveAppState,
} from '../lib/defaults';
import { assetKey, emptyPositionFor } from '../lib/assets';
import { hasEnteredPosition } from '../lib/math';
import { computeLevels } from '../lib/levels';
import { assessPumpDump } from '../lib/pumpDump';
import { sliceBarsLastDays } from '../lib/history';

function upsertWatchlist(list, asset) {
  const key = assetKey(asset);
  if (list.some((a) => assetKey(a) === key)) return list;
  return [...list, { ...asset }];
}

export default function Research() {
  const [appState, setAppState] = useState(() => loadAppState());
  const asset = appState.selected;
  const watchlist = appState.watchlist || [];
  const position = positionFor(appState.positions, asset);

  const {
    price,
    change24h,
    source,
    loading,
    error,
    warning,
    lastUpdated,
    refresh,
  } = useAssetPrice(asset);

  const {
    rangeId,
    setRangeId,
    bars,
    tfLabel,
    loading: histLoading,
    error: histError,
    warning: histWarning,
    refresh: refreshHistory,
  } = useAssetHistory(asset, '90D');

  const {
    bars: longBars,
    tfSets,
    loading: longLoading,
    error: longError,
    warning: longWarning,
    refresh: refreshLong,
  } = useLongHistory(asset);

  useEffect(() => {
    saveAppState(appState);
  }, [appState]);

  const setPosition = useCallback((next) => {
    setAppState((prev) => {
      const key = assetKey(prev.selected);
      const value =
        typeof next === 'function'
          ? next(positionFor(prev.positions, prev.selected))
          : next;
      return {
        ...prev,
        positions: {
          ...prev.positions,
          [key]: value,
        },
      };
    });
  }, []);

  const onSelectAsset = useCallback((nextAsset) => {
    setAppState((prev) => {
      const key = assetKey(nextAsset);
      const prevKey = assetKey(prev.selected);
      const positions = { ...prev.positions };
      // New lookup → clear shares / avg cost / target for a fresh research form
      if (key !== prevKey) {
        positions[key] = emptyPositionFor(nextAsset);
      } else if (!positions[key]) {
        positions[key] = emptyPositionFor(nextAsset);
      }
      const list = Array.isArray(prev.watchlist) ? prev.watchlist : [];
      return {
        selected: nextAsset,
        positions,
        watchlist: upsertWatchlist(list, nextAsset),
      };
    });
  }, []);

  const onAddToWatchlist = useCallback(() => {
    setAppState((prev) => ({
      ...prev,
      watchlist: upsertWatchlist(prev.watchlist || [], prev.selected),
    }));
  }, []);

  const onRemoveFromWatchlist = useCallback((target) => {
    const key = assetKey(target);
    setAppState((prev) => ({
      ...prev,
      watchlist: (prev.watchlist || []).filter((a) => assetKey(a) !== key),
    }));
  }, []);

  const onReset = useCallback(() => {
    setPosition(defaultPositionFor(asset));
  }, [asset, setPosition]);

  const onRefreshAll = useCallback(() => {
    refresh();
    refreshHistory();
    refreshLong();
  }, [refresh, refreshHistory, refreshLong]);

  const pumpDump = useMemo(
    () => assessPumpDump(asset, longBars),
    [asset, longBars],
  );

  // Levels + stage stay on daily history so weekly/monthly chart TF does not break S/R.
  const dailyLevelBars = useMemo(() => {
    if (longBars?.length >= 15) return sliceBarsLastDays(longBars, 90);
    if (tfLabel === 'daily' && bars?.length) return bars;
    return bars || [];
  }, [longBars, bars, tfLabel]);

  const levels = useMemo(
    () => computeLevels(dailyLevelBars, price),
    [dailyLevelBars, price],
  );

  return (
    <div className="desk-body">
      <div className="desk-top">
        <SymbolSearch asset={asset} onSelect={onSelectAsset} />
        <Header
          asset={asset}
          lastUpdated={lastUpdated}
          loading={loading}
          error={error}
          warning={warning}
          onRefresh={onRefreshAll}
        />
      </div>

      <div className="desk-workspace">
        <aside className="desk-sidebar">
          <Watchlist
            items={watchlist}
            selected={asset}
            onSelect={onSelectAsset}
            onAddCurrent={onAddToWatchlist}
            onRemove={onRemoveFromWatchlist}
          />
        </aside>

        <main className="desk-main">
          <PumpDumpBanner assessment={pumpDump} />
          <StageBox
            bars={dailyLevelBars}
            asset={asset}
            loading={histLoading || longLoading}
          />
          <PriceCard
            asset={asset}
            price={price}
            change24h={change24h}
            loading={loading}
            error={error}
            warning={warning}
            source={source}
          />
          <PriceChart
            asset={asset}
            bars={bars}
            levels={levels}
            rangeId={rangeId}
            onRangeChange={setRangeId}
            tfLabel={tfLabel}
            loading={histLoading}
            error={histError}
            warning={histWarning}
            spot={price}
            tfSets={tfSets}
          />
          <NewsPanel asset={asset} />
          <FundamentalsPanel asset={asset} />
          <SuggestedStops
            levels={levels}
            spot={price}
            position={position}
            tfSets={tfSets}
          />
          <SupportPanel
            levels={levels}
            spot={price}
            position={position}
            asset={asset}
            tfSets={tfSets}
          />
          <ResistancePanel
            tfSets={tfSets}
            spot={price}
            position={position}
            asset={asset}
            loading={longLoading}
            error={longError}
            warning={longWarning}
            chartLevels={levels}
          />
        </main>

        <aside className="desk-aside">
          <PositionEditor
            position={position}
            spot={price}
            asset={asset}
            onChange={setPosition}
            onReset={onReset}
          />
          {hasEnteredPosition(position.coins, position.avgCost) ? (
            <PositionSummary position={position} spot={price} asset={asset} />
          ) : null}
        </aside>
      </div>
    </div>
  );
}
