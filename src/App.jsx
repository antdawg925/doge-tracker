import { useCallback, useEffect, useMemo, useState } from 'react';
import Header from './components/Header';
import PriceCard from './components/PriceCard';
import PriceChart from './components/PriceChart';
import SupportResistance from './components/SupportResistance';
import AccountSummary from './components/AccountSummary';
import CoreSleeve from './components/CoreSleeve';
import BuyLadder from './components/BuyLadder';
import VolRules from './components/VolRules';
import PnLScenarios from './components/PnLScenarios';
import PositionEditor from './components/PositionEditor';
import Disclaimer from './components/Disclaimer';
import { useDogePrice } from './hooks/useDogePrice';
import { useDogeHistory } from './hooks/useDogeHistory';
import { DEFAULTS, STORAGE_KEY } from './lib/defaults';
import { computeLevels } from './lib/levels';

function loadPosition() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

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

  const [position, setPosition] = useState(loadPosition);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(position));
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
          <SupportResistance
            levels={levels}
            spot={price}
            position={position}
          />
          <AccountSummary position={position} spot={price} />
          <CoreSleeve position={position} />
          <BuyLadder spot={price} />
          <VolRules spot={price} />
          <PnLScenarios position={position} spot={price} />
        </div>
        <aside className="layout__side">
          <PositionEditor
            position={position}
            onChange={setPosition}
            onReset={onReset}
          />
        </aside>
      </main>

      <Disclaimer />
    </div>
  );
}
