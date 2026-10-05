import { useMemo } from 'react';
import { formatCoins, formatPct, formatPrice } from '../lib/format';
import { hasEnteredPosition, positionMetrics } from '../lib/math';
import { resolveCoins, suggestStops } from '../lib/levels';
import { avgCostHint, displaySymbol, holdingFieldLabel, unitLabel } from '../lib/assets';

const usd0 = (n, sign = false) => {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Math.round(Number(n));
  const s = `$${Math.abs(v).toLocaleString('en-US')}`;
  return v < 0 ? `−${s}` : sign && v > 0 ? `+${s}` : s;
};
const tone = (n) => (n == null || !Number.isFinite(Number(n)) ? '' : n >= 0 ? 'pos' : 'neg');

/**
 * Research right rail: "Your <SYM> position" in one compact, sticky panel.
 * Inputs in a 2-column grid, key outputs as whole dollars, and the old
 * "What this position looks like" folded into a short summary at the bottom.
 */
export default function PositionRail({ position, spot, asset, onChange, loaded = true, status = 'idle', error = null, headerAction = null, levels = null, tfSets = null, major = null, children = null }) {
  const sym = displaySymbol(asset);
  const units = unitLabel(asset);
  const m = useMemo(() => positionMetrics(position.coins, position.avgCost, spot, position.targetPrice), [position.coins, position.avgCost, position.targetPrice, spot]);
  const stop = useMemo(() => {
    const coins = resolveCoins(position, spot);
    if (major?.holdingStop && spot > 0) {
      // v2: the wide holding stop (nearest major support − 1 weekly ATR)
      const px = major.holdingStop.price;
      return { price: px, riskVsSpot: coins > 0 ? coins * (px - spot) : null, distPct: (px / spot - 1) * 100 };
    }
    const { candidates, primaryId } = suggestStops(levels, spot, coins, position.avgCost, tfSets);
    return candidates.find((c) => c.id === primaryId) || null;
  }, [levels, spot, position, tfSets, major]);
  const has = hasEnteredPosition(position.coins, position.avgCost);
  const handle = (key, raw) => {
    const n = parseFloat(raw);
    onChange({ ...position, [key]: Number.isFinite(n) ? n : 0 });
  };
  const fields = [
    { key: 'coins', label: holdingFieldLabel(asset), hint: `How many ${units} of ${sym} you own`, step: asset?.type === 'stock' ? 0.01 : 1, synced: true },
    { key: 'avgCost', label: 'Avg cost', hint: avgCostHint(asset), step: 'any', synced: true },
    { key: 'targetPrice', label: 'Target price', hint: 'Where you’d take profit', step: 'any' },
  ];
  const sync = !loaded ? 'Loading…' : status === 'error' ? `Not saved: ${error || 'error'}` : status === 'saving' || status === 'pending' ? 'Saving…' : status === 'saved' ? 'Saved' : 'Synced with Positions';

  return (
    <section className="card prail">
      <div className="prail__head">
        <h2>Your {sym} position</h2>
        {headerAction}
      </div>
      <p className={`prail__sync small ${status === 'error' ? 'neg' : 'muted'}`} role="status">
        {sync}
      </p>

      <div className="prail__inputs">
        {fields.map(({ key, label, hint, step, synced }) => (
          <label key={key} className="prail__field" title={hint}>
            <span className="small muted">{label}</span>
            <input type="number" step={step} min="0" value={position[key]} disabled={synced && !loaded} onChange={(e) => handle(key, e.target.value)} />
          </label>
        ))}
        <div className="prail__field prail__field--ro" title="Holding × average cost">
          <span className="small muted">Cost basis</span>
          <span className="mono">{usd0(m.costBasis)}</span>
        </div>
      </div>

      <dl className="prail__kpis">
        <div>
          <dt>Value</dt>
          <dd className="mono">{spot != null ? usd0(m.positionValue) : '—'}</dd>
        </div>
        <div>
          <dt>P/L</dt>
          <dd className={`mono ${tone(m.unrealizedPnl)}`}>
            {m.costBasis > 0 ? usd0(m.unrealizedPnl, true) : '—'}
            {m.unrealizedPnlPct != null ? <span className="prail__sub">{formatPct(m.unrealizedPnlPct, 1)}</span> : null}
          </dd>
        </div>
        <div>
          <dt>At target {position.targetPrice > 0 ? <span className="mono">{formatPrice(position.targetPrice)}</span> : null}</dt>
          <dd className="mono">
            {m.atTargetValue != null ? usd0(m.atTargetValue) : '—'}
            {m.atTargetPnl != null ? <span className={`prail__sub ${tone(m.atTargetPnl)}`}>{usd0(m.atTargetPnl, true)}</span> : null}
          </dd>
        </div>
        <div title={major ? "Loss from today's price if the holding stop (nearest major support minus 1 weekly ATR) is hit" : "Loss from today's price if the suggested stop (nearest meaningful Top support) is hit"}>
          <dt>Risk {stop ? <span className="mono">to {formatPrice(stop.price)}</span> : null}</dt>
          <dd className="mono neg">
            {stop && stop.riskVsSpot != null ? usd0(stop.riskVsSpot) : '—'}
            {stop ? <span className="prail__sub">{formatPct(stop.distPct, 1)}</span> : null}
          </dd>
        </div>
      </dl>

      {children}

      <details className="prail__summary">
        <summary className="small">What this position looks like</summary>
        <p className="small">
          {has ? (
            <>
              You hold <strong>{formatCoins(m.coins, asset?.type === 'stock' ? 2 : 0)} {units}</strong> of {sym} at <strong>{formatPrice(position.avgCost)}</strong> avg, worth{' '}
              <strong>{spot != null ? usd0(m.positionValue) : '—'}</strong> now{m.costBasis > 0 ? <> (<span className={tone(m.unrealizedPnl)}>{usd0(m.unrealizedPnl, true)}</span>)</> : null}.{' '}
              {m.atTargetValue != null ? (
                <>
                  At your {formatPrice(position.targetPrice)} target it would be worth <strong>{usd0(m.atTargetValue)}</strong>
                  {m.atTargetPnl != null ? <> (<span className={tone(m.atTargetPnl)}>{usd0(m.atTargetPnl, true)}</span> / {formatPct(m.atTargetPnlPct, 0)})</> : null}.
                </>
              ) : (
                'Set a target to see the outcome.'
              )}
            </>
          ) : (
            <>Enter your holding and average cost to see value, P/L and risk.</>
          )}
        </p>
      </details>
    </section>
  );
}
