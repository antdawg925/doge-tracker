import { useEffect, useState } from 'react';
import SetupChart from './SetupChart.jsx';
import { formatPct, formatPrice } from '../../lib/format.js';
import { setupLines } from '../../lib/setupLines.js';

function useDesktop() {
  const q = '(min-width: 900px)';
  const [d, setD] = useState(() => (typeof window !== 'undefined' ? window.matchMedia(q).matches : true));
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setD(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return d;
}

/**
 * Setup preview: chart + facts + amount + Buy/Short confirm right under the chart.
 * Desktop: right side panel. Mobile: bottom sheet. Both have a close button.
 * facts: [{ k, v, cls }]; amountLabel; shares (computed by parent from amount); onConfirm(shares).
 */
export default function SetupPreview({ row, side, entry, stop, target, facts = [], amount, onAmount, amountLabel, amountStep = 50, shares, confirmLabel, onConfirm, onClose, busy, msg, note, blocked = false }) {
  const desktop = useDesktop();
  const short = side === 'short';
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  const lines = setupLines({ side, plan: row.plan, entry, stop, target });
  return (
    <div className={`stp ${desktop ? 'stp--side' : 'stp--sheet'}`} role="dialog" aria-label={`${row.symbol} preview`}>
      {!desktop ? <button type="button" className="stp__scrim" aria-label="Close preview" onClick={onClose} /> : null}
      <div className="stp__card card">
        <div className="stp__head">
          <div>
            <h2>
              {row.symbol} <span className={`dip-plans__side dip-plans__side--${short ? 'short' : 'long'}`}>{short ? 'Sell high' : 'Buy dip'}</span>
            </h2>
            <p className="small muted stp__sub">
              {formatPrice(row.price)} · {short ? 'short' : 'buy'} {formatPrice(entry)} ({formatPct(row.awayPct, 1)}){row.name && row.name !== row.symbol ? ` · ${row.name}` : ''}
            </p>
          </div>
          <button type="button" className="btn btn--ghost stk-btn stp__close" onClick={onClose} aria-label="Close preview">
            ×
          </button>
        </div>
        <SetupChart symbol={row.symbol} spot={row.price} daily={row.bars?.daily} weekly={row.bars?.weekly} lines={lines} height={desktop ? 380 : 260} />
        <div className="stp__legend small">
          <span className="stp__key stp__key--lvl">{short ? 'Resistance' : 'Support'}</span>
          <span className="stp__key stp__key--entry">{short ? 'Short' : 'Buy'}</span>
          <span className="stp__key stp__key--stop">Stop</span>
          <span className="stp__key stp__key--tgt">{short ? 'Cover' : 'Target'}</span>
          <span className="stp__key stp__key--muted">Other major levels</span>
        </div>
        <div className="stp__confirm">
          <label className="stp__amt">
            <span className="small muted">{amountLabel}</span>
            <input type="number" min="0" step={amountStep} value={amount} onChange={(e) => onAmount(e.target.value)} />
          </label>
          <button type="button" className={`btn ${short ? 'btn--danger' : 'btn--primary'} stk-btn stp__go`} disabled={busy || !shares || blocked} onClick={() => onConfirm(shares)}>
            {busy ? 'Saving…' : confirmLabel}
          </button>
        </div>
        <dl className="dip-sheet__facts small stp__facts">
          {facts.map((f) => (
            <div key={f.k}>
              <dt>{f.k}</dt>
              <dd className={`mono ${f.cls || ''}`}>{f.v}</dd>
            </div>
          ))}
        </dl>
        {note}
        {msg ? <p className="small neg">{msg}</p> : null}
        <p className="small muted stp__dry">Saves a dry-run plan (My Bot → Stocks). Live orders need Stocks Live + Schwab Live.</p>
      </div>
    </div>
  );
}

