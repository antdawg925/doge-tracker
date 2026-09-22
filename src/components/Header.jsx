import { formatTime } from '../lib/format';
import { displaySymbol } from '../lib/assets';

/** Desk toolbar: current symbol meta + refresh / last updated. */
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
    <div className="desk-toolbar">
      <div className="desk-toolbar__meta">
        <span className="muted">Active</span>
        <strong className="mono">{sym}</strong>
        {asset?.type && (
          <span
            className={`chip chip--${asset.type === 'stock' ? 'stock' : 'crypto'}`}
          >
            {asset.type === 'stock' ? 'Stock' : 'Crypto'}
          </span>
        )}
        <span className="muted desk-toolbar__sep">·</span>
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
  );
}
