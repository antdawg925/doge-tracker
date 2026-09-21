import { formatTime } from '../lib/format';
import { displaySymbol } from '../lib/assets';

export default function Header({
  asset,
  lastUpdated,
  loading,
  error,
  warning,
  onRefresh,
}) {
  const sym = displaySymbol(asset);
  return (
    <header className="header">
      <div className="header__brand">
        <span className="header__mark" aria-hidden>
          {asset?.type === 'stock' ? '$' : 'Ð'}
        </span>
        <div>
          <h1 className="header__title">Position Tracker</h1>
          <p className="header__sub">
            {sym} · What I hold · What I paid · Where I’d take profit · Where
            I’d stop
          </p>
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
