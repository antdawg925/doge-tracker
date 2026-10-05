import { formatPct, formatPrice } from '../lib/format';

/** One compact strip under the chart: price · 24h · range · stage · pump-dump. */
export default function KeyStats({ price, change24h, source, range, rangeLabel, stage, pump, onOpen, error, warning }) {
  const chg = change24h == null ? '' : change24h >= 0 ? 'pos' : 'neg';
  return (
    <div className="kstats" aria-label="Key stats">
      <span className="kstats__item">
        <span className="kstats__k">Price</span> <span className="mono kstats__px">{formatPrice(price)}</span>
        {source ? <span className="kstats__src">{source}</span> : null}
      </span>
      <span className="kstats__item">
        <span className="kstats__k">24h</span> <span className={`mono ${chg}`}>{formatPct(change24h)}</span>
      </span>
      {range ? (
        <span className="kstats__item" title={`Low–high over the chart range (${rangeLabel})`}>
          <span className="kstats__k">{rangeLabel}</span> <span className="mono">{formatPrice(range.low)}–{formatPrice(range.high)}</span>
        </span>
      ) : null}
      {stage?.ok ? (
        <button type="button" className={`kpill kpill--s${stage.stage}`} title={`${stage.tradability} (${stage.confidence} confidence)`} onClick={() => onOpen?.('momentum')}>
          Stage {stage.stage} · {stage.label}
        </button>
      ) : null}
      {pump?.show ? (
        <button type="button" className={`kpill kpill--warn`} title={pump.detail} onClick={() => onOpen?.('risk')}>
          P&amp;D risk{pump.confidence ? ` · ${pump.confidence === 'med' ? 'medium' : pump.confidence}` : ''}
        </button>
      ) : (
        <span className="kpill kpill--muted" title="No pump-and-dump pattern flagged">No P&amp;D flag</span>
      )}
      {error ? (
        <span className="kstats__note small neg">Live price not ready ({error}){price != null ? '; last known shown' : ''}</span>
      ) : warning ? (
        <span className="kstats__note small dp-warn">{warning}</span>
      ) : null}
    </div>
  );
}
