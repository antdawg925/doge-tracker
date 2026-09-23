import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  MIN_VOLUME,
  applyInvestableProfile,
  applyMomentumProfile,
  fetchScannerUniverse,
  rowToStockAsset,
} from '../lib/scanner.js';
import {
  defaultPositionFor,
  loadAppState,
  saveAppState,
} from '../lib/defaults.js';
import { assetKey, emptyPositionFor } from '../lib/assets.js';
import {
  formatPct,
  formatPrice,
  formatTime,
  formatVolume,
} from '../lib/format.js';

const TABS = [
  {
    id: 'momentum',
    label: 'Momentum',
    blurb: 'High relative volume & stronger % moves — quick-trade lane.',
  },
  {
    id: 'investable',
    label: 'Investable',
    blurb: 'Liquid, larger / more established names — longer-horizon lane.',
  },
];

function formatCap(n) {
  if (n == null || Number.isNaN(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e12) return `$${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(abs / 1e6).toFixed(2)}M`;
  return `$${abs.toFixed(0)}`;
}

function upsertWatchlist(list, asset) {
  const key = assetKey(asset);
  if (list.some((a) => assetKey(a) === key)) return list;
  return [...list, { ...asset }];
}

function openOnDesk(row) {
  const asset = rowToStockAsset(row);
  const prev = loadAppState();
  const key = assetKey(asset);
  const prevKey = assetKey(prev.selected);
  const positions = { ...(prev.positions || {}) };
  if (key !== prevKey) {
    positions[key] = emptyPositionFor(asset);
  } else if (!positions[key]) {
    positions[key] = defaultPositionFor(asset);
  }
  saveAppState({
    selected: asset,
    positions,
    watchlist: upsertWatchlist(prev.watchlist || [], asset),
  });
}

export default function Scanner() {
  const navigate = useNavigate();
  const [tab, setTab] = useState('momentum');
  const [rawRows, setRawRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [warnings, setWarnings] = useState([]);
  const [sourceNote, setSourceNote] = useState('');
  const [lastUpdated, setLastUpdated] = useState(null);
  const [tick, setTick] = useState(0);

  const load = useCallback(async (signal) => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchScannerUniverse(undefined, { signal });
      if (signal?.aborted) return;
      setRawRows(result.rows || []);
      setWarnings(result.warnings || []);
      setSourceNote(result.sourceNote || '');
      setLastUpdated(result.fetchedAt || Date.now());
    } catch (err) {
      if (err?.name === 'AbortError') return;
      setRawRows([]);
      setWarnings(err?.warnings || []);
      setError(err?.message || 'Scanner failed');
      setLastUpdated(null);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    load(ac.signal);
    return () => ac.abort();
  }, [load, tick]);

  const rows = useMemo(() => {
    if (tab === 'investable') return applyInvestableProfile(rawRows);
    return applyMomentumProfile(rawRows);
  }, [rawRows, tab]);

  const onOpen = useCallback(
    (row) => {
      openOnDesk(row);
      navigate('/home');
    },
    [navigate],
  );

  const activeTab = TABS.find((t) => t.id === tab) || TABS[0];
  const extraCol = tab === 'investable' ? 'Mkt Cap' : 'Float';

  return (
    <main className="scanner">
      <div className="scanner__header card">
        <div className="scanner__title-row">
          <div>
            <p className="scanner__kicker muted">Scanner</p>
            <h1>Stock Scanner</h1>
            <p className="scanner__subtitle muted">{activeTab.blurb}</p>
          </div>
          <div className="scanner__controls">
            <button
              type="button"
              className="btn"
              disabled={loading}
              onClick={() => setTick((n) => n + 1)}
            >
              {loading ? 'Scanning…' : 'Refresh'}
            </button>
            <p className="scanner__updated muted">
              Updated {formatTime(lastUpdated)}
            </p>
          </div>
        </div>

        <div className="scanner__tabs" role="tablist" aria-label="Scanner lane">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={`scanner__tab${tab === t.id ? ' is-active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <p className="scanner__note muted">
          Floor: prefer <strong>~{MIN_VOLUME.toLocaleString('en-US')}+</strong>{' '}
          average daily volume (3-month ADV when available; otherwise today&apos;s
          volume). Thin / micro names are filtered out. Stocks only — no crypto.
        </p>
        {sourceNote ? (
          <p className="scanner__source muted">{sourceNote}</p>
        ) : null}
      </div>

      {warnings.length > 0 ? (
        <div className="scanner__banner scanner__banner--warn" role="status">
          {warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
        </div>
      ) : null}

      {error ? (
        <div className="scanner__banner scanner__banner--error" role="alert">
          <p>{error}</p>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => setTick((n) => n + 1)}
          >
            Retry
          </button>
        </div>
      ) : null}

      <div className="scanner__table-wrap card">
        {loading && !rows.length ? (
          <p className="scanner__state muted">Loading liquid names from Yahoo…</p>
        ) : null}

        {!loading && !error && !rows.length ? (
          <p className="scanner__state muted">
            No names passed the volume floor. Try Refresh in a minute (Yahoo may
            be rate-limiting).
          </p>
        ) : null}

        {rows.length > 0 ? (
          <div className="scanner__scroll">
            <table className="scanner-table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Name</th>
                  <th className="num">Price</th>
                  <th className="num">Change %</th>
                  <th className="num">Volume</th>
                  <th className="num">Avg Vol</th>
                  <th className="num">RVOL</th>
                  <th className="num">{extraCol}</th>
                  <th className="action">Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const ch = row.changePct;
                  const chClass =
                    ch == null
                      ? ''
                      : ch > 0
                        ? 'is-pos'
                        : ch < 0
                          ? 'is-neg'
                          : '';
                  return (
                    <tr
                      key={row.symbol}
                      tabIndex={0}
                      className="scanner-table__row"
                      onClick={() => onOpen(row)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onOpen(row);
                        }
                      }}
                    >
                      <td className="sym">{row.symbol}</td>
                      <td className="name" title={row.name}>
                        {row.name}
                      </td>
                      <td className="num mono">{formatPrice(row.price)}</td>
                      <td className={`num mono ${chClass}`}>
                        {formatPct(ch)}
                      </td>
                      <td className="num mono">
                        {formatVolume(row.volume)}
                      </td>
                      <td className="num mono">
                        {formatVolume(row.avgVolume)}
                      </td>
                      <td className="num mono">
                        {row.relVolume != null && Number.isFinite(row.relVolume)
                          ? `${row.relVolume.toFixed(2)}x`
                          : '—'}
                      </td>
                      <td className="num mono">
                        {tab === 'investable'
                          ? formatCap(row.marketCap)
                          : formatVolume(row.floatShares)}
                      </td>
                      <td className="action">
                        <button
                          type="button"
                          className="btn btn--ghost scanner__open"
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpen(row);
                          }}
                        >
                          Open
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}

        {rows.length > 0 ? (
          <p className="scanner__footer muted">
            Showing {rows.length} liquid equities · click a row to open on Desk
            {tab === 'momentum'
              ? ' · Float shows "—" when Yahoo free data omits it (still ranked by RVOL / % change)'
              : ' · Sorted by market cap / price among volume-gated names'}
          </p>
        ) : null}
      </div>
    </main>
  );
}
