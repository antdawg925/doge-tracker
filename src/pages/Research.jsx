import { useCallback, useEffect, useMemo, useState } from 'react';
import Header from '../components/Header';
import SymbolSearch from '../components/SymbolSearch';
import StageBox from '../components/StageBox';
import PumpDumpBanner from '../components/PumpDumpBanner';
import KeyStats from '../components/KeyStats';
import ResearchTabs from '../components/ResearchTabs';
import MajorLevelsPanel from '../components/MajorLevelsPanel';
import PriceChart from '../components/PriceChart';
// Old level panels (SupportPanel / ResistancePanel / SuggestedStops) stay in the repo; Research uses MajorLevelsPanel.
import PositionRail from '../components/PositionRail';
import PositionSizeLine from '../components/PositionSizeLine';
import NewsPanel from '../components/NewsPanel';
import FundamentalsPanel from '../components/FundamentalsPanel';
import { useAssetPrice } from '../hooks/useAssetPrice';
import { useAssetHistory } from '../hooks/useAssetHistory';
import { useLongHistory } from '../hooks/useLongHistory';
import { useWeeklyBars } from '../hooks/useWeeklyBars';
import { computeMajorPlan } from '../lib/majorLevels';
import { scoreMarketStage } from '../lib/marketStage';
import { resolveCoins } from '../lib/levels';
import { Link } from 'react-router-dom';
import { loadAppState, positionFor, saveAppState } from '../lib/defaults';
import { useAuth } from '../hooks/authContext.js';
import { useDeskPosition } from '../hooks/useDeskPosition';
import { assetKey, emptyPositionFor } from '../lib/assets';
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
  const { user } = useAuth();
  // Shares + avg cost come from the user's Positions (Supabase); target stays per-browser.
  const desk = useDeskPosition(user?.id ?? null, asset);
  const localTarget = positionFor(appState.positions, asset).targetPrice;
  const position = useMemo(
    () => ({
      coins: desk.holding.coins,
      avgCost: desk.holding.avgCost,
      targetPrice: localTarget,
    }),
    [desk.holding.coins, desk.holding.avgCost, localTarget],
  );

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

  // Selection, watchlist and targets persist per-browser. Holdings live in the DB, so once
  // the one-time import has run (desk.loaded) shares/avg cost are never written locally.
  const deskLoaded = desk.loaded;
  useEffect(() => {
    if (!deskLoaded) return;
    const positions = {};
    for (const [k, v] of Object.entries(appState.positions || {})) {
      positions[k] = { coins: 0, avgCost: 0, targetPrice: v?.targetPrice || 0 };
    }
    saveAppState({ ...appState, positions });
  }, [appState, deskLoaded]);

  const { setHolding } = desk;
  const setPosition = useCallback(
    (next) => {
      const value = typeof next === 'function' ? next(position) : next;
      if (value.coins !== position.coins || value.avgCost !== position.avgCost) {
        setHolding(asset, { coins: value.coins, avgCost: value.avgCost });
      }
      if (value.targetPrice !== position.targetPrice) {
        setAppState((prev) => {
          const key = assetKey(prev.selected);
          return {
            ...prev,
            positions: {
              ...prev.positions,
              [key]: { coins: 0, avgCost: 0, targetPrice: value.targetPrice },
            },
          };
        });
      }
    },
    [asset, position, setHolding],
  );

  const onSelectAsset = useCallback((nextAsset) => {
    setAppState((prev) => {
      const key = assetKey(nextAsset);
      const prevKey = assetKey(prev.selected);
      const positions = { ...prev.positions };
      // New lookup → fresh target; shares / avg cost come from Positions
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

  const weekly = useWeeklyBars(asset, longBars);
  const major = useMemo(() => {
    if (!weekly.bars?.length || !(price > 0)) return null;
    return computeMajorPlan(weekly.bars, price, { coins: resolveCoins(position, price), avgCost: position.avgCost });
  }, [weekly.bars, price, position]);
  const stage = useMemo(() => scoreMarketStage(dailyLevelBars, { assetType: asset?.type }), [dailyLevelBars, asset?.type]);
  const range = useMemo(() => {
    if (!bars?.length) return null;
    let low = Infinity;
    let high = -Infinity;
    for (const b of bars) {
      if (Number.isFinite(b.low)) low = Math.min(low, b.low);
      if (Number.isFinite(b.high)) high = Math.max(high, b.high);
    }
    return Number.isFinite(low) && Number.isFinite(high) ? { low, high } : null;
  }, [bars]);
  const [tab, setTab] = useState(() => {
    try {
      return localStorage.getItem('tsb.research.tab') || 'levels';
    } catch {
      return 'levels';
    }
  });
  const openTab = useCallback((id) => {
    setTab(id);
    try {
      localStorage.setItem('tsb.research.tab', id);
    } catch {
      /* private mode */
    }
    requestAnimationFrame(() => document.querySelector('.rtabs')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }, []);
  const fp = (n) => (n == null ? '—' : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`);
  const tabs = [
    {
      id: 'levels',
      label: 'Levels',
      summary: major ? `stop ${fp(major.holdingStop?.price)} · S ${fp(major.supports[0]?.price)} · R ${fp(major.resistances[0]?.price)}` : '…',
      content: <MajorLevelsPanel major={major} spot={price} position={position} tfSets={tfSets} source={weekly.source} note={weekly.source !== 'weekly' ? longError || longWarning : null} />,
    },
    {
      id: 'momentum',
      label: 'Momentum',
      summary: stage?.ok ? `${stage.stage} · ${stage.label}` : '—',
      content: <StageBox bars={dailyLevelBars} asset={asset} loading={histLoading || longLoading} />,
    },
    {
      id: 'risk',
      label: 'P&D risk',
      summary: pumpDump?.show ? (pumpDump.confidence === 'high' ? 'high' : pumpDump.confidence === 'med' ? 'medium' : 'flagged') : 'none',
      alert: Boolean(pumpDump?.show),
      content: pumpDump?.show ? <PumpDumpBanner assessment={pumpDump} /> : <p className="muted small">No pump-and-dump pattern flagged for this symbol.</p>,
    },
    { id: 'news', label: 'News', summary: '', content: <NewsPanel asset={asset} /> },
    ...(asset?.type === 'stock' ? [{ id: 'fundamentals', label: 'Fundamentals', summary: '', content: <FundamentalsPanel asset={asset} /> }] : []),
  ];

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

      <div className="desk-workspace desk-workspace--research">
        {/* Watchlist UI hidden (data + upsert on symbol select kept). */}
        <main className="desk-main">
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
            major={major}
          />
          <KeyStats
            price={price}
            change24h={change24h}
            source={source ? String(source).charAt(0).toUpperCase() + String(source).slice(1) : null}
            range={range}
            rangeLabel={`${rangeId} range`}
            stage={stage}
            pump={pumpDump}
            onOpen={openTab}
            error={error}
            warning={warning}
          />
          <ResearchTabs tabs={tabs} active={tabs.some((t) => t.id === tab) ? tab : 'levels'} onChange={openTab} />
        </main>

        <aside className="desk-aside desk-aside--rail">
          <PositionRail
            position={position}
            spot={price}
            asset={asset}
            onChange={setPosition}
            loaded={desk.loaded}
            status={desk.status}
            error={desk.error}
            levels={levels}
            tfSets={tfSets}
            major={major}
            headerAction={
              <Link to="/positions" className="btn btn--ghost prail__all">
                All positions
              </Link>
            }
          >
            <PositionSizeLine asset={asset} bars={longBars} spot={price} />
          </PositionRail>
        </aside>
      </div>
    </div>
  );
}
