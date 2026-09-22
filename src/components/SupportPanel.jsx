import { useMemo } from 'react';
import { formatPct, formatPrice } from '../lib/format';
import { riskFromHereCopy } from '../lib/levelCopy';
import { distanceToLevel, hasEnteredPosition } from '../lib/math';
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
  const hasPos = hasEnteredPosition(coins, avgCost);
  const sym = displaySymbol(asset);
  const units = unitLabel(asset);

  const rows = useMemo(() => {
    const supports = pickTopSupports(levels, spot, tfSets);
    return supports.map((lvl) => {
      const dist = distanceToLevel(spot, lvl.price);
      const est = hasPos
        ? sellEstimate(lvl.price, coins, avgCost, spot)
        : null;
      return { ...lvl, dist, est };
    });
  }, [levels, spot, coins, avgCost, tfSets, hasPos]);

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
        available). Suggested stops use this same short list.{' '}
        {hasPos ? (
          <>
            Dollar risk is vs <strong>your average cost</strong> for the whole{' '}
            {sym} holding (what you’d be up or down vs what you paid if that
            floor hits).
          </>
        ) : (
          <>
            No holding entered — showing <strong>percent below today</strong>{' '}
            only (no made-up dollar amounts).
          </>
        )}
      </p>

      {!levels?.length && (
        <p className="muted">Waiting for daily history to compute supports…</p>
      )}

      {levels?.length > 0 && !rows.length && (
        <p className="muted">No clear supports below spot in this lookback.</p>
      )}

      {rows.length > 0 && (
        <ol className="sr-list">
          {rows.map((row) => {
            const usdVsCost = row.est?.profitVsCost ?? null;
            const pctVsCost = row.est?.profitPctVsCost ?? null;
            const copy = riskFromHereCopy({
              hasPosition: hasPos,
              usdVsCost,
              pctVsCost,
              pctFromSpot: row.dist,
            });
            const toneClass =
              hasPos && usdVsCost != null
                ? usdVsCost >= 0
                  ? 'pos'
                  : 'neg'
                : row.dist == null
                  ? 'muted'
                  : 'neg';
            return (
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
                  <span className={toneClass}>{copy}</span>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
