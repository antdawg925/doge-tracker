import { useMemo } from 'react';
import { formatCoins, formatPct, formatPrice, formatUsd } from '../lib/format';
import { positionMetrics } from '../lib/math';
import { displaySymbol, unitLabel } from '../lib/assets';

/**
 * Dad-friendly one-glance story: hold, paid, profit target, P&L.
 */
export default function PositionSummary({ position, spot, asset }) {
  const m = useMemo(
    () =>
      positionMetrics(
        position.coins,
        position.avgCost,
        spot,
        position.targetPrice,
      ),
    [position.coins, position.avgCost, position.targetPrice, spot],
  );

  const sym = displaySymbol(asset);
  const units = unitLabel(asset);

  return (
    <section className="card">
      <div className="card__head">
        <h2>What this position looks like</h2>
        {spot != null && (
          <span className="muted mono">spot {formatPrice(spot)}</span>
        )}
      </div>

      <p className="hint">
        Single {sym} holding — here’s what you own, what you paid, and what
        happens at your target.
      </p>

      <div className="stat-grid stat-grid--4">
        <div className="stat">
          <span className="stat__label">Holding</span>
          <span className="stat__value">
            {formatCoins(m.coins)} {units}
          </span>
        </div>
        <div className="stat">
          <span className="stat__label">Avg cost</span>
          <span className="stat__value">{formatPrice(position.avgCost)}</span>
        </div>
        <div className="stat">
          <span className="stat__label">Worth now</span>
          <span className="stat__value">
            {spot != null ? formatUsd(m.positionValue, { decimals: 0 }) : '—'}
          </span>
        </div>
        <div className="stat">
          <span className="stat__label">Unrealized P&amp;L</span>
          <span
            className={`stat__value ${
              m.unrealizedPnlPct == null
                ? ''
                : m.unrealizedPnl >= 0
                  ? 'pos'
                  : 'neg'
            }`}
          >
            {m.costBasis > 0
              ? `${formatUsd(m.unrealizedPnl, {
                  sign: true,
                  decimals: 0,
                })}`
              : '—'}
            {m.unrealizedPnlPct != null && (
              <span className="stat__sub">{formatPct(m.unrealizedPnlPct, 1)}</span>
            )}
          </span>
        </div>
      </div>

      <div className="target-banner">
        <div>
          <span className="muted small">Take-profit target</span>
          <strong className="mono"> {formatPrice(position.targetPrice)}</strong>
        </div>
        <div className="target-banner__pnl">
          {m.atTargetValue != null ? (
            <>
              Would be worth{' '}
              <strong>{formatUsd(m.atTargetValue, { decimals: 0 })}</strong>
              {m.atTargetPnl != null && (
                <span className={m.atTargetPnl >= 0 ? 'pos' : 'neg'}>
                  {' '}
                  ({formatUsd(m.atTargetPnl, { sign: true, decimals: 0 })} /{' '}
                  {formatPct(m.atTargetPnlPct, 0)})
                </span>
              )}
            </>
          ) : (
            <span className="muted">Set a target to see outcome</span>
          )}
        </div>
      </div>
    </section>
  );
}
