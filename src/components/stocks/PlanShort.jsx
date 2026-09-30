import { useState } from 'react';
import { authedFetch } from '../../lib/api.js';
import { SHORT_KINGS_WATCHLIST } from '../../lib/shortKings.js';

const px = (n) =>
  Number.isFinite(n) ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 4 : 2 })}` : '—';

/** "Plan a short": suggested shares for your risk at the current price. Nothing is saved. */
export default function PlanShort({ onAdd }) {
  const [symbol, setSymbol] = useState('');
  const [risk, setRisk] = useState('100');
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async (sym = symbol) => {
    const s = sym.trim().toUpperCase();
    if (!s) return;
    setSymbol(s);
    setBusy(true);
    setError('');
    try {
      setPlan(await authedFetch('/api/bot/stocks/plan', { method: 'POST', body: { symbol: s, riskUsd: Number(risk) || 100 } }));
    } catch (e) {
      setPlan(null);
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const f = plan?.flags;
  return (
    <div className="stk-plan">
      <form
        className="stk-plan__form"
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        <strong className="small">Plan a short</strong>
        <input
          aria-label="Symbol"
          placeholder="Symbol"
          list="stk-my-shorts"
          value={symbol}
          maxLength={10}
          onChange={(e) => setSymbol(e.target.value.toUpperCase())}
        />
        <datalist id="stk-my-shorts">
          {SHORT_KINGS_WATCHLIST.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <label className="small muted">
          Risk $
          <input type="number" min="1" step="1" value={risk} onChange={(e) => setRisk(e.target.value)} />
        </label>
        <button type="submit" className="btn btn--primary stk-btn" disabled={busy || !symbol}>
          {busy ? '…' : 'Size it'}
        </button>
        <span className="small muted">Not saved</span>
      </form>
      {error ? <p className="auth-card__error small">{error}</p> : null}
      {plan ? (
        <div className="stk-plan__out">
          <dl className="stk-plan__stats">
            <div>
              <dt>{plan.symbol} price</dt>
              <dd className="mono">{px(plan.price)}</dd>
            </div>
            <div>
              <dt>Buy-stop</dt>
              <dd className="mono">{px(plan.stop)}</dd>
            </div>
            <div>
              <dt>ATR</dt>
              <dd className="mono">
                {px(plan.atr)} <span className="small muted">({plan.atrPct.toFixed(1)}%)</span>
              </dd>
            </div>
            <div>
              <dt>Gap cushion</dt>
              <dd className="mono" title={`max(1 ATR, largest 60-day gap-up ${(plan.gapPct * 100).toFixed(1)}% × price)`}>
                {px(plan.cushion)}
              </dd>
            </div>
            <div>
              <dt>Risk / share</dt>
              <dd className="mono">{px(plan.perShare)}</dd>
            </div>
            <div className="stk-plan__big">
              <dt>Short</dt>
              <dd className="mono">{plan.shares ?? '—'} sh</dd>
            </div>
          </dl>
          <p className="small muted">
            Buy-stop = max(20-day high {px(plan.swingHigh)} + buffer, price + {plan.mult} ATR). {plan.shares ?? 0} sh × {px(plan.perShare)} ≈{' '}
            {px(plan.totalRisk)} if it gaps through (≤ {px(plan.riskUsd)}).
            {f?.si ? (
              <span className="dp-warn">
                {' '}
                High short interest ({f.siPct != null ? `${(f.siPct * 100).toFixed(0)}% float` : '—'}, {f.daysToCover ?? '—'} days to cover): starts at 2.5 ATR.
              </span>
            ) : null}
            {f?.earningsSoon ? <span className="dp-warn"> Earnings {f.earningsDate}.</span> : null}
            {!f?.infoAvailable ? <span> Short interest / earnings n/a from Yahoo.</span> : null}
          </p>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => onAdd({ symbol: plan.symbol, side: 'short', shares: plan.shares ? String(plan.shares) : '', entry_price: String(plan.price), risk_usd: String(plan.riskUsd) })}
          >
            Add as position
          </button>
        </div>
      ) : null}
    </div>
  );
}
