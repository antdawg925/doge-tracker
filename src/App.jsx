import { useCallback, useEffect, useMemo, useState } from 'react';
import Header from './components/Header';
import PriceCard from './components/PriceCard';
import PriceChart from './components/PriceChart';
import SupportResistance from './components/SupportResistance';
import SuggestedStops from './components/SuggestedStops';
import PositionSummary from './components/PositionSummary';
import PositionEditor from './components/PositionEditor';
import Disclaimer from './components/Disclaimer';
import { useDogePrice } from './hooks/useDogePrice';
import { useDogeHistory } from './hooks/useDogeHistory';
import { DEFAULTS, STORAGE_KEY, loadPosition } from './lib/defaults';
import { computeLevels } from './lib/levels';

export default function App() {
  const {
    price,
    change24h,
    loading,
    error,
    warning,
    lastUpdated,
    refresh,
  } = useDogePrice();

  const {
    days,
    setDays,
    bars,
    loading: histLoading,
    error: histError,
    warning: histWarning,
    refresh: refreshHistory,
  } = useDogeHistory(90);

  // Migrate legacy dogeValue → coins at load (uses avgCost; spot optional later)
  const [position, setPosition] = useState(() => loadPosition(null));

  useEffect(() => {
    const toSave = {
      coins: position.coins,
      avgCost: position.avgCost,
      targetPrice: position.targetPrice,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
  }, [position]);

  const onReset = useCallback(() => {
    setPosition({ ...DEFAULTS });
  }, []);

  const onRefreshAll = useCallback(() => {
    refresh();
    refreshHistory();
  }, [refresh, refreshHistory]);

  const levels = useMemo(
    () => computeLevels(bars, price),
    [bars, price],
  );

  return (
    <div className="app">
      <Header
        lastUpdated={lastUpdated}
        loading={loading}
        error={error}
        warning={warning}
        onRefresh={onRefreshAll}
      />

      <main className="layout">
        <div className="layout__primary">
          <PriceCard
            price={price}
            change24h={change24h}
            loading={loading}
            error={error}
            warning={warning}
          />
          <PositionSummary position={position} spot={price} />
          <PriceChart
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
          <SupportResistance
            levels={levels}
            spot={price}
            position={position}
          />
        </div>
        <aside className="layout__side">
          <PositionEditor
            position={position}
            spot={price}
            onChange={setPosition}
            onReset={onReset}
          />
        </aside>
      </main>

      <Disclaimer />
    </div>
  );
}
