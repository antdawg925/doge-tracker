import { useMemo } from 'react';
import { formatPct, formatPrice, formatUsd } from '../lib/format';
import { resolveCoins, suggestResistance } from '../lib/levels';
import { displaySymbol } from '../lib/assets';

export default function ResistancePanel({ levels, spot, position, asset }) {
  const coins = useMemo(
    () => resolveCoins(position, spot),
    [position, spot],
  );

  const { candidates, primaryId, targetNote } = useMemo(
    () =>
      suggestResistance(
        levels,
        spot,
        coins,
        position.avgCost,
        position.targetPrice,
      ),
    [levels, spot, coins, position.avgCost, position.targetPrice],
  );

  const sym = displaySymbol(asset);

  return (
    <section className="card">
      <div className="card__head">
        <h2>Resistance</h2>
        <span className="muted">Ceilings above spot · trim zones</span>
      </div>

      <p className="hint">
        <strong>Resistance</strong> = prices where sellers often show up and
        rallies stall — natural places to trim or take profit on {sym}. Each
        card shows how far above spot that level sits and the $ upside on your
        holding (vs spot and vs what you paid).
      </p>

      {!spot && (
        <p className="muted">Waiting for live spot to map resistances…</p>
      )}

      {spot && !candidates.length && (
        <p className="muted">
          No clear resistance above spot in this lookback — price may be near
          the top of the range.
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
          nearest resistance ({targetNote.nearestName} at{' '}
          {formatPrice(targetNote.nearestResistance)}).
        </p>
      )}

      {candidates.length > 0 && (
        <ul className="stop-list">
          {candidates.map((r) => {
            const isPrimary = r.id === primaryId;
            return (
              <li
                key={r.id}
                className={`stop-card resist-card ${
                  isPrimary ? 'resist-card--primary' : ''
                }`}
              >
                <div className="stop-card__top">
                  <div>
                    <strong>{r.label}</strong>
                    {isPrimary && (
                      <span className="badge badge--trim">
                        Primary trim zone
                      </span>
                    )}
                    <div className="muted small">{r.name}</div>
                  </div>
                  <div className="stop-card__price mono">
                    {formatPrice(r.price)}
                  </div>
                </div>

                <div className="stop-card__meta">
                  <span className="pos">{formatPct(r.distPct, 1)} above spot</span>
                  <span className="muted">·</span>
                  <span
                    className={
                      r.upsideVsSpot == null
                        ? ''
                        : r.upsideVsSpot >= 0
                          ? 'pos'
                          : 'neg'
                    }
                  >
                    {r.upsideVsSpot == null
                      ? '—'
                      : `${formatUsd(r.upsideVsSpot, {
                          sign: true,
                          decimals: 0,
                        })} upside vs spot`}
                  </span>
                  <span className="muted">·</span>
                  <span
                    className={
                      r.upsideVsCost == null
                        ? ''
                        : r.upsideVsCost >= 0
                          ? 'pos'
                          : 'neg'
                    }
                  >
                    {r.upsideVsCost == null
                      ? '—'
                      : `${formatUsd(r.upsideVsCost, {
                          sign: true,
                          decimals: 0,
                        })} vs cost`}
                  </span>
                </div>

                {r.towardTarget && (
                  <div className="resist-card__target muted small">
                    vs your target {formatPrice(position.targetPrice)}:{' '}
                    <span className="mono">
                      {formatPct(r.towardTarget.targetDistPct, 1)}
                    </span>
                    {r.towardTarget.dollarsFromTarget != null && (
                      <>
                        {' '}
                        (
                        {formatUsd(r.towardTarget.dollarsFromTarget, {
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
                    Highlighted trim zone: nearest meaningful resistance above
                    spot
                    {Number.isFinite(position.targetPrice) &&
                    position.targetPrice > (spot || 0)
                      ? ', steered toward your target price'
                      : ''}
                    . Not advice — just a map of where sellers often appear.
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
