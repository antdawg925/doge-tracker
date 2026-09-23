import { useEffect, useMemo, useState } from 'react';
import { displaySymbol } from '../lib/assets';
import { fetchSymbolNews, formatNewsTime } from '../lib/news';
import {
  SIGNIFICANCE_LABELS,
  summarizeSignificance,
} from '../lib/newsSignificance';

/**
 * Shared stock/crypto news list with significance badges.
 * Used on Desk and Scanner preview.
 */
export default function NewsPanel({
  asset,
  compact = false,
  className = '',
  title,
}) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [warning, setWarning] = useState(null);
  const [showLow, setShowLow] = useState(false);

  const sym = displaySymbol(asset);
  const key = asset
    ? `${asset.type || 'stock'}:${String(asset.symbol || '').toUpperCase()}`
    : '';

  useEffect(() => {
    if (!asset?.symbol) {
      setItems([]);
      setWarning(null);
      setLoading(false);
      return undefined;
    }
    const ac = new AbortController();
    setLoading(true);
    setWarning(null);
    setShowLow(false);
    fetchSymbolNews(asset, { signal: ac.signal, limit: compact ? 10 : 14 })
      .then((result) => {
        if (ac.signal.aborted) return;
        setItems(result.items || []);
        setWarning(result.warning || null);
      })
      .catch((err) => {
        if (err?.name === 'AbortError') return;
        setItems([]);
        setWarning(err?.message || 'News unavailable');
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
  }, [key, asset, compact]);

  const visible = useMemo(() => {
    if (showLow) return items;
    return items.filter((i) => i.significance?.level !== 'low');
  }, [items, showLow]);

  const lowCount = useMemo(
    () => items.filter((i) => i.significance?.level === 'low').length,
    [items],
  );

  const summary = useMemo(() => summarizeSignificance(items), [items]);
  const heading = title || (sym ? `${sym} news` : 'News');

  return (
    <section className={`card news-panel${compact ? ' news-panel--compact' : ''} ${className}`.trim()}>
      <div className="card__head news-panel__head">
        <h2>{heading}</h2>
        {loading ? (
          <span className="muted small">Loading…</span>
        ) : items.length ? (
          <span className="muted small">{items.length} headlines</span>
        ) : null}
      </div>

      {!asset?.symbol ? (
        <p className="muted news-panel__empty">Select a symbol to load news.</p>
      ) : null}

      {warning && !loading ? (
        <p className="news-panel__warn" role="status">
          {warning}
        </p>
      ) : null}

      {asset?.symbol && !loading && !warning && items.length > 0 ? (
        <p className="news-panel__summary">{summary}</p>
      ) : null}

      {loading && !items.length ? (
        <p className="muted news-panel__empty">Fetching headlines…</p>
      ) : null}

      {!loading && asset?.symbol && !items.length && !warning ? (
        <p className="muted news-panel__empty">No headlines found.</p>
      ) : null}

      {visible.length > 0 ? (
        <ul className="news-panel__list">
          {visible.map((item) => {
            const level = item.significance?.level || 'low';
            const label = SIGNIFICANCE_LABELS[level] || 'Low signal';
            const why =
              level === 'significant' && item.significance?.reasons?.length
                ? item.significance.reasons.join(' · ')
                : null;
            const body = (
              <>
                <div className="news-panel__meta">
                  <span className={`news-badge news-badge--${level}`}>
                    {label}
                  </span>
                  <span className="news-panel__source muted">
                    {item.source}
                    {item.publishedAt
                      ? ` · ${formatNewsTime(item.publishedAt)}`
                      : ''}
                  </span>
                </div>
                <p className="news-panel__title">{item.title}</p>
                {why ? (
                  <p className="news-panel__why muted">Why: {why}</p>
                ) : null}
              </>
            );
            return (
              <li key={item.id} className={`news-panel__item news-panel__item--${level}`}>
                {item.link ? (
                  <a
                    href={item.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="news-panel__link"
                  >
                    {body}
                  </a>
                ) : (
                  <div className="news-panel__link">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}

      {lowCount > 0 ? (
        <button
          type="button"
          className="btn btn--ghost news-panel__toggle"
          onClick={() => setShowLow((v) => !v)}
        >
          {showLow
            ? 'Hide low-signal'
            : `Show low-signal (${lowCount})`}
        </button>
      ) : null}
    </section>
  );
}
