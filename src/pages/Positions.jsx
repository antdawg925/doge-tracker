import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/authContext.js';
import { usePortfolioQuotes } from '../hooks/usePortfolioQuotes';
import { assetKey } from '../lib/assets';
import { openAssetOnDesk } from '../lib/defaults';
import { formatCoins, formatPct, formatPrice, formatUsd } from '../lib/format';
import {
  deletePosition,
  importLocalPositionsOnce,
  listPositions,
  rowMetrics,
  rowToAsset,
  upsertPosition,
} from '../lib/positionsStore';
import { searchSymbols } from '../lib/search';

const tone = (n) => (n == null || n === 0 ? '' : n > 0 ? 'pos' : 'neg');
const fmtShares = (row) =>
  formatCoins(row.shares, Number.isInteger(row.shares) ? 0 : row.asset_type === 'stock' ? 2 : 4);

function SymbolPicker({ value, onPick, autoFocus }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hits, setHits] = useState([]);
  const [note, setNote] = useState(null);
  const [active, setActive] = useState(-1);
  const wrapRef = useRef(null);

  useEffect(() => {
    const onDoc = (e) => {
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  useEffect(() => {
    const term = q.trim();
    if (!term) {
      setHits([]);
      setNote(null);
      return undefined;
    }
    const ctrl = new AbortController();
    setBusy(true);
    const t = setTimeout(async () => {
      try {
        const { results, warnings } = await searchSymbols(term, { signal: ctrl.signal, limit: 6 });
        setHits(results);
        setActive(-1);
        setNote(results.length ? warnings.join(' · ') || null : 'No matches');
        setOpen(true);
      } catch (err) {
        if (err?.name !== 'AbortError') setNote(err?.message || 'Search failed');
      } finally {
        setBusy(false);
      }
    }, 280);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);

  const pick = (item) => {
    onPick({
      symbol: item.symbol,
      name: item.name,
      type: item.type,
      id: item.type === 'crypto' ? item.id : undefined,
    });
    setQ('');
    setHits([]);
    setOpen(false);
  };

  return (
    <div className="symbol-search pos-picker" ref={wrapRef}>
      <label className="field">
        <span>Symbol</span>
        <input
          type="search"
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          placeholder={value ? `${value.symbol} · change…` : 'TSLA, DOGE, BTC…'}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => hits.length && setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && hits.length) {
              e.preventDefault();
              setOpen(true);
              setActive((i) => (i + 1) % hits.length);
            } else if (e.key === 'ArrowUp' && hits.length) {
              e.preventDefault();
              setActive((i) => (i <= 0 ? hits.length - 1 : i - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (active >= 0 && hits[active]) pick(hits[active]);
            } else if (e.key === 'Escape') setOpen(false);
          }}
        />
      </label>
      {open && (hits.length > 0 || note || busy) ? (
        <div className="symbol-search__dropdown" role="listbox">
          {busy ? <div className="symbol-search__status">Searching…</div> : null}
          {!busy && note ? <div className="symbol-search__status">{note}</div> : null}
          <ul className="symbol-search__list">
            {hits.map((item, idx) => (
              <li key={`${item.type}-${item.id || item.symbol}-${idx}`}>
                <button
                  type="button"
                  role="option"
                  aria-selected={idx === active}
                  className={`symbol-search__option${idx === active ? ' is-active' : ''}`}
                  onMouseEnter={() => setActive(idx)}
                  onClick={() => pick(item)}
                >
                  <span className={`chip chip--${item.type}`}>
                    {item.type === 'stock' ? 'Stock' : 'Crypto'}
                  </span>
                  <span className="symbol-search__sym mono">{item.symbol}</span>
                  <span className="symbol-search__opt-name">{item.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function PositionForm({ initial, existingRows, onSave, onCancel }) {
  const editing = Boolean(initial?.id);
  const [asset, setAsset] = useState(initial ? rowToAsset(initial) : null);
  const [shares, setShares] = useState(initial ? String(initial.shares) : '');
  const [avg, setAvg] = useState(initial?.avg_cost != null ? String(initial.avg_cost) : '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const clash = !editing && asset
    ? existingRows.find((r) => r.symbol === String(asset.symbol).toUpperCase())
    : null;

  const onPick = (a) => {
    setAsset(a);
    const row = existingRows.find((r) => r.symbol === String(a.symbol).toUpperCase());
    if (row && !editing) {
      setShares(String(row.shares));
      setAvg(row.avg_cost != null ? String(row.avg_cost) : '');
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    const s = parseFloat(shares);
    const c = avg.trim() === '' ? null : parseFloat(avg);
    if (!asset) return setErr('Pick a symbol.');
    if (!Number.isFinite(s) || s <= 0) return setErr('Enter how many you hold.');
    if (c != null && (!Number.isFinite(c) || c < 0)) return setErr('Average cost must be a number.');
    setSaving(true);
    setErr(null);
    try {
      await onSave(asset, s, c);
    } catch (ex) {
      setErr(ex?.message || 'Save failed');
      setSaving(false);
    }
  };

  return (
    <form className="card pos-form" onSubmit={submit}>
      {editing ? (
        <div className="field">
          <span>Symbol</span>
          <div className="pos-form__sym">
            <span className={`chip chip--${asset.type}`}>{asset.type === 'stock' ? 'Stock' : 'Crypto'}</span>
            <strong className="mono">{asset.symbol}</strong>
          </div>
        </div>
      ) : (
        <div className="pos-form__pick">
          <SymbolPicker value={asset} onPick={onPick} autoFocus />
          {asset ? (
            <span className="pos-form__picked small">
              <span className={`chip chip--${asset.type}`}>{asset.type === 'stock' ? 'Stock' : 'Crypto'}</span>{' '}
              <strong className="mono">{asset.symbol}</strong>{' '}
              <span className="muted">{asset.name}</span>
              {clash ? <span className="muted"> · already held, will update</span> : null}
            </span>
          ) : null}
        </div>
      )}
      <label className="field">
        <span>{asset?.type === 'crypto' ? 'Coins' : 'Shares'}</span>
        <input type="number" step="any" min="0" inputMode="decimal" value={shares} onChange={(e) => setShares(e.target.value)} />
      </label>
      <label className="field">
        <span>Avg cost</span>
        <input type="number" step="any" min="0" inputMode="decimal" placeholder="optional" value={avg} onChange={(e) => setAvg(e.target.value)} />
      </label>
      <div className="pos-form__actions">
        <button type="submit" className="btn btn--primary" disabled={saving}>
          {saving ? 'Saving…' : editing ? 'Save' : 'Add'}
        </button>
        <button type="button" className="btn btn--ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {err ? <p className="pos-form__err neg small">{err}</p> : null}
    </form>
  );
}

function RowActions({ row, confirming, onEdit, onAskDelete, onDelete, onCancelDelete }) {
  if (confirming) {
    return (
      <span className="pos-actions">
        <button type="button" className="btn btn--ghost pos-actions__danger" onClick={() => onDelete(row)}>
          Delete
        </button>
        <button type="button" className="btn btn--ghost" onClick={onCancelDelete}>
          Keep
        </button>
      </span>
    );
  }
  return (
    <span className="pos-actions">
      <button type="button" className="btn btn--ghost" onClick={() => onEdit(row)} aria-label={`Edit ${row.symbol}`}>
        Edit
      </button>
      <button type="button" className="btn btn--ghost pos-actions__x" onClick={() => onAskDelete(row.id)} aria-label={`Delete ${row.symbol}`} title="Delete">
        ×
      </button>
    </span>
  );
}

export default function Positions() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null); // null | { row?: existing }
  const [confirmId, setConfirmId] = useState(null);

  const load = useCallback(async () => {
    try {
      await importLocalPositionsOnce(userId);
      setRows(await listPositions());
      setError(null);
    } catch (err) {
      setError(err?.message || 'Could not load positions');
    } finally {
      setLoaded(true);
    }
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

  const assets = useMemo(() => rows.map(rowToAsset), [rows]);
  const { quotes, updatedAt, loading: quoting, refresh } = usePortfolioQuotes(assets);

  const view = useMemo(() => {
    const list = rows.map((row) => {
      const q = quotes[assetKey(rowToAsset(row))];
      return { row, q, m: rowMetrics(row, q) };
    });
    list.sort((a, b) => (b.m.value ?? -1) - (a.m.value ?? -1) || a.row.symbol.localeCompare(b.row.symbol));
    let value = 0;
    let gain = 0;
    let basis = 0;
    let day = 0;
    let priced = 0;
    for (const { m } of list) {
      if (m.value != null) {
        value += m.value;
        priced += 1;
      }
      if (m.gain != null) {
        gain += m.gain;
        basis += m.basis;
      }
      if (m.dayChange != null) day += m.dayChange;
    }
    const prevValue = value - day;
    return {
      list,
      totals: {
        value: priced ? value : null,
        gain: basis > 0 ? gain : null,
        gainPct: basis > 0 ? (gain / basis) * 100 : null,
        day: priced ? day : null,
        dayPct: priced && prevValue > 0 ? (day / prevValue) * 100 : null,
      },
    };
  }, [rows, quotes]);

  const onSave = async (asset, shares, avgCost) => {
    const saved = await upsertPosition(userId, asset, { shares, avgCost });
    setRows((prev) => [...prev.filter((r) => r.symbol !== saved.symbol), saved]);
    setForm(null);
  };

  const onDelete = async (row) => {
    try {
      await deletePosition(row.id);
      setRows((prev) => prev.filter((r) => r.id !== row.id));
    } catch (err) {
      setError(err?.message || 'Delete failed');
    }
    setConfirmId(null);
  };

  const openResearch = (row) => {
    openAssetOnDesk(rowToAsset(row));
    navigate('/research');
  };

  const { totals } = view;
  const actionProps = {
    onEdit: (row) => {
      setConfirmId(null);
      setForm({ row });
    },
    onAskDelete: setConfirmId,
    onDelete,
    onCancelDelete: () => setConfirmId(null),
  };

  return (
    <main className="scanner positions-page">
      <div className="card pos-head">
        <div className="pos-head__title">
          <h1>Positions</h1>
          <span className="muted small">
            {rows.length} holding{rows.length === 1 ? '' : 's'}
            {updatedAt ? ` · prices ${new Date(updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}
          </span>
        </div>
        <dl className="pos-totals">
          <div>
            <dt>Value</dt>
            <dd className="mono">{formatUsd(totals.value, { decimals: 2 })}</dd>
          </div>
          <div>
            <dt>Gain / loss</dt>
            <dd className={`mono ${tone(totals.gain)}`}>
              {formatUsd(totals.gain, { sign: true, decimals: 2 })}
              {totals.gainPct != null ? <small> {formatPct(totals.gainPct, 1)}</small> : null}
            </dd>
          </div>
          <div>
            <dt>Today</dt>
            <dd className={`mono ${tone(totals.day)}`}>
              {formatUsd(totals.day, { sign: true, decimals: 2 })}
              {totals.dayPct != null ? <small> {formatPct(totals.dayPct, 2)}</small> : null}
            </dd>
          </div>
        </dl>
        <div className="pos-head__actions">
          <button type="button" className="btn btn--ghost" onClick={refresh} disabled={quoting || !rows.length}>
            {quoting ? 'Updating…' : 'Refresh'}
          </button>
          <button type="button" className="btn btn--primary" onClick={() => setForm(form && !form.row ? null : {})}>
            Add position
          </button>
        </div>
      </div>

      {form ? (
        <PositionForm
          key={form.row?.id || 'new'}
          initial={form.row}
          existingRows={rows}
          onSave={onSave}
          onCancel={() => setForm(null)}
        />
      ) : null}

      {error ? <p className="neg small">{error}</p> : null}

      <section className="card pos-list">
        {!loaded ? (
          <p className="muted small">Loading…</p>
        ) : !rows.length ? (
          <div className="pos-empty">
            <p className="muted">No positions yet.</p>
            <button type="button" className="btn btn--primary" onClick={() => setForm({})}>
              Add your first holding
            </button>
          </div>
        ) : (
          <>
            <table className="pos-table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th className="num">Shares</th>
                  <th className="num">Avg cost</th>
                  <th className="num">Price</th>
                  <th className="num">Day</th>
                  <th className="num">Value</th>
                  <th className="num">Gain / loss</th>
                  <th className="num">%</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {view.list.map(({ row, q, m }) => (
                  <tr key={row.id}>
                    <td>
                      <button type="button" className="pos-sym" onClick={() => openResearch(row)} title={`Open ${row.symbol} in Research`}>
                        <strong className="mono">{row.symbol}</strong>
                        <span className={`chip chip--${row.asset_type}`}>{row.asset_type === 'stock' ? 'Stock' : 'Crypto'}</span>
                      </button>
                    </td>
                    <td className="num mono">{fmtShares(row)}</td>
                    <td className="num mono">{row.avg_cost != null ? formatPrice(row.avg_cost) : <span className="muted">—</span>}</td>
                    <td className={`num mono${q?.stale ? ' muted' : ''}`} title={q?.error || undefined}>
                      {m.price != null ? formatPrice(m.price) : q?.error ? '—' : '…'}
                    </td>
                    <td className={`num mono ${tone(m.pct)}`}>{formatPct(m.pct, 2)}</td>
                    <td className="num mono">{formatUsd(m.value, { decimals: 2 })}</td>
                    <td className={`num mono ${tone(m.gain)}`}>{formatUsd(m.gain, { sign: true, decimals: 2 })}</td>
                    <td className={`num mono ${tone(m.gainPct)}`}>{formatPct(m.gainPct, 1)}</td>
                    <td className="action">
                      <RowActions row={row} confirming={confirmId === row.id} {...actionProps} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <ul className="pos-cards">
              {view.list.map(({ row, m }) => (
                <li key={row.id} className="pos-card">
                  <div className="pos-card__top">
                    <button type="button" className="pos-sym" onClick={() => openResearch(row)}>
                      <strong className="mono">{row.symbol}</strong>
                      <span className={`chip chip--${row.asset_type}`}>{row.asset_type === 'stock' ? 'Stock' : 'Crypto'}</span>
                    </button>
                    <span className="mono pos-card__value">{formatUsd(m.value, { decimals: 2 })}</span>
                  </div>
                  <div className="pos-card__mid mono small">
                    <span className="muted">
                      {fmtShares(row)} @ {row.avg_cost != null ? formatPrice(row.avg_cost) : '—'}
                    </span>
                    <span>
                      {m.price != null ? formatPrice(m.price) : '…'}{' '}
                      <span className={tone(m.pct)}>{formatPct(m.pct, 2)}</span>
                    </span>
                  </div>
                  <div className="pos-card__bot">
                    <span className={`mono small ${tone(m.gain)}`}>
                      {formatUsd(m.gain, { sign: true, decimals: 2 })} ({formatPct(m.gainPct, 1)})
                    </span>
                    <RowActions row={row} confirming={confirmId === row.id} {...actionProps} />
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </main>
  );
}
