import { formatPct, formatPrice } from '../lib/format';
import { BUY_LADDER, STOP_ADDING } from '../lib/defaults';
import { distanceToLevel, ladderStatus } from '../lib/math';

export default function PriceCard({
  price,
  change24h,
  loading,
  error,
  warning,
}) {
  const changeClass =
    change24h == null ? '' : change24h >= 0 ? 'pos' : 'neg';

  const levels = [
    { label: 'Optional', level: BUY_LADDER[0].high },
    { label: 'Main', level: BUY_LADDER[1].low },
    { label: 'Finish', level: BUY_LADDER[2].low },
    { label: 'Stop zone', level: STOP_ADDING.high },
  ];

  return (
    <section className="card price-card">
      <div className="card__head">
        <h2>Live DOGE / USD</h2>
        <span className="badge">CoinGecko</span>
      </div>

      {error && (
        <p className="error-banner">
          Could not load price: {error}. Showing last known or waiting for
          retry.
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

      <ul className="price-card__ladder">
        {levels.map(({ label, level }) => {
          const dist = distanceToLevel(price, level);
          const status = ladderStatus(price, level, level);
          return (
            <li key={label}>
              <span className="muted">{label}</span>
              <strong>{formatPrice(level)}</strong>
              <span className={`chip chip--${status}`}>
                {status === 'above'
                  ? 'below spot'
                  : status === 'below'
                    ? 'above spot'
                    : 'at level'}
              </span>
              <span className="mono">
                {dist == null
                  ? '—'
                  : `${dist > 0 ? '+' : ''}${dist.toFixed(1)}%`}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
