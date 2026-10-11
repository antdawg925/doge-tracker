import { useState } from 'react';
import ModePill from '../common/ModePill.jsx';
import { assetKey } from '../../lib/assets';
import { formatPct, formatPrice, formatUsd } from '../../lib/format';
import { closePaperIdea, deletePaperIdea, ideaAsset, ideaPnl } from '../../lib/paperIdeas.js';

const tone = (n) => (n == null || n === 0 ? '' : n > 0 ? 'pos' : 'neg');
const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric' }) : '');
const qtyFmt = (q) => (Number.isInteger(q) ? q.toLocaleString('en-US') : Number(q.toFixed(4)).toLocaleString('en-US'));
const SRC = { research: 'Research', setup: 'Setup', manual: '', bot_dip: 'Buy dips (bot)', bot_high: 'Sell highs (bot)' };

/** Paper summary: open · unrealized · realized · win rate (closed). Paper only, never real totals. */
export function paperStats(ideas, quotes) {
  let open = 0;
  let unreal = 0;
  let unrealN = 0;
  let realized = 0;
  let wins = 0;
  let closed = 0;
  for (const i of ideas) {
    if (i.status === 'closed') {
      const { pnl } = ideaPnl(i);
      if (pnl != null) {
        realized += pnl;
        closed += 1;
        if (pnl > 0) wins += 1;
      }
    } else {
      open += 1;
      const { pnl } = ideaPnl(i, quotes[assetKey(ideaAsset(i))]?.price);
      if (pnl != null) {
        unreal += pnl;
        unrealN += 1;
      }
    }
  }
  return { open, unreal: unrealN ? unreal : null, realized: closed ? realized : null, closed, winRate: closed ? (wins / closed) * 100 : null };
}

function Row({ i, quotes, onChanged, onOpen, onError }) {
  const [closing, setClosing] = useState(null); // exit price string while confirming
  const [busy, setBusy] = useState(false);
  const live = quotes[assetKey(ideaAsset(i))]?.price ?? null;
  const { pnl, pct, px } = ideaPnl(i, live);
  const isClosed = i.status === 'closed';
  const bot = i.source?.startsWith('bot_');
  const act = async (fn) => {
    setBusy(true);
    try {
      await fn();
      await onChanged();
    } catch (e) {
      onError(e?.message || 'Failed');
    } finally {
      setBusy(false);
      setClosing(null);
    }
  };
  return (
    <tr className={`mode-row--paper${isClosed ? ' is-closed' : ''}`}>
      <td>
        <button type="button" className="pos-sym" onClick={() => onOpen(ideaAsset(i))} title={`Open ${i.symbol} in Research`}>
          <strong className="mono">{i.symbol}</strong>
          <span className={`chip chip--${i.side === 'short' ? 'short' : 'long'}`}>{i.side === 'short' ? 'Short' : 'Long'}</span>
        </button>
        <div className="muted small">
          {SRC[i.source] ? `${SRC[i.source]} · ` : ''}
          {day(i.opened_at)}
          {isClosed ? ` → ${day(i.closed_at)}` : ''}
        </div>
      </td>
      <td className="num mono">{qtyFmt(i.qty)}</td>
      <td className="num mono">{formatPrice(i.entry_price)}</td>
      <td className={`num mono${isClosed ? ' muted' : ''}`} title={isClosed ? 'Exit price' : 'Live price'}>
        {px != null ? formatPrice(px) : '…'}
      </td>
      <td className="num mono small">
        <span className="neg">{i.stop_price ? formatPrice(i.stop_price) : '—'}</span> / <span className="pos">{i.target_price ? formatPrice(i.target_price) : '—'}</span>
      </td>
      <td className={`num mono ${tone(pnl)}`}>
        {formatUsd(pnl, { sign: true, decimals: 2 })} <small>{formatPct(pct, 1)}</small>
      </td>
      <td className="action">
        {bot ? (
          <span className="muted small">bot</span>
        ) : closing != null ? (
          <span className="pos-actions ptf-close">
            <input type="number" step="any" min="0" value={closing} onChange={(e) => setClosing(e.target.value)} aria-label="Exit price" autoFocus />
            <button type="button" className="btn btn--paper" disabled={busy || !(Number(closing) > 0)} onClick={() => act(() => closePaperIdea(i.id, Number(closing)))}>
              Close
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => setClosing(null)}>
              ×
            </button>
          </span>
        ) : (
          <span className="pos-actions">
            {!isClosed ? (
              <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => setClosing(live ? String(live) : String(i.entry_price))} title="Close at an exit price (defaults to the live price)">
                Close
              </button>
            ) : null}
            <button type="button" className="btn btn--ghost pos-actions__x" disabled={busy} title="Delete idea" aria-label={`Delete ${i.symbol} paper idea`} onClick={() => window.confirm(`Delete this ${i.symbol} paper idea?`) && act(() => deletePaperIdea(i.id))}>
              ×
            </button>
          </span>
        )}
      </td>
    </tr>
  );
}

function Table({ list, ...rest }) {
  return (
    <div className="pos-scroll">
      <table className="pos-table pos-table--paper">
        <thead>
          <tr>
            <th>Idea</th>
            <th className="num">Qty</th>
            <th className="num">Entry</th>
            <th className="num">Price</th>
            <th className="num">Stop / target</th>
            <th className="num">P/L</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {list.map((i) => (
            <Row key={i.id} i={i} {...rest} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Positions → Paper ideas (violet): open ideas + bot dry-run fills, closed ideas folded below. */
export default function PaperIdeasSection({ ideas, quotes, form, onAdd, onChanged, onOpen, onError }) {
  const st = paperStats(ideas, quotes);
  const open = ideas.filter((i) => i.status !== 'closed');
  const closed = ideas.filter((i) => i.status === 'closed');
  return (
    <section className="card pos-sec pos-sec--paper">
      <div className="pos-sec__head">
        <h2>
          <ModePill mode="paper" /> Paper ideas
        </h2>
        <dl className="pos-sec__stats">
          <div>
            <dt>Open</dt>
            <dd className="mono">{st.open}</dd>
          </div>
          <div>
            <dt>Unrealized</dt>
            <dd className={`mono ${tone(st.unreal)}`}>{formatUsd(st.unreal, { sign: true, decimals: 2 })}</dd>
          </div>
          <div>
            <dt>Realized</dt>
            <dd className={`mono ${tone(st.realized)}`}>{formatUsd(st.realized, { sign: true, decimals: 2 })}</dd>
          </div>
          <div>
            <dt>Win rate</dt>
            <dd className="mono">{st.winRate != null ? `${Math.round(st.winRate)}% of ${st.closed}` : '—'}</dd>
          </div>
        </dl>
        <button type="button" className="btn btn--paper" onClick={onAdd}>
          + Paper trade
        </button>
      </div>
      {form}
      {open.length ? <Table list={open} quotes={quotes} onChanged={onChanged} onOpen={onOpen} onError={onError} /> : <p className="muted small pos-sec__empty">No open paper ideas. Use Paper trade here or on Research to track an idea without real money.</p>}
      {closed.length ? (
        <details className="pos-sec__closed">
          <summary>
            Closed ideas ({closed.length}) · <span className={tone(st.realized)}>{formatUsd(st.realized, { sign: true, decimals: 2 })}</span>
          </summary>
          <Table list={closed} quotes={quotes} onChanged={onChanged} onOpen={onOpen} onError={onError} />
        </details>
      ) : null}
    </section>
  );
}
