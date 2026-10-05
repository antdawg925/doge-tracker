import { useMemo } from 'react';
import { formatPct, formatPrice, formatUsd } from '../lib/format';
import { upsideFromHereCopy } from '../lib/levelCopy';
import LevelTable, { InfoTip } from './LevelTable';
import { hasEnteredPosition } from '../lib/math';
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
  const hasPos = hasEnteredPosition(coins, position.avgCost);

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

  const info = `Resistance = prices where sellers often show up and rallies stall: natural places to trim or take profit on ${sym}. Showing the 5 most important ceilings: nearest structural, short-term, and longer 6M / 1Y / max highs when available. ${
    hasPos
      ? 'Upside dollars are vs your average cost for the whole holding (total gain/loss vs what you paid if that ceiling hits).'
      : 'No holding entered: showing percent from today only (no made-up dollar amounts).'
  } Hover or tap a row for details.`;

  const table = topLevels.map((level) => {
    const isPrimary = level.id === primaryId;
    const usdVsCost = hasPos ? level.upsideVsCost : null;
    const pctVsCost =
      hasPos && usdVsCost != null && coins > 0 && Number.isFinite(position.avgCost) && position.avgCost > 0
        ? (usdVsCost / (coins * position.avgCost)) * 100
        : null;
    const copy = upsideFromHereCopy({ hasPosition: hasPos, usdVsCost, pctVsCost, pctFromSpot: level.distPct });
    return {
      id: level.id,
      name: level.friendlyLabel || level.name,
      tag: isPrimary ? 'trim' : null,
      tagCls: 'lvt__tag--trim',
      price: formatPrice(level.price),
      pct: formatPct(level.distPct, 1),
      pctCls: 'pos',
      usd: hasPos && usdVsCost != null ? formatUsd(usdVsCost, { sign: true, decimals: 0 }) : null,
      usdCls: usdVsCost == null ? 'muted' : usdVsCost >= 0 ? 'pos' : 'neg',
      detail: [level.why, copy, isPrimary ? 'Primary trim level.' : ''],
    };
  });

  return (
    <section className="card lv-card">
      <div className="card__head lv-card__head">
        <h2>
          Resistance <InfoTip text={info} />
        </h2>
        <span className="muted small">Top {topLevels.length || 5} ceilings · 6M / 1Y / max</span>
      </div>

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

      {table.length > 0 && <LevelTable rows={table} label="Resistance levels" />}

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
                <th>{hasPos ? 'Vs avg cost' : 'From today %'}</th>
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
                    {row.aboveSpot
                      ? hasPos && row.upsideVsCost != null
                        ? formatUsd(row.upsideVsCost, {
                            sign: true,
                            decimals: 0,
                          })
                        : row.distPct != null
                          ? formatPct(row.distPct, 1)
                          : '—'
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
