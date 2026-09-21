import { useMemo } from 'react';
import { formatPct, formatPrice, formatUsd } from '../lib/format';
import { resolveCoins, suggestStops } from '../lib/levels';

export default function SuggestedStops({ levels, spot, position }) {
  const coins = useMemo(
    () => resolveCoins(position, spot),
    [position, spot],
  );

  const { candidates, primaryId } = useMemo(
    () => suggestStops(levels, spot, coins, position.avgCost),
    [levels, spot, coins, position.avgCost],
  );

  return (
    <section className="card">
      <div className="card__head">
        <h2>Suggested stop losses</h2>
        <span className="muted">Based on support below spot</span>
      </div>

      <p className="hint">
        A <strong>stop</strong> is the price where you’d cut the trade if it
        breaks down — so a small loss doesn’t become a big one. These ideas use
        support levels (prices that have held before) below today’s spot.
      </p>

      {!spot && (
        <p className="muted">Waiting for live spot to suggest stops…</p>
      )}

      {spot && !candidates.length && (
        <p className="muted">
          No clear support below spot yet — wait for more daily history, or
          check the Support panel.
        </p>
      )}

      {candidates.length > 0 && (
        <ul className="stop-list">
          {candidates.map((s) => {
            const isPrimary = s.id === primaryId;
            return (
              <li
                key={s.id}
                className={`stop-card ${isPrimary ? 'stop-card--primary' : ''}`}
              >
                <div className="stop-card__top">
                  <div>
                    <strong>{s.label}</strong>
                    {isPrimary && (
                      <span className="badge badge--primary">Primary</span>
                    )}
                    <div className="muted small">{s.name}</div>
                  </div>
                  <div className="stop-card__price mono">
                    {formatPrice(s.price)}
                  </div>
                </div>

                <div className="stop-card__meta">
                  <span>{formatPct(-s.distPctBelow, 1)} below spot</span>
                  <span className="muted">·</span>
                  <span
                    className={
                      s.riskVsSpot == null
                        ? ''
                        : s.riskVsSpot <= 0
                          ? 'neg'
                          : 'pos'
                    }
                  >
                    {s.riskVsSpot == null
                      ? '—'
                      : `${formatUsd(s.riskVsSpot, {
                          sign: true,
                          decimals: 0,
                        })} vs spot`}
                  </span>
                  <span className="muted">·</span>
                  <span
                    className={
                      s.riskVsCost == null
                        ? ''
                        : s.riskVsCost >= 0
                          ? 'pos'
                          : 'neg'
                    }
                  >
                    {s.riskVsCost == null
                      ? '—'
                      : `${formatUsd(s.riskVsCost, {
                          sign: true,
                          decimals: 0,
                        })} vs cost`}
                  </span>
                </div>

                {isPrimary && (
                  <p className="stop-card__why muted small">
                    Recommended: closest meaningful support (ideally ~3–5% below
                    spot so everyday noise doesn’t stop you out).
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
