import { useState } from 'react';
import { formatPrice, formatUsd } from '../../lib/format';

const age = (iso) => {
  const ms = Date.now() - Date.parse(iso || 0);
  if (!(ms > 0)) return '—';
  const h = ms / 3600000;
  return h < 1 ? `${Math.max(1, Math.round(ms / 60000))}m` : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`;
};

/**
 * Positions → Pending orders (limit entries not filled yet). mode 'real' (gold, Schwab GTC) or
 * 'paper' (violet, simulated GTC). rows: { id, symbol, side, limit, shares, placedAt, orderId?, note? }.
 */
export default function PendingOrders({ mode, rows, onCancel, onError }) {
  const [busy, setBusy] = useState(null);
  if (!rows?.length) return null;
  const cancel = async (r) => {
    if (!window.confirm(`Cancel ${mode === 'real' ? 'the REAL Schwab' : 'the paper'} ${r.side === 'short' ? 'short' : 'buy'} limit for ${r.symbol}?`)) return;
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
    <div className={`pos-pending pos-pending--${mode}`}>
      <h3 className="small">
        Pending orders <span className="muted">({rows.length} · {mode === 'real' ? 'GTC limit at Schwab' : 'paper GTC limit'})</span>
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
                  <strong>{r.symbol}</strong>
                  {r.orderId ? <div className="muted mono">#{r.orderId}</div> : r.note ? <div className="muted">{r.note}</div> : null}
                </td>
                <td className={r.side === 'short' ? 'neg' : 'pos'}>{r.side === 'short' ? 'Short' : 'Buy'}</td>
                <td className="num mono">{formatPrice(r.limit)}</td>
                <td className="num mono">{r.shares}</td>
                <td className="num mono">{formatUsd(r.shares * r.limit, { decimals: 0 })}</td>
                <td className="num mono">{age(r.placedAt)}</td>
                <td>
                  <button type="button" className="btn btn--ghost stk-btn" disabled={busy === r.id} onClick={() => cancel(r)}>
                    {busy === r.id ? 'Cancelling…' : 'Cancel'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
