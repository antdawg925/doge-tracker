import { formatPct, formatPrice } from '../lib/format';
import { displaySymbol, sourceBadge } from '../lib/assets';

/** Compact live price line that sits on top of the chart (replaces the big PriceCard). */
export default function PriceStrip({ asset, price, change24h, loading, error, warning, source }) {
  const sym = displaySymbol(asset);
  const chg = change24h == null ? '' : change24h >= 0 ? 'pos' : 'neg';
  const badge = source ? String(source).charAt(0).toUpperCase() + String(source).slice(1) : sourceBadge(asset) || 'Live';
  return (
    <div className="price-strip" aria-label={`Live ${sym} price`}>
      <span className="price-strip__sym">{sym}</span>
      {asset?.name ? <span className="price-strip__name muted small">{asset.name}</span> : null}
      <span className="price-strip__px mono">{loading && price == null ? '…' : formatPrice(price)}</span>
      <span className={`price-strip__chg small ${chg}`}>
        {formatPct(change24h)} <span className="muted">24h</span>
      </span>
      <span className="badge price-strip__badge">{badge}</span>
      {error ? (
        <span className="price-strip__note small neg">Live price not ready ({error}){price != null ? '; last known shown' : ''}</span>
      ) : warning ? (
        <span className="price-strip__note small dp-warn">{warning}</span>
      ) : null}
    </div>
  );
}
