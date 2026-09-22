import { useMemo } from 'react';
import { formatPct, formatPrice, formatUsd } from '../lib/format';
import {
  buildMultiTfResistance,
  pickTopResistances,
  resolveCoins,
} from '../lib/levels';
import { displaySymbol } from '../lib/assets';

export default function ResistancePanel({
  tfSets,
  spot,
  position,
  asset,
  loading,
  error,
  warning,
  chartLevels,
}) {
  const coins = useMemo(
    () => resolveCoins(position, spot),
    [position, spot],
  );

  const {
    comparison,
    primary,
    nearAth,
    athNote,
    targetNote,
  } = useMemo(
    () =>
      buildMultiTfResistance(
        tfSets,
        spot,
        coins,
        position.avgCost,
        position.targetPrice,
      ),
    [tfSets, spot, coins, position.avgCost, position.targetPrice],
  );

  const topLevels = useMemo(
    () =>
      pickTopResistances(
        tfSets,
        spot,
        coins,
        position.avgCost,
        position.targetPrice,
        chartLevels,
      ),
    [
      tfSets,
      spot,
      coins,
      position.avgCost,
      position.targetPrice,
      chartLevels,
    ],
  );

  const sym = displaySymbol(asset);
  const primaryId = primary?.id ?? topLevels[0]?.id ?? null;
  const hasAnyAbove = topLevels.length > 0;

  return (
    <section className="card">
      <div className="card__head">
        <h2>Resistance</h2>
        <span className="muted">
          Top {topLevels.length || 5} ceilings · 6M / 1Y / max · trim zones
        </span>
      </div>

      <p className="hint">
        <strong>Resistance</strong> = prices where sellers often show up and
        rallies stall — natural places to trim or take profit on {sym}. Showing
        the <strong>5 most important</strong> ceilings (nearest structural,
        short-term, and longer 6M / 1Y / max highs when available). Upside is
        measured from <strong>today’s price</strong>.
      </p>

      {warning && <p className="warn-banner">{warning}</p>}
      {error && !hasAnyAbove && (
        <p className="error-banner">Long history: {error}</p>
      )}
      {loading && !hasAnyAbove && (
        <p className="muted">Loading long history for resistance…</p>
      )}

      {!spot && (
        <p className="muted">Waiting for live spot to map resistances…</p>
      )}

      {spot && nearAth && athNote && (
        <p className="resist-ath-note">{athNote}</p>
      )}

      {spot && !loading && !hasAnyAbove && !nearAth && (
        <p className="muted">
          No clear resistance above spot across available lookbacks — price may
          be near the top of the range.
        </p>
      )}

      {targetNote && (
        <p className="resist-target-note">
          Your target {formatPrice(targetNote.targetPrice)} is{' '}
          {Math.abs(targetNote.distPct) < 0.5
            ? 'right at'
            : targetNote.distPct > 0
              ? `${formatPct(targetNote.distPct, 1)} below`
              : `${formatPct(Math.abs(targetNote.distPct), 1)} above`}{' '}
          nearest multi-TF resistance ({targetNote.nearestName} at{' '}
          {formatPrice(targetNote.nearestResistance)}).
        </p>
      )}

      {topLevels.length > 0 && (
        <ol className="sr-list">
          {topLevels.map((level) => {
            const isPrimary = level.id === primaryId;
            const upsideUsd = level.upsideVsSpot;
            return (
              <li
                key={level.id}
                className={`sr-item sr-item--resist ${
                  isPrimary ? 'sr-item--primary' : ''
                }`}
              >
                <div className="sr-item__top">
                  <div>
                    <strong className="sr-item__label">
                      {level.friendlyLabel || level.name}
                    </strong>
                    {isPrimary && (
                      <span className="badge badge--trim">Primary trim</span>
                    )}
                    <div className="sr-item__price mono">
                      {formatPrice(level.price)}
                    </div>
                  </div>
                  <div className="sr-item__dist mono pos">
                    {formatPct(level.distPct, 1)}
                    <span className="muted small"> above</span>
                  </div>
                </div>
                <p className="sr-item__why">{level.why}</p>
                <div className="sr-item__meta">
                  <span
                    className={
                      upsideUsd == null
                        ? 'muted'
                        : upsideUsd >= 0
                          ? 'pos'
                          : 'neg'
                    }
                  >
                    {upsideUsd == null
                      ? 'Upside from here: —'
                      : `Upside from here: gain about ${formatUsd(Math.abs(upsideUsd), {
                          decimals: 0,
                        })} (${Math.abs(level.distPct).toFixed(1)}%) from today`}
                  </span>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {comparison.length > 1 && (
        <details className="resist-compare resist-compare--secondary">
          <summary className="resist-compare__title">
            Period highs side by side (secondary)
          </summary>
          <table className="resist-compare__table">
            <thead>
              <tr>
                <th>Lookback</th>
                <th>High</th>
                <th>From today</th>
                <th>Upside from here</th>
              </tr>
            </thead>
            <tbody>
              {comparison.map((row) => (
                <tr key={row.key}>
                  <td>
                    <strong>{row.shortLabel}</strong>
                    <div className="muted small">{row.name}</div>
                  </td>
                  <td className="mono">{formatPrice(row.price)}</td>
                  <td className={row.aboveSpot ? 'pos' : 'muted'}>
                    {row.aboveSpot
                      ? `${formatPct(row.distPct, 1)} above`
                      : row.distPct != null && row.distPct > -0.5
                        ? 'at / near high'
                        : `${formatPct(row.distPct, 1)} (below today)`}
                  </td>
                  <td className="mono">
                    {row.aboveSpot && row.upsideVsSpot != null
                      ? formatUsd(row.upsideVsSpot, {
                          sign: true,
                          decimals: 0,
                        })
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </section>
  );
}
