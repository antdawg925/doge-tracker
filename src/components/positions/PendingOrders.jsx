import { useEffect, useState } from 'react';
import { formatPrice, formatUsd } from '../../lib/format';
import ModePill from '../common/ModePill.jsx';

const age = (iso) => {
  const ms = Date.now() - Date.parse(iso || 0);
  if (!(ms > 0)) return '—';
  const h = ms / 3600000;
  return h < 1 ? `${Math.max(1, Math.round(ms / 60000))}m` : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`;
};

const qtyFmt = (q) => {
  const n = Number(q);
  if (!Number.isFinite(n)) return q;
  return Number.isInteger(n) ? n.toLocaleString('en-US') : Number(n.toFixed(4)).toLocaleString('en-US');
};

/**
 * Positions → Pending orders (limit entries not filled yet). mode 'real' (gold, Kraken / Schwab GTC) or
 * 'paper' (violet, simulated GTC). rows: { id, symbol, side, limit, shares, placedAt, orderId?, note?, badge?, badgeTone?, readOnly? }.
 */
export default function PendingOrders({ id, mode, showPill = false, rows, onCancel, onError }) {
  const [busy, setBusy] = useState(null);
  const has = Boolean(rows?.length);
  const domId = id || `pending-${mode}`;
  useEffect(() => {
    // Link from the order modal: /positions#pending-paper | #pending-real
    if (has && window.location.hash === `#${domId}`) document.getElementById(domId)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [has, domId]);
  if (!has) return null;
  const hasKraken = rows.some((r) => r.badge === 'Kraken');
  const hasSchwab = rows.some((r) => r.badge !== 'Kraken');
  const realVenue = hasKraken && hasSchwab ? 'Kraken + Schwab GTC limit' : hasKraken ? 'Kraken GTC limit' : 'GTC limit at Schwab';
  const cancel = async (r) => {
    if (!window.confirm(`Cancel ${mode === 'real' ? 'the REAL Schwab' : 'the paper'} ${r.side === 'short' ? 'short' : 'long'} limit for ${r.symbol}?`)) return;
    setBusy(r.id);
    try {
      await onCancel(r);
    } catch (e) {
      onError?.(e?.message || 'Cancel failed');
    } finally {
      setBusy(null);
    }
  };
  return (
    <div id={domId} className={`pos-pending pos-pending--${mode}`}>
      <h3 className="small">
        {showPill ? <><ModePill mode={mode} /> </> : null}
        Pending orders <span className="muted">({rows.length} · {mode === 'real' ? realVenue : 'paper GTC limit'})</span>
      </h3>
      <div className="table-wrap">
        <table className="pos-pending__table small">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Side</th>
              <th className="num">Limit</th>
              <th className="num">Shares</th>
              <th className="num">Total $</th>
              <th className="num">Age</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <div className="pos-pending__sym">
                    <strong>{r.symbol}</strong>
                    {r.badge ? <span className={`chip chip--${r.badgeTone || 'crypto'}`}>{r.badge}</span> : null}
                  </div>
                  {r.note || r.orderId ? (
                    <div className="muted">
                      {r.note ? <span>{r.note}</span> : null}
                      {r.note && r.orderId ? ' · ' : null}
                      {r.orderId ? <span className="mono">#{r.orderId}</span> : null}
                    </div>
                  ) : null}
                </td>
                <td className={r.side === 'short' || r.side === 'sell' ? 'neg' : 'pos'}>
                  {r.side === 'short' ? 'Short' : r.side === 'sell' ? 'Sell' : 'Long'}
                </td>
                <td className="num mono">{formatPrice(r.limit)}</td>
                <td className="num mono">{qtyFmt(r.shares)}</td>
                <td className="num mono">{formatUsd(r.shares * r.limit, { decimals: 0 })}</td>
                <td className="num mono">{age(r.placedAt)}</td>
                <td>
                  {r.readOnly ? (
                    <span className="muted small">at Kraken</span>
                  ) : (
                    <button type="button" className="btn btn--ghost stk-btn" disabled={busy === r.id} onClick={() => cancel(r)}>
                      {busy === r.id ? 'Cancelling…' : 'Cancel'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
