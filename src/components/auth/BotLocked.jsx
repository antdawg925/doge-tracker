import { useState } from 'react';
import { useAuth } from '../../hooks/authContext.js';

const FEATURES = [
  ['DOGE plan', 'Core + trading-slice plan with sell, buy-back and zone levels, saved to your account.'],
  ['Staged ATR stop', 'Fixed floor until a 4h close above breakout, then an ATR(14) trail that only moves up.'],
  ['Crossing alerts', 'Sell, breakout, zone, buy-back and stop alerts with notifications and a log.'],
  ['Plan history', 'Every save stamped with price and stop so you can see how the plan evolved.'],
];

const fmtDate = (iso) =>
  new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

/** Alerts tab for signed-in members without the bot tier: explain + request access from the owner. */
export default function BotLocked() {
  const { botRequestedAt, requestBotAccess } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const request = async () => {
    setError('');
    setBusy(true);
    try {
      await requestBotAccess();
    } catch (err) {
      setError(err.message || 'Could not send the request. Try again.');
    } finally {
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
          Alerts is part of Trade Smart Bot. Access is granted by the Trade Smart owner. Send a request
          and it unlocks here once approved.
        </p>

        <ul className="bot-lock__features">
          {FEATURES.map(([title, body]) => (
            <li key={title}>
              <strong>{title}</strong>
              <span className="muted">{body}</span>
            </li>
          ))}
        </ul>

        <div className="bot-lock__cta">
          {botRequestedAt ? (
            <>
              <span className="badge badge--ok bot-lock__sent">Request sent</span>
              <span className="muted small">
                Requested {fmtDate(botRequestedAt)}. Reload after you hear back.
              </span>
            </>
          ) : (
            <button type="button" className="btn btn--primary" onClick={request} disabled={busy}>
              {busy ? 'Sending…' : 'Request access'}
            </button>
          )}
        </div>
        {error ? (
          <p className="auth-card__error" role="alert">
            {error}
          </p>
        ) : null}
      </section>
    </main>
  );
}
