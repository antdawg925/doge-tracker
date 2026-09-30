import { useState } from 'react';
import { authedFetch } from '../../lib/api.js';
import { SHORT_KINGS_WATCHLIST } from '../../lib/shortKings.js';

const px = (n) =>
  Number.isFinite(n) ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 4 : 2 })}` : '—';
const usd0 = (n) => (Number.isFinite(n) ? `$${Math.round(n).toLocaleString('en-US')}` : '—');

/**
 * "Plan a trade" (research): suggested shares for a max loss at the current price, long or short.
 * Only a suggestion; nothing is saved. Your positions use the shares you enter.
 */
export default function PlanTrade({ onAdd }) {
  const [symbol, setSymbol] = useState('');
  const [side, setSide] = useState('long');
  const [risk, setRisk] = useState('100');
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async (sym = symbol, sd = side) => {
    const s = sym.trim().toUpperCase();
    if (!s) return;
    setSymbol(s);
    setBusy(true);
    setError('');
    try {
      setPlan({ ...(await authedFetch('/api/bot/stocks/plan', { method: 'POST', body: { symbol: s, side: sd, riskUsd: Number(risk) || 100 } })), symbol: s });
    } catch (e) {
      setPlan(null);
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const f = plan?.flags;
  const long = plan?.side === 'long';
  return (
    <div className="stk-plan">
      <form
        className="stk-plan__form"
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        <strong className="small">Plan a trade</strong>
        <div className="stk-plan__side" role="group" aria-label="Side">
          {['long', 'short'].map((sd) => (
            <button
              key={sd}
              type="button"
              className={`btn btn--ghost stk-btn ${side === sd ? 'is-active' : ''}`}
              aria-pressed={side === sd}
              onClick={() => {
                setSide(sd);
                if (plan && symbol) run(symbol, sd);
              }}
            >
              {sd === 'long' ? 'Long' : 'Short'}
            </button>
          ))}
        </div>
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
          Max loss $
          <input type="number" min="1" step="1" value={risk} onChange={(e) => setRisk(e.target.value)} />
        </label>
        <button type="submit" className="btn btn--primary stk-btn" disabled={busy || !symbol}>
          {busy ? '…' : 'Suggest shares'}
        </button>
        <span className="small muted">Suggestion only · not saved</span>
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
              <dt>{long ? 'Stop' : 'Buy-stop'}</dt>
              <dd className="mono">{px(plan.stop)}</dd>
            </div>
            <div>
              <dt>ATR</dt>
              <dd className="mono">
                {px(plan.atr)} <span className="small muted">({plan.atrPct?.toFixed(1)}%)</span>
              </dd>
            </div>
            {!long ? (
              <div>
                <dt>Gap cushion</dt>
                <dd className="mono">{px(plan.cushion)}</dd>
              </div>
            ) : null}
            <div>
              <dt>Risk / share</dt>
              <dd className="mono">{plan.perShare ? px(plan.perShare) : '—'}</dd>
            </div>
            <div className="stk-plan__big">
              <dt>Suggested {long ? 'long' : 'short'}</dt>
              <dd className="mono">{plan.shares ?? '—'} sh</dd>
            </div>
            <div>
              <dt>{long ? 'Position cost' : 'Short value'}</dt>
              <dd className="mono">{usd0(plan.cost)}</dd>
            </div>
          </dl>
          <p className="small muted">
            {long
              ? `Stop = max(10-day low ${px(plan.swingLow)} − buffer, price − ${plan.mult} ATR). `
              : `Buy-stop = max(20-day high ${px(plan.swingHigh)} + buffer, price + ${plan.mult} ATR). `}
            {plan.shares ?? 0} sh × {px(plan.perShare)} ≈ {px(plan.totalRisk)}
            {long ? ' if stopped' : ' if it gaps through'} (≤ {px(plan.riskUsd)}). A suggestion: your position uses the shares you enter.
            {f?.si ? (
              <span className="dp-warn">
                {' '}
                High short interest ({f.siPct != null ? `${(f.siPct * 100).toFixed(0)}% float` : '—'}, {f.daysToCover ?? '—'} days to cover): starts at 2.5 ATR.
              </span>
            ) : null}
            {f?.earningsSoon ? <span className="dp-warn"> Earnings {f.earningsDate}.</span> : null}
            {!long && !f?.infoAvailable ? <span> Short interest / earnings n/a from Yahoo.</span> : null}
          </p>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => onAdd({ symbol: plan.symbol, side: plan.side, shares: plan.shares ? String(plan.shares) : '', risk_usd: String(plan.riskUsd) })}
          >
            Add as position (edit shares)
          </button>
        </div>
      ) : null}
    </div>
  );
}
