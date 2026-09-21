import { formatUsd, formatPct } from '../lib/format';

export default function AccountSummary({ position, spot }) {
  const { accountSize, cashUsd, dogeValue, coreUsd, sleeveUsd } = position;
  const dogePct = accountSize > 0 ? (dogeValue / accountSize) * 100 : 0;
  const cashPct = accountSize > 0 ? (cashUsd / accountSize) * 100 : 0;
  const planned = coreUsd + sleeveUsd;
  const plannedPct = accountSize > 0 ? (planned / accountSize) * 100 : 0;

  return (
    <section className="card">
      <div className="card__head">
        <h2>Account summary</h2>
        {spot != null && (
          <span className="muted mono">mark @ {spot.toFixed(4)}</span>
        )}
      </div>

      <div className="stat-grid">
        <div className="stat">
          <span className="stat__label">Account</span>
          <span className="stat__value">{formatUsd(accountSize)}</span>
        </div>
        <div className="stat">
          <span className="stat__label">Cash</span>
          <span className="stat__value">{formatUsd(cashUsd)}</span>
        </div>
        <div className="stat">
          <span className="stat__label">DOGE (MTM)</span>
          <span className="stat__value">{formatUsd(dogeValue)}</span>
        </div>
        <div className="stat">
          <span className="stat__label">Target book</span>
          <span className="stat__value">{formatUsd(coreUsd + sleeveUsd)}</span>
        </div>
      </div>

      <div className="bars">
        <div className="bar-row">
          <div className="bar-row__label">
            <span>DOGE now</span>
            <span>{formatPct(dogePct, 1)}</span>
          </div>
          <div className="bar">
            <div className="bar__fill bar__fill--doge" style={{ width: `${Math.min(100, dogePct)}%` }} />
          </div>
        </div>
        <div className="bar-row">
          <div className="bar-row__label">
            <span>Cash</span>
            <span>{formatPct(cashPct, 1)}</span>
          </div>
          <div className="bar">
            <div className="bar__fill bar__fill--cash" style={{ width: `${Math.min(100, cashPct)}%` }} />
          </div>
        </div>
        <div className="bar-row">
          <div className="bar-row__label">
            <span>Planned DOGE (core+sleeve)</span>
            <span>{formatPct(plannedPct, 1)}</span>
          </div>
          <div className="bar">
            <div className="bar__fill bar__fill--plan" style={{ width: `${Math.min(100, plannedPct)}%` }} />
          </div>
        </div>
      </div>
    </section>
  );
}
