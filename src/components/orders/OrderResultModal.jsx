import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { onOrderResult } from '../../lib/orderResult.js';

const n = (v) => (v == null || v === '' ? null : Number(v));
const money = (v) => (Number.isFinite(n(v)) && v !== null ? `$${n(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: n(v) < 10 ? 4 : 2 })}` : '—');
const ptTime = (iso) =>
  new Date(iso).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }) + ' PT';

/**
 * Order confirmation / failure modal. Stays until he closes it: no auto-dismiss, no click-outside.
 * Close via the OK button or Esc.
 * r: { ok, mode: 'paper'|'live', side: 'long'|'short', symbol, shares, limit, stop, target, error,
 *      orderId, status, ideaId, at }
 */
export default function OrderResultModal() {
  const [r, setR] = useState(null);
  const okRef = useRef(null);
  useEffect(() => onOrderResult(setR), []);
  useEffect(() => {
    if (!r) return undefined;
    okRef.current?.focus();
    const k = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setR(null);
      }
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [r]);
  if (!r) return null;
  const live = r.mode === 'live';
  const short = r.side === 'short';
  const tone = !r.ok ? 'fail' : live ? (short ? 'short' : 'live') : 'paper';
  const head = !r.ok
    ? live ? 'LIVE ORDER FAILED' : 'PAPER ORDER FAILED'
    : live ? 'LIVE ORDER SENT TO SCHWAB' : 'PAPER ORDER PLACED';
  const shares = n(r.shares);
  const limit = n(r.limit);
  const stop = n(r.stop);
  const total = shares > 0 && limit > 0 ? shares * limit : null;
  const risk = shares > 0 && limit > 0 && stop > 0 ? shares * Math.abs(limit - stop) : null;
  const rows = [
    ['Symbol', r.symbol],
    ['Side', short ? (live ? 'SELL SHORT' : 'Short (paper)') : live ? 'BUY' : 'Buy (paper)'],
    ['Shares', shares ?? '—'],
    ['Limit price', money(limit)],
    ['Order type', r.orderType || 'GTC limit'],
    ['Total $', money(total)],
    ['Stop', money(stop)],
    ['Target', money(r.target)],
    ['Est. risk $', money(risk)],
    ['Time', ptTime(r.at)],
  ];
  if (r.ok && live) rows.push(['Schwab order id', r.orderId || '—'], ['Status', r.status || '—']);
  if (r.ok && !live) rows.push(['Paper idea id', r.ideaId || '—']);
  return (
    <div className="orm" role="presentation">
      <div className="orm__scrim" aria-hidden="true" />
      <div className={`orm__card orm__card--${tone}`} role="alertdialog" aria-modal="true" aria-labelledby="orm-head">
        <h2 id="orm-head" className="orm__head">{head}</h2>
        {!r.ok ? <p className="orm__reason">{r.error || 'Unknown error'}</p> : null}
        <dl className="orm__grid">
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd className="mono">{v}</dd>
            </div>
          ))}
        </dl>
        {r.ok ? (
          <p className="small orm__where">
            Shows in{' '}
            <Link to={`/positions#pending-${live ? 'real' : 'paper'}`} onClick={() => setR(null)}>
              Positions → Pending orders
            </Link>
          </p>
        ) : (
          <p className="small orm__where">Nothing was {live ? 'sent to Schwab' : 'saved'}.</p>
        )}
        <button ref={okRef} type="button" className="btn btn--primary orm__ok" onClick={() => setR(null)}>
          {r.ok ? 'OK' : 'Close'}
        </button>
      </div>
    </div>
  );
}
