import { formatPct, formatPrice } from '../lib/format';
import { displaySymbol, sourceBadge } from '../lib/assets';

export default function PriceCard({
  asset,
  price,
  change24h,
  loading,
  error,
  warning,
  source,
}) {
  const changeClass =
    change24h == null ? '' : change24h >= 0 ? 'pos' : 'neg';
  const sym = displaySymbol(asset);

  return (
    <section className="card price-card">
      <div className="card__head">
        <h2>
          Live {sym} price
          {asset?.name ? (
            <span className="muted" style={{ fontWeight: 500 }}>
              {' '}
              · {asset.name}
            </span>
          ) : null}
        </h2>
        <span className="badge">
          {source
            ? String(source).charAt(0).toUpperCase() + String(source).slice(1)
            : sourceBadge(asset) || 'Live'}
        </span>
      </div>

      {error && (
        <p className="error-banner">
          Live price not ready yet ({error}). Retrying shortly
          {price != null ? ' — last known value shown above' : ''}.
        </p>
      )}
      {!error && warning && <p className="warn-banner">{warning}</p>}

      <div className="price-card__spot">
        <span className="price-card__value">
          {loading && price == null ? '…' : formatPrice(price)}
        </span>
        <span className={`price-card__chg ${changeClass}`}>
          {formatPct(change24h)} <span className="muted">24h</span>
        </span>
      </div>

      <p className="hint price-card__blurb">
        Spot is the live market price — used to value your holding and measure
        distance to support, resistance, your target, and suggested stops.
      </p>
    </section>
  );
}
