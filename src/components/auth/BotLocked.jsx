import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../hooks/authContext.js';

const FEATURES = [
  ['DOGE plan', 'Core + trading-slice plan with sell, buy-back and zone levels, saved to your account.'],
  ['Staged ATR stop', 'Fixed floor until a 4h close above breakout, then an ATR(14) trail that only moves up.'],
  ['Crossing alerts', 'Sell, breakout, zone, buy-back and stop alerts with notifications and a log.'],
  ['Plan history', 'Every save stamped with price and stop so you can see how the plan evolved.'],
];

/** Alerts tab for signed-in members without the bot tier: explain + redeem an access key. */
export default function BotLocked() {
  const { redeemKey } = useAuth();
  const [params] = useSearchParams();
  const [code, setCode] = useState((params.get('key') || '').toUpperCase());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await redeemKey(code);
      // Profile refresh flips hasBotAccess and the real Alerts page renders.
    } catch (err) {
      setError(err.message || 'Could not redeem that key.');
      setBusy(false);
    }
  };

  return (
    <main className="bot-lock">
      <section className="bot-lock__card card">
        <div className="bot-lock__head">
          <span className="bot-lock__icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="4" y="10.5" width="16" height="10" rx="2.5" />
              <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
            </svg>
          </span>
          <div>
            <p className="scanner__kicker muted">Alerts</p>
            <h1>Trade Smart Bot</h1>
          </div>
        </div>
        <p className="bot-lock__lede muted">
          Alerts is part of Trade Smart Bot. Enter an access key to unlock it for your account.
        </p>

        <ul className="bot-lock__features">
          {FEATURES.map(([title, body]) => (
            <li key={title}>
              <strong>{title}</strong>
              <span className="muted">{body}</span>
            </li>
          ))}
        </ul>

        <form className="bot-lock__form" onSubmit={submit}>
          <label className="field">
            Enter access key
            <input
              className="mono"
              placeholder="TS-XXXX-XXXX"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              aria-invalid={error ? 'true' : undefined}
            />
          </label>
          <button type="submit" className="btn btn--primary" disabled={busy || !code.trim()}>
            {busy ? 'Unlocking…' : 'Unlock'}
          </button>
        </form>
        {error ? (
          <p className="auth-card__error" role="alert">
            {error}
          </p>
        ) : null}
      </section>
    </main>
  );
}
