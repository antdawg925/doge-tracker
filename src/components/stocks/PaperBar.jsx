import { useState } from 'react';
import { authedFetch } from '../../lib/api.js';

const usd = (n) => `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signed = (n) => `${n < 0 ? '−' : '+'}${usd(n)}`;

/**
 * One line: paper P/L vs buy & hold, plus the STOCKS Profit lock (separate from DOGE):
 * Max loss, Pause / Resume, Authorize when locked. Protective stops keep working either way.
 */
export default function PaperBar({ tally, guard, onChanged, onError }) {
  const saved = guard?.max_loss_usd != null ? Number(guard.max_loss_usd) : 1;
  const [maxLoss, setMaxLoss] = useState(String(saved));
  const [busy, setBusy] = useState(false);
  const valid = maxLoss.trim() !== '' && Number.isFinite(Number(maxLoss)) && Number(maxLoss) >= 0;

  const act = async (route, body) => {
    setBusy(true);
    try {
      await authedFetch(`/api/bot/stocks/guard/${route}`, { method: 'POST', body });
      await onChanged();
    } catch (e) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const saveLoss = () => valid && Number(maxLoss) !== saved && act('max-loss', { maxLossUsd: Number(maxLoss) });

  return (
    <div className={`stk-paper${guard?.locked ? ' is-locked' : ''}`}>
      <span className="stk-paper__pnl" title={`Realized ${signed(tally.realized)} · unrealized ${signed(tally.unrealized)} · ${tally.working} working, ${tally.filled} filled${tally.blocked ? `, ${tally.blocked} blocked` : ''}`}>
        Paper: <strong className={tally.paper >= 0 ? 'pos' : 'neg'}>{signed(tally.paper)}</strong>{' '}
        <span className="muted">(vs hold</span> <span className={tally.hold >= 0 ? 'pos' : 'neg'}>{signed(tally.hold)}</span>
        <span className="muted">)</span>
      </span>
      {guard?.locked ? (
        <>
          <span className="small neg" title={guard.lock_reason || ''}>
            Locked: new paper entries paused · stops still protected
          </span>
          <button
            type="button"
            className="btn btn--primary stk-btn"
            disabled={busy}
            onClick={() =>
              window.confirm('Authorize the stocks paper book again? Your starting amount resets to the current book; it locks again if the book falls more than your max loss below it.') &&
              act('unlock', {})
            }
          >
            Authorize next trade
          </button>
        </>
      ) : (
        <span className="small muted">
          Lock: {guard?.paused ? <span className="dp-warn">paused (stops still move)</span> : <span className="pos">armed</span>}
        </span>
      )}
      <label className="small muted stk-paper__loss" title="Lock new paper entries when the book falls this far below your starting amount (Σ entry cost)">
        Max loss $
        <input type="number" min="0" step="1" value={maxLoss} aria-invalid={!valid} onChange={(e) => setMaxLoss(e.target.value)} onBlur={saveLoss} onKeyDown={(e) => e.key === 'Enter' && saveLoss()} />
      </label>
      <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => act('pause', { paused: !guard?.paused })}>
        {guard?.paused ? 'Resume' : 'Pause'}
      </button>
    </div>
  );
}
