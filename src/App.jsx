import { useCallback, useEffect, useMemo, useState } from 'react';
import Header from './components/Header';
import SymbolSearch from './components/SymbolSearch';
import PriceCard from './components/PriceCard';
import PriceChart from './components/PriceChart';
import SupportPanel from './components/SupportPanel';
import ResistancePanel from './components/ResistancePanel';
import SuggestedStops from './components/SuggestedStops';
import PositionSummary from './components/PositionSummary';
import PositionEditor from './components/PositionEditor';
import Disclaimer from './components/Disclaimer';
import { useAssetPrice } from './hooks/useAssetPrice';
import { useAssetHistory } from './hooks/useAssetHistory';
import { useLongHistory } from './hooks/useLongHistory';
import {
  defaultPositionFor,
  loadAppState,
  positionFor,
  saveAppState,
} from './lib/defaults';
import { assetKey } from './lib/assets';
import { computeLevels } from './lib/levels';

export default function App() {
  const [appState, setAppState] = useState(() => loadAppState());
  const asset = appState.selected;
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
    days,
    setDays,
    bars,
    loading: histLoading,
    error: histError,
    warning: histWarning,
    refresh: refreshHistory,
  } = useAssetHistory(asset, 90);

  const {
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
      const value = typeof next === 'function'
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
      const positions = { ...prev.positions };
      if (!positions[key]) {
        positions[key] = defaultPositionFor(nextAsset);
      }
      return { selected: nextAsset, positions };
    });
  }, []);

  const onReset = useCallback(() => {
    setPosition(defaultPositionFor(asset));
  }, [asset, setPosition]);

  const onRefreshAll = useCallback(() => {
    refresh();
    refreshHistory();
    refreshLong();
  }, [refresh, refreshHistory, refreshLong]);

  const levels = useMemo(
    () => computeLevels(bars, price),
    [bars, price],
  );

  return (
    <div className="app">
      <Header
        asset={asset}
        lastUpdated={lastUpdated}
        loading={loading}
        error={error}
        warning={warning}
        onRefresh={onRefreshAll}
      />

      <SymbolSearch asset={asset} onSelect={onSelectAsset} />

      <main className="layout">
        <div className="layout__primary">
          <PriceCard
            asset={asset}
            price={price}
            change24h={change24h}
            loading={loading}
            error={error}
            warning={warning}
            source={source}
          />
          <PositionSummary position={position} spot={price} asset={asset} />
          <PriceChart
            asset={asset}
            bars={bars}
            levels={levels}
            days={days}
            onDaysChange={setDays}
            loading={histLoading}
            error={histError}
            warning={histWarning}
            spot={price}
          />
          <SuggestedStops
            levels={levels}
            spot={price}
            position={position}
          />
          <SupportPanel
            levels={levels}
            spot={price}
            position={position}
            asset={asset}
          />
          <ResistancePanel
            tfSets={tfSets}
            spot={price}
            position={position}
            asset={asset}
            loading={longLoading}
            error={longError}
            warning={longWarning}
          />
        </div>
        <aside className="layout__side">
          <PositionEditor
            position={position}
            spot={price}
            asset={asset}
            onChange={setPosition}
            onReset={onReset}
          />
        </aside>
      </main>

      <Disclaimer />
    </div>
  );
}
