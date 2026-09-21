import { useMemo } from 'react';
import { formatPct, formatPrice, formatUsd } from '../lib/format';
import { distanceToLevel } from '../lib/math';
import {
  resolveCoins,
  sellEstimate,
  supportLevels,
} from '../lib/levels';
import { displaySymbol, unitLabel } from '../lib/assets';

export default function SupportPanel({ levels, spot, position, asset }) {
  const coins = useMemo(
    () => resolveCoins(position, spot),
    [position, spot],
  );
  const { avgCost } = position;
  const sym = displaySymbol(asset);
  const units = unitLabel(asset);

  const rows = useMemo(() => {
    const supports = supportLevels(levels, spot);
    return supports.map((lvl) => {
      const dist = distanceToLevel(spot, lvl.price);
      const est = sellEstimate(lvl.price, coins, avgCost, spot);
      return { ...lvl, dist, est };
    });
  }, [levels, spot, coins, avgCost]);

  return (
    <section className="card">
      <div className="card__head">
        <h2>Support</h2>
        <span className="muted">
          Floors below spot ·{' '}
          {coins > 0
            ? `${Math.round(coins).toLocaleString()} ${units}`
            : `no ${units}`}
        </span>
      </div>

      <p className="hint">
        <strong>Support</strong> = prices that have often held as a floor —
        buyers showed up. Suggested stops (below) use these levels. “Profit”
        columns imagine selling the whole {sym} holding at that level vs what
        you paid ({formatPrice(avgCost)}) and vs today’s spot.
      </p>

      {!levels?.length && (
        <p className="muted">Waiting for daily history to compute supports…</p>
      )}

      {levels?.length > 0 && !rows.length && (
        <p className="muted">No clear supports below spot in this lookback.</p>
      )}

      {rows.length > 0 && (
        <div className="table-wrap">
          <table className="table table--sr">
            <thead>
              <tr>
                <th>Level</th>
                <th>Price</th>
                <th>Below spot</th>
                <th>P&amp;L vs cost</th>
                <th>vs spot</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.name}</td>
                  <td className="mono">
                    <strong>{formatPrice(row.price)}</strong>
                  </td>
                  <td className="mono neg">
                    {row.dist == null ? '—' : formatPct(row.dist, 1)}
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
                    {row.est?.profitPctVsCost != null && (
                      <div className="muted small mono">
                        {formatPct(row.est.profitPctVsCost, 1)}
                      </div>
                    )}
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
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
