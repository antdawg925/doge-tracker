import { assetKey, displaySymbol } from '../lib/assets';

/**
 * Left-rail watchlist: add current, remove, click to load.
 * Prices optional — symbol + type badge is enough for Milestone 1.
 */
export default function Watchlist({
  items = [],
  selected,
  onSelect,
  onAddCurrent,
  onRemove,
}) {
  const selectedKey = assetKey(selected);
  const alreadyIn = items.some((a) => assetKey(a) === selectedKey);

  return (
    <section className="watchlist card" aria-label="Watchlist">
      <div className="card__head">
        <h2>Watchlist</h2>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={onAddCurrent}
          disabled={!selected || alreadyIn}
          title={
            alreadyIn
              ? 'Current symbol already on watchlist'
              : `Add ${displaySymbol(selected)}`
          }
        >
          {alreadyIn ? 'Added' : '+ Add'}
        </button>
      </div>

      {items.length === 0 ? (
        <p className="muted small">
          No symbols yet. Search above or click <strong>+ Add</strong> for the
          current ticker.
        </p>
      ) : (
        <ul className="watchlist__list">
          {items.map((asset) => {
            const key = assetKey(asset);
            const active = key === selectedKey;
            const typeLabel = asset.type === 'stock' ? 'Stock' : 'Crypto';
            return (
              <li key={key} className="watchlist__row">
                <button
                  type="button"
                  className={`watchlist__item${active ? ' is-active' : ''}`}
                  onClick={() => onSelect(asset)}
                >
                  <span className="watchlist__sym mono">
                    {displaySymbol(asset)}
                  </span>
                  <span
                    className={`chip chip--${asset.type === 'stock' ? 'stock' : 'crypto'}`}
                  >
                    {typeLabel}
                  </span>
                </button>
                <button
                  type="button"
                  className="watchlist__remove btn btn--ghost"
                  aria-label={`Remove ${displaySymbol(asset)}`}
                  onClick={() => onRemove(asset)}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
