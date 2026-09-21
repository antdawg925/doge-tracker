import { useMemo } from 'react';
import { formatPct, formatPrice, formatUsd } from '../lib/format';
import { buildMultiTfResistance, resolveCoins } from '../lib/levels';
import { displaySymbol } from '../lib/assets';

function LevelCard({ level, isPrimary, targetPrice, spot }) {
  return (
    <li
      className={`stop-card resist-card ${
        isPrimary ? 'resist-card--primary' : ''
      }`}
    >
      <div className="stop-card__top">
        <div>
          <strong>{level.name}</strong>
          {isPrimary && (
            <span className="badge badge--trim">Primary trim zone</span>
          )}
          <div className="muted small">
            {level.kind === 'period_high'
              ? 'Period high (strong ceiling)'
              : level.kind === 'swing_high'
                ? 'Recent swing high'
                : level.kind === 'major_peak'
                  ? 'Prior major peak'
                  : level.kind === 'percentile'
                    ? '75th percentile of highs'
                    : 'Median of closes'}
          </div>
        </div>
        <div className="stop-card__price mono">{formatPrice(level.price)}</div>
      </div>

      <div className="stop-card__meta">
        <span className="pos">
          {formatPct(level.distPct, 1)} above spot
        </span>
        <span className="muted">·</span>
        <span
          className={
            level.upsideVsSpot == null
              ? ''
              : level.upsideVsSpot >= 0
                ? 'pos'
                : 'neg'
          }
        >
          {level.upsideVsSpot == null
            ? '—'
            : `${formatUsd(level.upsideVsSpot, {
                sign: true,
                decimals: 0,
              })} upside vs spot`}
        </span>
        <span className="muted">·</span>
        <span
          className={
            level.upsideVsCost == null
              ? ''
              : level.upsideVsCost >= 0
                ? 'pos'
                : 'neg'
          }
        >
          {level.upsideVsCost == null
            ? '—'
            : `${formatUsd(level.upsideVsCost, {
                sign: true,
                decimals: 0,
              })} vs cost`}
        </span>
      </div>

      {level.towardTarget && (
        <div className="resist-card__target muted small">
          vs your target {formatPrice(targetPrice)}:{' '}
          <span className="mono">
            {formatPct(level.towardTarget.targetDistPct, 1)}
          </span>
          {level.towardTarget.dollarsFromTarget != null && (
            <>
              {' '}
              (
              {formatUsd(level.towardTarget.dollarsFromTarget, {
                sign: true,
                decimals: 0,
              })}
              )
            </>
          )}
        </div>
      )}

      {isPrimary && (
        <p className="stop-card__why muted small">
          Highlighted trim zone: nearest strong ceiling above spot, weighted
          toward longer timeframes (1Y / 5Y+)
          {Number.isFinite(targetPrice) && targetPrice > (spot || 0)
            ? ', steered toward your target price'
            : ''}
          . Not advice — just a map of where sellers often appear.
        </p>
      )}
    </li>
  );
}

export default function ResistancePanel({
  tfSets,
  spot,
  position,
  asset,
  loading,
  error,
  warning,
}) {
  const coins = useMemo(
    () => resolveCoins(position, spot),
    [position, spot],
  );

  const {
    groups,
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

  const sym = displaySymbol(asset);
  const primaryId = primary?.id ?? null;
  const hasAnyAbove = groups.some((g) => g.levels.length > 0);

  return (
    <section className="card">
      <div className="card__head">
        <h2>Resistance</h2>
        <span className="muted">
          Multi-TF ceilings · 6M / 1Y / 5Y+ · trim zones
        </span>
      </div>

      <p className="hint">
        <strong>Resistance</strong> = prices where sellers often show up and
        rallies stall — natural places to trim or take profit on {sym}. Levels
        below are built from <em>longer history</em> (not just the short chart
        window): 6 months, 1 year, and up to 5 years when the free APIs allow.
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

      {comparison.length > 1 && (
        <div className="resist-compare">
          <h3 className="resist-compare__title">Period highs side by side</h3>
          <table className="resist-compare__table">
            <thead>
              <tr>
                <th>Lookback</th>
                <th>High</th>
                <th>vs spot</th>
                <th>$ upside</th>
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
                        : `${formatPct(row.distPct, 1)} (below spot)`}
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
        </div>
      )}

      {groups.map((group) => (
        <div key={group.key} className="resist-tf">
          <div className="resist-tf__head">
            <h3>
              {group.shortLabel}
              {group.capped && (
                <span className="badge badge--cap">max available</span>
              )}
            </h3>
            <span className="muted small">
              {group.barCount} daily bars · {group.name}
            </span>
          </div>
          <p className="resist-tf__blurb muted small">{group.blurb}</p>

          {!group.levels.length ? (
            <p className="muted small">
              {group.periodHigh && !group.periodHigh.aboveSpot
                ? `Spot is at / above the ${group.shortLabel} high (${formatPrice(group.periodHigh.price)}) — no ceiling left in this window.`
                : `No levels clearly above spot in the ${group.shortLabel} window.`}
            </p>
          ) : (
            <ul className="stop-list">
              {group.levels.map((level) => (
                <LevelCard
                  key={level.id}
                  level={level}
                  isPrimary={level.id === primaryId}
                  targetPrice={position.targetPrice}
                  spot={spot}
                />
              ))}
            </ul>
          )}
        </div>
      ))}
    </section>
  );
}
