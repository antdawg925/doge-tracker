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
  enrichScannerRows,
  formatNetCash,
  formatRatioPct,
} from '../lib/fundamentals.js';
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
import ScannerPreview from '../components/ScannerPreview.jsx';

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

/** How many top rows get quoteSummary enrichment (rate-limit friendly). */
const ENRICH_TOP_N = 35;
const ENRICH_CONCURRENCY = 2;

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

function compareSortValues(a, b, field, dir) {
  const av = a?.[field];
  const bv = b?.[field];
  const aNull =
    av == null ||
    av === '' ||
    (typeof av === 'number' && Number.isNaN(av));
  const bNull =
    bv == null ||
    bv === '' ||
    (typeof bv === 'number' && Number.isNaN(bv));
  if (aNull && bNull) return 0;
  if (aNull) return 1; // nulls last
  if (bNull) return -1;
  if (typeof av === 'string' || typeof bv === 'string') {
    const cmp = String(av).localeCompare(String(bv), undefined, {
      sensitivity: 'base',
    });
    if (cmp === 0) {
      return String(a.symbol || '').localeCompare(String(b.symbol || ''));
    }
    return dir === 'asc' ? cmp : -cmp;
  }
  if (av === bv) {
    return String(a.symbol || '').localeCompare(String(b.symbol || ''));
  }
  const mul = dir === 'asc' ? 1 : -1;
  return av < bv ? -1 * mul : 1 * mul;
}

function SortTh({ id, label, sort, onSort, className = '' }) {
  const active = sort.key === id;
  const ariaSort = !active ? 'none' : sort.dir === 'asc' ? 'ascending' : 'descending';
  const marker = !active ? '' : sort.dir === 'asc' ? ' ↑' : ' ↓';
  return (
    <th className={`num sortable ${className}`.trim()} aria-sort={ariaSort}>
      <button
        type="button"
        className={`scanner-table__sort${active ? ' is-active' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          onSort(id);
        }}
      >
        {label}
        <span className="scanner-table__sort-ind" aria-hidden>
          {marker || ' ↕'}
        </span>
      </button>
    </th>
  );
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

function cellOrEllipsis(loaded, formatted) {
  if (formatted != null && formatted !== '—') return formatted;
  if (!loaded) return '…';
  return '—';
}

export default function Scanner() {
  const navigate = useNavigate();
  const [tab, setTab] = useState('momentum');
  const [rawRows, setRawRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [enriching, setEnriching] = useState(false);
  const [error, setError] = useState(null);
  const [warnings, setWarnings] = useState([]);
  const [sourceNote, setSourceNote] = useState('');
  const [lastUpdated, setLastUpdated] = useState(null);
  const [tick, setTick] = useState(0);
  // null key = lane default order; first click = desc (highest), second = asc (lowest)
  const [sort, setSort] = useState({ key: null, dir: 'desc' });
  const [selectedSymbol, setSelectedSymbol] = useState(null);

  const load = useCallback(async (signal) => {
    setLoading(true);
    setError(null);
    setEnriching(false);
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

  // After screener rows land, enrich top N of the *current lane order* gently.
  // Re-runs when tab changes so Investable top-N also fills.
  useEffect(() => {
    if (loading || !rawRows.length) return undefined;
    const ac = new AbortController();
    const base =
      tab === 'investable'
        ? applyInvestableProfile(rawRows)
        : applyMomentumProfile(rawRows);

    setEnriching(true);
    enrichScannerRows(base, {
      signal: ac.signal,
      limit: ENRICH_TOP_N,
      concurrency: ENRICH_CONCURRENCY,
      onProgress: (updatedLane) => {
        if (ac.signal.aborted) return;
        // Merge enriched fields back into rawRows by symbol
        const enrichBySym = new Map(
          updatedLane.map((r) => [
            r.symbol,
            {
              sector: r.sector,
              netCash: r.netCash,
              shortPercentOfFloat: r.shortPercentOfFloat,
              floatShares: r.floatShares,
              shortRatio: r.shortRatio,
              pctFromHigh: r.pctFromHigh,
              fundamentalsLoaded: r.fundamentalsLoaded,
            },
          ]),
        );
        setRawRows((prev) =>
          prev.map((r) => {
            const extra = enrichBySym.get(r.symbol);
            return extra ? { ...r, ...extra } : r;
          }),
        );
      },
    })
      .catch((err) => {
        if (err?.name === 'AbortError') return;
      })
      .finally(() => {
        if (!ac.signal.aborted) setEnriching(false);
      });

    return () => ac.abort();
  }, [loading, rawRows.length, tab, tick]); // eslint-like: length+tab+tick gates re-enrich

  // Fresh lane → restore profile default until the user picks a column
  useEffect(() => {
    setSort({ key: null, dir: 'desc' });
  }, [tab]);

  const onSort = useCallback((key) => {
    setSort((prev) => {
      if (prev.key !== key) return { key, dir: 'desc' };
      return { key, dir: prev.dir === 'desc' ? 'asc' : 'desc' };
    });
  }, []);

  const rows = useMemo(() => {
    const base =
      tab === 'investable'
        ? applyInvestableProfile(rawRows)
        : applyMomentumProfile(rawRows);
    if (!sort.key) return base;
    return [...base].sort((a, b) =>
      compareSortValues(a, b, sort.key, sort.dir),
    );
  }, [rawRows, tab, sort]);

  // Keep selection if still in the filtered list; otherwise clear
  useEffect(() => {
    if (!selectedSymbol) return;
    if (!rows.some((r) => r.symbol === selectedSymbol)) {
      setSelectedSymbol(null);
    }
  }, [rows, selectedSymbol]);

  const selectedRow = useMemo(
    () => rows.find((r) => r.symbol === selectedSymbol) || null,
    [rows, selectedSymbol],
  );

  const onSelect = useCallback((row) => {
    setSelectedSymbol(row.symbol);
  }, []);

  const onOpen = useCallback(
    (row) => {
      openOnDesk(row);
      navigate('/research');
    },
    [navigate],
  );

  const activeTab = TABS.find((t) => t.id === tab) || TABS[0];

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
              {enriching ? ' · fundamentals…' : ''}
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

      <div className="scanner__body">
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
                    <SortTh id="price" label="Price" sort={sort} onSort={onSort} />
                    <SortTh
                      id="changePct"
                      label="Change %"
                      sort={sort}
                      onSort={onSort}
                    />
                    <SortTh id="volume" label="Volume" sort={sort} onSort={onSort} />
                    <SortTh
                      id="avgVolume"
                      label="Avg Vol"
                      sort={sort}
                      onSort={onSort}
                    />
                    <SortTh
                      id="relVolume"
                      label="RVOL"
                      sort={sort}
                      onSort={onSort}
                    />
                    <SortTh
                      id="sector"
                      label="Sector"
                      sort={sort}
                      onSort={onSort}
                      className="scanner-table__sector"
                    />
                    <SortTh id="netCash" label="Net" sort={sort} onSort={onSort} />
                    <SortTh
                      id="shortPercentOfFloat"
                      label="Short %"
                      sort={sort}
                      onSort={onSort}
                    />
                    {tab === 'investable' ? (
                      <SortTh
                        id="marketCap"
                        label="Mkt Cap"
                        sort={sort}
                        onSort={onSort}
                      />
                    ) : (
                      <SortTh
                        id="floatShares"
                        label="Float"
                        sort={sort}
                        onSort={onSort}
                      />
                    )}
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
                    const isSelected = selectedSymbol === row.symbol;
                    const loaded = Boolean(row.fundamentalsLoaded);
                    return (
                      <tr
                        key={row.symbol}
                        tabIndex={0}
                        className={`scanner-table__row${isSelected ? ' is-selected' : ''}`}
                        aria-selected={isSelected}
                        onClick={() => onSelect(row)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onSelect(row);
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
                        <td
                          className="num scanner-table__sector"
                          title={row.sector || undefined}
                        >
                          {cellOrEllipsis(loaded, row.sector || '—')}
                        </td>
                        <td className="num mono">
                          {cellOrEllipsis(
                            loaded,
                            row.netCash != null ? formatNetCash(row.netCash) : '—',
                          )}
                        </td>
                        <td className="num mono">
                          {cellOrEllipsis(
                            loaded,
                            row.shortPercentOfFloat != null
                              ? formatRatioPct(row.shortPercentOfFloat)
                              : '—',
                          )}
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
              Showing {rows.length} liquid equities · click a row to preview ·{' '}
              <strong>Open</strong> loads Research
              {tab === 'momentum'
                ? ' · Float / Sector / Net / Short % show "—" when Yahoo omits them (top rows enrich via quoteSummary, concurrency-limited)'
                : ' · Sorted by market cap / price among volume-gated names · Sector / Net / Short % fill for top rows'}
            </p>
          ) : null}
        </div>

        <ScannerPreview
          row={selectedRow}
          onClose={() => setSelectedSymbol(null)}
        />
      </div>
    </main>
  );
}
