import { useMemo } from 'react';
import { formatPct, formatPrice, formatUsd } from '../lib/format';
import { distanceToLevel } from '../lib/math';
import {
  pickTopSupports,
  resolveCoins,
  sellEstimate,
} from '../lib/levels';
import { displaySymbol, unitLabel } from '../lib/assets';

export default function SupportPanel({
  levels,
  spot,
  position,
  asset,
  tfSets,
}) {
  const coins = useMemo(
    () => resolveCoins(position, spot),
    [position, spot],
  );
  const { avgCost } = position;
  const sym = displaySymbol(asset);
  const units = unitLabel(asset);

  const rows = useMemo(() => {
    const supports = pickTopSupports(levels, spot, tfSets);
    return supports.map((lvl) => {
      const dist = distanceToLevel(spot, lvl.price);
      const est = sellEstimate(lvl.price, coins, avgCost, spot);
      return { ...lvl, dist, est };
    });
  }, [levels, spot, coins, avgCost, tfSets]);

  return (
    <section className="card">
      <div className="card__head">
        <h2>Support</h2>
        <span className="muted">
          Top {rows.length || 5} floors ·{' '}
          {coins > 0
            ? `${Math.round(coins).toLocaleString()} ${units}`
            : `no ${units}`}
        </span>
      </div>

      <p className="hint">
        <strong>Support</strong> = prices that have often held as a floor —
        buyers showed up. Showing the <strong>5 most important</strong> levels
        (nearest structural, short-term, and longer 6M / 1Y / max lows when
        available). Suggested stops use this same short list. “Profit” columns
        imagine selling the whole {sym} holding at that level vs what you paid
        ({formatPrice(avgCost)}) and vs today’s spot.
      </p>

      {!levels?.length && (
        <p className="muted">Waiting for daily history to compute supports…</p>
      )}

      {levels?.length > 0 && !rows.length && (
        <p className="muted">No clear supports below spot in this lookback.</p>
      )}

      {rows.length > 0 && (
        <ol className="sr-list">
          {rows.map((row) => (
            <li key={row.id} className="sr-item sr-item--support">
              <div className="sr-item__top">
                <div>
                  <strong className="sr-item__label">{row.friendlyLabel}</strong>
                  <div className="sr-item__price mono">
                    {formatPrice(row.price)}
                  </div>
                </div>
                <div className="sr-item__dist mono neg">
                  {row.dist == null ? '—' : formatPct(row.dist, 1)}
                  <span className="muted small"> below</span>
                </div>
              </div>
              <p className="sr-item__why">{row.why}</p>
              <div className="sr-item__meta">
                <span
                  className={
                    row.est == null
                      ? 'muted'
                      : row.est.profitVsCost >= 0
                        ? 'pos'
                        : 'neg'
                  }
                >
                  {row.est
                    ? `${formatUsd(row.est.profitVsCost, {
                        sign: true,
                        decimals: 0,
                      })} vs cost`
                    : '— vs cost'}
                </span>
                <span className="muted">·</span>
                <span
                  className={
                    row.est?.gainVsSpot == null
                      ? 'muted'
                      : row.est.gainVsSpot >= 0
                        ? 'pos'
                        : 'neg'
                  }
                >
                  {row.est?.gainVsSpot == null
                    ? '— vs spot'
                    : `${formatUsd(row.est.gainVsSpot, {
                        sign: true,
                        decimals: 0,
                      })} vs spot`}
                </span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
