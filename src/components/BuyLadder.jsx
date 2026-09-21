import { BUY_LADDER, STOP_ADDING } from '../lib/defaults';
import { formatCoins, formatPct, formatPrice, formatUsd } from '../lib/format';
import { bandMid, coinsFromUsd, distanceToLevel, ladderStatus } from '../lib/math';

export default function BuyLadder({ spot }) {
  return (
    <section className="card">
      <div className="card__head">
        <h2>Buy ladder</h2>
        <span className="muted">Planned deployment from cash</span>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Rung</th>
              <th>Level</th>
              <th>Status</th>
              <th>% away</th>
              <th>Deploy $</th>
              <th>Est. coins</th>
            </tr>
          </thead>
          <tbody>
            {BUY_LADDER.map((rung) => {
              const mid = bandMid(rung.low, rung.high);
              const status = ladderStatus(spot, rung.low, rung.high);
              const dist = distanceToLevel(spot, mid);
              const coins = coinsFromUsd(rung.allocateUsd, mid);
              const levelLabel =
                rung.low === rung.high
                  ? formatPrice(rung.low)
                  : `${formatPrice(rung.low)}–${formatPrice(rung.high)}`;

              return (
                <tr key={rung.id} className={status === 'at' ? 'row--active' : ''}>
                  <td>
                    <strong>{rung.label}</strong>
                    <div className="muted small">{rung.note}</div>
                  </td>
                  <td className="mono">{levelLabel}</td>
                  <td>
                    <span className={`chip chip--${status}`}>{status}</span>
                  </td>
                  <td className="mono">
                    {dist == null ? '—' : formatPct(dist, 1)}
                  </td>
                  <td>{formatUsd(rung.allocateUsd)}</td>
                  <td className="mono">{formatCoins(coins)}</td>
                </tr>
              );
            })}
            <tr className="row--stop">
              <td>
                <strong>{STOP_ADDING.label}</strong>
                <div className="muted small">{STOP_ADDING.note}</div>
              </td>
              <td className="mono">
                {formatPrice(STOP_ADDING.high)}–{formatPrice(STOP_ADDING.low)}
              </td>
              <td colSpan={4}>
                <span className="chip chip--below">invalidation / pause</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}
