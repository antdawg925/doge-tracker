import { formatUsd, formatPct } from '../lib/format';
import { allocationSplit, targetProgress } from '../lib/math';

export default function CoreSleeve({ position }) {
  const { dogeValue, coreUsd, sleeveUsd, targetDogeUsd, targetPrice } = position;
  const split = allocationSplit(dogeValue, coreUsd, sleeveUsd);
  const progress = targetProgress(dogeValue, targetDogeUsd);
  const remaining = Math.max(0, targetDogeUsd - dogeValue);

  return (
    <section className="card">
      <div className="card__head">
        <h2>Core vs vol sleeve</h2>
        <span className="muted">Target {formatUsd(targetDogeUsd)} DOGE</span>
      </div>

      <div className="split-visual" aria-hidden>
        <div
          className="split-visual__core"
          style={{ flex: Math.max(split.corePct, 1) }}
          title="Core"
        />
        <div
          className="split-visual__sleeve"
          style={{ flex: Math.max(split.sleevePct, 1) }}
          title="Sleeve"
        />
      </div>
      <div className="split-legend">
        <span>
          <i className="dot dot--core" /> Core {formatPct(split.corePct, 0)} · plan{' '}
          {formatUsd(coreUsd)}
        </span>
        <span>
          <i className="dot dot--sleeve" /> Sleeve {formatPct(split.sleevePct, 0)} · plan{' '}
          {formatUsd(sleeveUsd)}
        </span>
      </div>

      <p className="hint">
        Core: hold ≤1 year toward {formatUsd(targetPrice, { decimals: 2 })}. Sleeve: trade the
        range. Current DOGE MTM split by planned weights.
      </p>

      <div className="progress-block">
        <div className="bar-row__label">
          <span>Progress to ${targetDogeUsd.toLocaleString()} book</span>
          <span>
            {formatUsd(dogeValue)} / {formatUsd(targetDogeUsd)} ({progress.toFixed(0)}%)
          </span>
        </div>
        <div className="bar bar--lg">
          <div className="bar__fill bar__fill--doge" style={{ width: `${progress}%` }} />
        </div>
        <p className="muted small">
          Remaining to target: {formatUsd(remaining)}
          {remaining > 0 ? ' (deploy via ladder / cash)' : ' — target reached'}
        </p>
      </div>
    </section>
  );
}
