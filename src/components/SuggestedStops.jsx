import { useMemo } from 'react';
import { formatPct, formatPrice } from '../lib/format';
import { riskFromHereCopy } from '../lib/levelCopy';
import { hasEnteredPosition } from '../lib/math';
import { resolveCoins, suggestStops } from '../lib/levels';

export default function SuggestedStops({ levels, spot, position, tfSets }) {
  const coins = useMemo(
    () => resolveCoins(position, spot),
    [position, spot],
  );
  const hasPos = hasEnteredPosition(coins, position.avgCost);

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
        statistical floor.{' '}
        {hasPos ? (
          <>
            Risk dollars are vs <strong>your average cost</strong> for the whole
            position (P&amp;L if stopped out there vs what you paid).
          </>
        ) : (
          <>
            No holding entered — showing <strong>percent below today</strong>{' '}
            only (no made-up dollar amounts).
          </>
        )}
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
            const usdVsCost = hasPos ? s.riskVsCost : null;
            const pctVsCost =
              hasPos &&
              usdVsCost != null &&
              Number.isFinite(coins) &&
              coins > 0 &&
              Number.isFinite(position.avgCost) &&
              position.avgCost > 0
                ? (usdVsCost / (coins * position.avgCost)) * 100
                : null;
            const copy = riskFromHereCopy({
              hasPosition: hasPos,
              usdVsCost,
              pctVsCost,
              pctFromSpot: -s.distPctBelow,
            });
            const toneClass =
              hasPos && usdVsCost != null
                ? usdVsCost >= 0
                  ? 'pos'
                  : 'neg'
                : 'neg';
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
                  <span className={toneClass}>{copy}</span>
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
