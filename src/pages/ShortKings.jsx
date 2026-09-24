import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ENRICH_CONCURRENCY,
  HUNT_ENRICH_TOP_N,
  MIN_VOLUME,
  SHORT_KINGS_WATCHLIST,
  applyHuntProfile,
  enrichShortRows,
  fetchHuntUniverse,
  fetchWatchlistRows,
  loadWatchlist,
  rowToStockAsset,
  saveWatchlist,
} from '../lib/shortKings.js';
import {
  formatNetCash,
  formatRatioPct,
  formatShares,
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
    id: 'my-shorts',
    label: 'My Shorts',
    blurb: 'Seeded watchlist — quotes & short-interest fundamentals.',
  },
  {
    id: 'hunt',
    label: 'Hunt',
    blurb:
      'Liquid names ranked for short research: short % · net cash · RVOL · moves.',
  },
];

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
  if (aNull) return 1;
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
  const ariaSort = !active
    ? 'none'
    : sort.dir === 'asc'
      ? 'ascending'
      : 'descending';
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

function formatDistFromHigh(pctFromHigh) {
  if (pctFromHigh == null || Number.isNaN(pctFromHigh)) return '—';
  // Yahoo ratio: -0.25 → −25.0% from 52w high
  return formatRatioPct(pctFromHigh, 1);
}

export default function ShortKings() {
  const navigate = useNavigate();
  const [tab, setTab] = useState('my-shorts');
  const [watchSymbols, setWatchSymbols] = useState(() => loadWatchlist());
  const [rawRows, setRawRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [enriching, setEnriching] = useState(false);
  const [error, setError] = useState(null);
  const [warnings, setWarnings] = useState([]);
  const [sourceNote, setSourceNote] = useState('');
  const [lastUpdated, setLastUpdated] = useState(null);
  const [tick, setTick] = useState(0);
  const [sort, setSort] = useState({ key: null, dir: 'desc' });
  const [selectedSymbol, setSelectedSymbol] = useState(null);
  const [addDraft, setAddDraft] = useState('');

  const load = useCallback(
    async (signal) => {
      setLoading(true);
      setError(null);
      setEnriching(false);
      try {
        if (tab === 'my-shorts') {
          const result = await fetchWatchlistRows(watchSymbols, { signal });
          if (signal?.aborted) return;
          setRawRows(result.rows || []);
          setWarnings(result.warnings || []);
          setSourceNote(
            `My Shorts · ${SHORT_KINGS_WATCHLIST.length}-name seed (editable below). Stocks only.`,
          );
          setLastUpdated(result.fetchedAt || Date.now());
        } else {
          const result = await fetchHuntUniverse({
            signal,
            excludeSymbols: watchSymbols,
            limit: 75,
          });
          if (signal?.aborted) return;
          setRawRows(result.rows || []);
          setWarnings(result.warnings || []);
          setSourceNote(result.sourceNote || '');
          setLastUpdated(result.fetchedAt || Date.now());
        }
      } catch (err) {
        if (err?.name === 'AbortError') return;
        setRawRows([]);
        setWarnings(err?.warnings || []);
        setError(err?.message || 'Short Kings failed to load');
        setLastUpdated(null);
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [tab, watchSymbols],
  );

  useEffect(() => {
    const ac = new AbortController();
    load(ac.signal);
    return () => ac.abort();
  }, [load, tick]);

  // Enrich top N (all My Shorts; Hunt top N) with concurrency 2
  useEffect(() => {
    if (loading || !rawRows.length) return undefined;
    const ac = new AbortController();
    const base =
      tab === 'hunt'
        ? applyHuntProfile(rawRows, {
            excludeSymbols: watchSymbols,
            bootstrap: true,
            limit: 75,
          })
        : rawRows;

    const limit =
      tab === 'my-shorts'
        ? base.length
        : Math.min(HUNT_ENRICH_TOP_N, base.length);

    setEnriching(true);
    enrichShortRows(base, {
      signal: ac.signal,
      limit,
      concurrency: ENRICH_CONCURRENCY,
      onProgress: (updated) => {
        if (ac.signal.aborted) return;
        const enrichBySym = new Map(
          updated.map((r) => [
            r.symbol,
            {
              sector: r.sector,
              netCash: r.netCash,
              shortPercentOfFloat: r.shortPercentOfFloat,
              floatShares: r.floatShares,
              shortRatio: r.shortRatio,
              pctFromHigh: r.pctFromHigh,
              fundamentalsLoaded: r.fundamentalsLoaded,
              // Prefer fresher name/price from fundamentals merge when present
              name: r.name,
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
  }, [loading, rawRows.length, tab, tick, watchSymbols]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setSort({ key: null, dir: 'desc' });
    setSelectedSymbol(null);
  }, [tab]);

  const onSort = useCallback((key) => {
    setSort((prev) => {
      if (prev.key !== key) return { key, dir: 'desc' };
      return { key, dir: prev.dir === 'desc' ? 'asc' : 'desc' };
    });
  }, []);

  const rows = useMemo(() => {
    const base =
      tab === 'hunt'
        ? applyHuntProfile(rawRows, {
            excludeSymbols: watchSymbols,
            bootstrap: false,
            limit: 75,
          })
        : rawRows;
    if (!sort.key) return base;
    return [...base].sort((a, b) =>
      compareSortValues(a, b, sort.key, sort.dir),
    );
  }, [rawRows, tab, sort, watchSymbols]);

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
      navigate('/home');
    },
    [navigate],
  );

  const removeSymbol = useCallback((sym) => {
    setWatchSymbols((prev) => {
      const next = prev.filter((s) => s !== sym);
      saveWatchlist(next.length ? next : [...SHORT_KINGS_WATCHLIST]);
      return next.length ? next : [...SHORT_KINGS_WATCHLIST];
    });
    setTick((n) => n + 1);
  }, []);

  const addSymbol = useCallback(() => {
    const sym = String(addDraft || '')
      .toUpperCase()
      .trim()
      .replace(/[^A-Z0-9.-]/g, '');
    if (!sym) return;
    setWatchSymbols((prev) => {
      if (prev.includes(sym)) return prev;
      const next = [...prev, sym];
      saveWatchlist(next);
      return next;
    });
    setAddDraft('');
    setTick((n) => n + 1);
  }, [addDraft]);

  const resetWatchlist = useCallback(() => {
    const seed = [...SHORT_KINGS_WATCHLIST];
    saveWatchlist(seed);
    setWatchSymbols(seed);
    setTick((n) => n + 1);
  }, []);

  const activeTab = TABS.find((t) => t.id === tab) || TABS[0];

  return (
    <main className="scanner short-kings">
      <div className="scanner__header card">
        <div className="scanner__title-row">
          <div>
            <p className="scanner__kicker muted">Short Kings</p>
            <h1>Short Kings</h1>
            <p className="scanner__subtitle muted">
              Float &amp; short-interest research — not trade advice.
            </p>
            <p className="scanner__subtitle muted">{activeTab.blurb}</p>
          </div>
          <div className="scanner__controls">
            <button
              type="button"
              className="btn"
              disabled={loading}
              onClick={() => setTick((n) => n + 1)}
            >
              {loading ? 'Loading…' : 'Refresh'}
            </button>
            <p className="scanner__updated muted">
              Updated {formatTime(lastUpdated)}
              {enriching ? ' · fundamentals…' : ''}
            </p>
          </div>
        </div>

        <div
          className="scanner__tabs"
          role="tablist"
          aria-label="Short Kings mode"
        >
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
          Floor: prefer{' '}
          <strong>~{MIN_VOLUME.toLocaleString('en-US')}+</strong> average daily
          volume on Hunt. Stocks only — no crypto. No squeeze scores or “short
          this” calls — just the numbers.
        </p>
        {sourceNote ? (
          <p className="scanner__source muted">{sourceNote}</p>
        ) : null}

        {tab === 'my-shorts' ? (
          <div className="short-kings__watch-edit">
            <form
              className="short-kings__add"
              onSubmit={(e) => {
                e.preventDefault();
                addSymbol();
              }}
            >
              <label className="sr-only" htmlFor="sk-add">
                Add symbol
              </label>
              <input
                id="sk-add"
                className="short-kings__input"
                value={addDraft}
                onChange={(e) => setAddDraft(e.target.value)}
                placeholder="Add ticker"
                maxLength={12}
                autoComplete="off"
                spellCheck={false}
              />
              <button type="submit" className="btn btn--ghost">
                Add
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={resetWatchlist}
              >
                Reset seed
              </button>
            </form>
          </div>
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
            <p className="scanner__state muted">
              {tab === 'my-shorts'
                ? 'Loading My Shorts quotes…'
                : 'Hunting liquid short research candidates…'}
            </p>
          ) : null}

          {!loading && !error && !rows.length ? (
            <p className="scanner__state muted">
              No rows to show. Try Refresh (Yahoo may be rate-limiting).
            </p>
          ) : null}

          {rows.length > 0 ? (
            <div className="scanner__scroll">
              <table className="scanner-table">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <SortTh
                      id="price"
                      label="Price"
                      sort={sort}
                      onSort={onSort}
                    />
                    <SortTh
                      id="changePct"
                      label="Change %"
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
                      id="volume"
                      label="Volume"
                      sort={sort}
                      onSort={onSort}
                    />
                    <SortTh
                      id="floatShares"
                      label="Float"
                      sort={sort}
                      onSort={onSort}
                    />
                    <SortTh
                      id="shortPercentOfFloat"
                      label="Short %"
                      sort={sort}
                      onSort={onSort}
                    />
                    <SortTh
                      id="shortRatio"
                      label="Days to cover"
                      sort={sort}
                      onSort={onSort}
                    />
                    <SortTh
                      id="netCash"
                      label="Net"
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
                    <SortTh
                      id="pctFromHigh"
                      label="Dist 52w hi"
                      sort={sort}
                      onSort={onSort}
                    />
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
                        <td className="sym" title={row.name}>
                          {row.symbol}
                        </td>
                        <td className="num mono">{formatPrice(row.price)}</td>
                        <td className={`num mono ${chClass}`}>
                          {formatPct(ch)}
                        </td>
                        <td className="num mono">
                          {row.relVolume != null &&
                          Number.isFinite(row.relVolume)
                            ? `${row.relVolume.toFixed(2)}x`
                            : '—'}
                        </td>
                        <td className="num mono">
                          {formatVolume(row.volume)}
                        </td>
                        <td className="num mono">
                          {cellOrEllipsis(
                            loaded,
                            row.floatShares != null
                              ? formatShares(row.floatShares)
                              : '—',
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
                          {cellOrEllipsis(
                            loaded,
                            row.shortRatio != null &&
                              Number.isFinite(row.shortRatio)
                              ? row.shortRatio.toFixed(2)
                              : '—',
                          )}
                        </td>
                        <td className="num mono">
                          {cellOrEllipsis(
                            loaded,
                            row.netCash != null
                              ? formatNetCash(row.netCash)
                              : '—',
                          )}
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
                            formatDistFromHigh(row.pctFromHigh),
                          )}
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
                          {tab === 'my-shorts' ? (
                            <button
                              type="button"
                              className="btn btn--ghost short-kings__remove"
                              title={`Remove ${row.symbol}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                removeSymbol(row.symbol);
                              }}
                            >
                              ✕
                            </button>
                          ) : null}
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
              Showing {rows.length}{' '}
              {tab === 'my-shorts' ? 'watchlist' : 'Hunt'} equities · click a
              row to preview · <strong>Open</strong> loads Desk
              {tab === 'hunt'
                ? ' · Default order: short % ↓ · net cash ↑ (debt first) · RVOL ↓ · |% move| ↓ · My Shorts excluded'
                : ' · Fundamentals fill via quoteSummary (concurrency-limited)'}
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
