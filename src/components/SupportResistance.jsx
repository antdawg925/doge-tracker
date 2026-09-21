import { useMemo } from 'react';
import { formatPct, formatPrice, formatUsd } from '../lib/format';
import { distanceToLevel } from '../lib/math';
import { resolveCoins, sellEstimate } from '../lib/levels';

export default function SupportResistance({ levels, spot, position }) {
  const coins = useMemo(
    () => resolveCoins(position, spot),
    [position, spot],
  );
  const { avgCost } = position;

  const rows = useMemo(
    () =>
      (levels || []).map((lvl) => {
        const dist = distanceToLevel(spot, lvl.price);
        const est = sellEstimate(lvl.price, coins, avgCost, spot);
        return { ...lvl, dist, est };
      }),
    [levels, spot, coins, avgCost],
  );

  return (
    <section className="card">
      <div className="card__head">
        <h2>Support &amp; resistance</h2>
        <span className="muted">
          Price levels from recent history ·{' '}
          {coins > 0
            ? `${Math.round(coins).toLocaleString()} DOGE`
            : 'no size'}
        </span>
      </div>

      <p className="hint">
        <strong>Support</strong> = prices that have held as a floor.{' '}
        <strong>Resistance</strong> = prices that have capped rallies. The
        “profit” columns imagine selling the whole holding at that level vs
        what you paid ({formatPrice(avgCost)}) and vs today’s spot.
      </p>

      {!levels?.length && (
        <p className="muted">Waiting for daily history to compute levels…</p>
      )}

      {rows.length > 0 && (
        <div className="table-wrap">
          <table className="table table--sr">
            <thead>
              <tr>
                <th>Level</th>
                <th>Price</th>
                <th>Type</th>
                <th>Dist</th>
                <th>Profit vs cost</th>
                <th>vs cost %</th>
                <th>vs spot</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const nearSpot =
                  spot != null && Math.abs(row.price - spot) / spot < 0.005;
                return (
                  <tr
                    key={row.id}
                    className={nearSpot ? 'row--active' : undefined}
                  >
                    <td>{row.name}</td>
                    <td className="mono">
                      <strong>{formatPrice(row.price)}</strong>
                    </td>
                    <td>
                      <span className={`chip chip--${row.type}`}>
                        {row.type}
                      </span>
                    </td>
                    <td className="mono">
                      {row.dist == null
                        ? '—'
                        : `${row.dist > 0 ? '+' : ''}${row.dist.toFixed(1)}%`}
                    </td>
                    <td
                      className={
                        row.est == null
                          ? ''
                          : row.est.profitVsCost >= 0
                            ? 'pos'
                            : 'neg'
                      }
                    >
                      {row.est
                        ? formatUsd(row.est.profitVsCost, {
                            sign: true,
                            decimals: 0,
                          })
                        : '—'}
                    </td>
                    <td
                      className={
                        row.est?.profitPctVsCost == null
                          ? ''
                          : row.est.profitPctVsCost >= 0
                            ? 'pos'
                            : 'neg'
                      }
                    >
                      {formatPct(row.est?.profitPctVsCost, 1)}
                    </td>
                    <td
                      className={
                        row.est?.gainVsSpot == null
                          ? ''
                          : row.est.gainVsSpot >= 0
                            ? 'pos'
                            : 'neg'
                      }
                    >
                      {row.est?.gainVsSpot == null
                        ? '—'
                        : formatUsd(row.est.gainVsSpot, {
                            sign: true,
                            decimals: 0,
                          })}
                      {row.est?.gainPctVsSpot != null && (
                        <div className="muted small mono">
                          {formatPct(row.est.gainPctVsSpot, 1)}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
