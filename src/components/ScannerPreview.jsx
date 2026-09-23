import { useState } from 'react';
import ScannerChart from './ScannerChart';
import NewsPanel from './NewsPanel';
import { rowToStockAsset } from '../lib/scanner';
import { formatPct, formatPrice } from '../lib/format';

/**
 * Right-rail preview for a selected scanner row: chart + news.
 */
export default function ScannerPreview({ row }) {
  const [rangeId, setRangeId] = useState('1Y');

  if (!row) {
    return (
      <aside className="scanner-preview card" aria-label="Symbol preview">
        <div className="scanner-preview__empty">
          <p className="scanner-preview__empty-title">Preview</p>
          <p className="muted">
            Select a symbol to preview chart &amp; news.
          </p>
        </div>
      </aside>
    );
  }

  const asset = rowToStockAsset(row);
  const ch = row.changePct;
  const chClass =
    ch == null ? '' : ch > 0 ? 'is-pos' : ch < 0 ? 'is-neg' : '';

  return (
    <aside className="scanner-preview" aria-label={`${row.symbol} preview`}>
      <div className="card scanner-preview__meta">
        <div className="scanner-preview__sym-row">
          <div>
            <p className="scanner-preview__kicker muted">Selected</p>
            <h2 className="scanner-preview__sym">{row.symbol}</h2>
            <p className="scanner-preview__name muted" title={row.name}>
              {row.name}
            </p>
          </div>
          <div className="scanner-preview__px">
            <strong className="mono">{formatPrice(row.price)}</strong>
            <span className={`mono ${chClass}`}>{formatPct(ch)}</span>
          </div>
        </div>
      </div>

      <div className="card scanner-preview__chart-card">
        <ScannerChart
          symbol={row.symbol}
          rangeId={rangeId}
          onRangeChange={setRangeId}
        />
      </div>

      <NewsPanel asset={asset} compact title={`${row.symbol} news`} />
    </aside>
  );
}
