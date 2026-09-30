import { useMemo, useState } from 'react';
import { planTrade } from '../../shared/stockEngine.js';
import { etDate } from '../../shared/marketHours.js';

const KEY = 'tsb.research.maxLossUsd';
const px = (n) => (Number.isFinite(n) ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 4 : 2 })}` : '—');
const usd0 = (n) => (Number.isFinite(n) ? `$${Math.round(n).toLocaleString('en-US')}` : '—');

function readRisk() {
  try {
    const v = Number(localStorage.getItem(KEY));
    return Number.isFinite(v) && v > 0 ? String(v) : '100';
  } catch {
    return '100';
  }
}

/**
 * Research rail (stocks): suggested long size for a max loss, using the Stocks tab's long ATR stop.
 * A research suggestion only; nothing is saved to positions.
 */
export default function PositionSizeLine({ asset, bars, spot }) {
  const [risk, setRisk] = useState(readRisk);
  const [nowMs] = useState(() => Date.now());
  const riskUsd = Number(risk);
  const plan = useMemo(() => {
    if (!(spot > 0) || !(riskUsd > 0) || !Array.isArray(bars) || bars.length < 16) return null;
    try {
      const daily = bars.map((b) => ({ ...b, date: etDate(b.t) }));
      return planTrade({ side: 'long', bars: daily, price: spot, riskUsd, nowMs });
    } catch {
      return null;
    }
  }, [bars, spot, riskUsd, nowMs]);
  if (asset?.type !== 'stock') return null;
  return (
    <section className="card size-line" aria-label="Position size suggestion">
      <p className="size-line__text">
        <strong>Position size</strong>{' '}
        <span className="muted small">(suggestion)</span>
        <br />
        At $
        <input
          className="size-line__risk mono"
          type="number"
          min="1"
          step="1"
          inputMode="decimal"
          aria-label="Max loss $"
          value={risk}
          onChange={(e) => {
            setRisk(e.target.value);
            try {
              if (Number(e.target.value) > 0) localStorage.setItem(KEY, String(Number(e.target.value)));
            } catch {
              /* private mode */
            }
          }}
        />{' '}
        max loss:{' '}
        {plan?.shares != null ? (
          <span className="mono">
            ~{plan.shares.toLocaleString('en-US')} shares long (stop {px(plan.stop)}, ~{usd0(plan.cost)} cost)
          </span>
        ) : plan ? (
          <span className="muted">stop {px(plan.stop)}: n/a</span>
        ) : (
          <span className="muted">needs price + daily candles…</span>
        )}
      </p>
      {plan ? (
        <p className="small muted size-line__why">
          Stop = {plan.mult} ATR ({px(plan.atr)}) or the 10-day low; {px(plan.perShare)}/share at risk.
        </p>
      ) : null}
    </section>
  );
}
