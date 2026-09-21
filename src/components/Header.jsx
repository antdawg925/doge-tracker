import { formatTime } from '../lib/format';

export default function Header({
  lastUpdated,
  loading,
  error,
  warning,
  onRefresh,
}) {
  return (
    <header className="header">
      <div className="header__brand">
        <span className="header__mark" aria-hidden>
          Ð
        </span>
        <div>
          <h1 className="header__title">DOGE Position Tracker</h1>
          <p className="header__sub">Core · Vol sleeve · Buy ladder · Chart</p>
        </div>
      </div>
      <div className="header__actions">
        <div className="header__meta">
          <span className="muted">Last refresh</span>
          <strong>{formatTime(lastUpdated)}</strong>
          {error && <span className="badge badge--warn">Offline / error</span>}
          {!error && warning && (
            <span className="badge badge--warn">Cached / soft warn</span>
          )}
        </div>
        <button
          type="button"
          className="btn"
          onClick={onRefresh}
          disabled={loading}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
    </header>
  );
}
