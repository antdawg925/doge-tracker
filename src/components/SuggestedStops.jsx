import { useMemo } from 'react';
import { formatPct, formatPrice, formatUsd } from '../lib/format';
import { resolveCoins, suggestStops } from '../lib/levels';

export default function SuggestedStops({ levels, spot, position, tfSets }) {
  const coins = useMemo(
    () => resolveCoins(position, spot),
    [position, spot],
  );

  const { candidates, primaryId } = useMemo(
    () => suggestStops(levels, spot, coins, position.avgCost, tfSets),
    [levels, spot, coins, position.avgCost, tfSets],
  );

  return (
    <section className="card">
      <div className="card__head">
        <h2>Suggested stop losses</h2>
        <span className="muted">Aligned with Top support floors</span>
      </div>

      <p className="hint">
        A <strong>stop</strong> is the price where you’d cut the trade if it
        breaks down — so a small loss doesn’t become a big one. These ideas use
        the same condensed Top supports as the Support panel — not every
        statistical floor. Risk is measured from <strong>today’s price</strong>.
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
            const riskUsd = s.riskVsSpot;
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

                {s.why && <p className="stop-card__why muted small">{s.why}</p>}

                <div className="stop-card__meta">
                  <span>{formatPct(-s.distPctBelow, 1)} below today</span>
                  <span className="muted">·</span>
                  <span className={riskUsd == null ? 'muted' : 'neg'}>
                    {riskUsd == null
                      ? 'Risk from here: —'
                      : `Risk from here: lose about ${formatUsd(Math.abs(riskUsd), {
                          decimals: 0,
                        })} (${s.distPctBelow.toFixed(1)}%) from today`}
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
