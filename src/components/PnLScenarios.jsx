import { PN_L_LEVELS } from '../lib/defaults';
import { formatPct, formatPrice, formatUsd } from '../lib/format';
import { scenarioRow } from '../lib/math';

export default function PnLScenarios({ position, spot }) {
  const {
    dogeValue,
    avgCost,
    coreUsd,
    sleeveUsd,
    cashUsd,
    accountSize,
  } = position;

  const rows = PN_L_LEVELS.map((level) =>
    scenarioRow(
      spot,
      level,
      dogeValue,
      avgCost,
      coreUsd,
      sleeveUsd,
      cashUsd,
      accountSize,
    ),
  ).filter(Boolean);

  return (
    <section className="card">
      <div className="card__head">
        <h2>P&amp;L scenarios</h2>
        <span className="muted">
          Mark-to-market vs avg cost {formatPrice(avgCost)}
        </span>
      </div>

      {!spot && (
        <p className="muted">Waiting for live spot to compute scenarios…</p>
      )}

      {spot && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Mark</th>
                <th>Core P&amp;L</th>
                <th>Sleeve P&amp;L</th>
                <th>Total P&amp;L</th>
                <th>DOGE value</th>
                <th>Account %</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.isSpot ? 'spot' : row.mark} className={row.isSpot ? 'row--active' : ''}>
                  <td>
                    <strong>
                      {row.isSpot ? 'Spot' : formatPrice(row.mark)}
                    </strong>
                    {row.isSpot && (
                      <div className="muted small mono">{formatPrice(row.mark)}</div>
                    )}
                  </td>
                  <td className={row.corePnl >= 0 ? 'pos' : 'neg'}>
                    {formatUsd(row.corePnl, { sign: true, decimals: 0 })}
                  </td>
                  <td className={row.sleevePnl >= 0 ? 'pos' : 'neg'}>
                    {formatUsd(row.sleevePnl, { sign: true, decimals: 0 })}
                  </td>
                  <td className={row.totalPnl >= 0 ? 'pos' : 'neg'}>
                    <strong>{formatUsd(row.totalPnl, { sign: true, decimals: 0 })}</strong>
                  </td>
                  <td>{formatUsd(row.dogeMarkValue, { decimals: 0 })}</td>
                  <td className={row.accountPct >= 0 ? 'pos' : 'neg'}>
                    {formatPct(row.accountPct, 1)}
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
