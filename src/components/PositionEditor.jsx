import { useMemo } from 'react';
import { formatCoins, formatPct, formatPrice, formatUsd } from '../lib/format';
import { positionMetrics } from '../lib/math';

const FIELDS = [
  {
    key: 'coins',
    label: 'DOGE holding',
    hint: 'How many coins you own',
    step: 1,
  },
  {
    key: 'avgCost',
    label: 'Average cost',
    hint: '$ per DOGE you paid',
    step: 0.001,
  },
  {
    key: 'targetPrice',
    label: 'Target price',
    hint: 'Where you’d take profit',
    step: 0.01,
  },
];

export default function PositionEditor({ position, spot, onChange, onReset }) {
  const handle = (key, raw) => {
    const n = parseFloat(raw);
    onChange({ ...position, [key]: Number.isFinite(n) ? n : 0 });
  };

  const m = useMemo(
    () =>
      positionMetrics(
        position.coins,
        position.avgCost,
        spot,
        position.targetPrice,
      ),
    [position.coins, position.avgCost, position.targetPrice, spot],
  );

  return (
    <section className="card">
      <div className="card__head">
        <h2>Your position</h2>
        <button type="button" className="btn btn--ghost" onClick={onReset}>
          Reset
        </button>
      </div>

      <p className="hint">
        Three numbers tell the story: what you hold, what you paid, and where
        you’d take profit. Saved in this browser.
      </p>

      <div className="form-grid form-grid--simple">
        {FIELDS.map(({ key, label, hint, step }) => (
          <label key={key} className="field">
            <span>{label}</span>
            <input
              type="number"
              step={step}
              min="0"
              value={position[key]}
              onChange={(e) => handle(key, e.target.value)}
            />
            <span className="field__hint">{hint}</span>
          </label>
        ))}
      </div>

      <div className="derived">
        <h3 className="derived__title">At today’s price</h3>
        <dl className="derived__list">
          <div>
            <dt>Position value</dt>
            <dd className="mono">
              {spot != null ? formatUsd(m.positionValue, { decimals: 0 }) : '—'}
            </dd>
          </div>
          <div>
            <dt>Cost basis</dt>
            <dd className="mono">{formatUsd(m.costBasis, { decimals: 0 })}</dd>
          </div>
          <div>
            <dt>Unrealized P&amp;L</dt>
            <dd
              className={`mono ${
                m.unrealizedPnlPct == null
                  ? ''
                  : m.unrealizedPnl >= 0
                    ? 'pos'
                    : 'neg'
              }`}
            >
              {m.costBasis > 0
                ? `${formatUsd(m.unrealizedPnl, {
                    sign: true,
                    decimals: 0,
                  })} (${formatPct(m.unrealizedPnlPct, 1)})`
                : '—'}
            </dd>
          </div>
        </dl>

        <h3 className="derived__title">If target is hit</h3>
        <dl className="derived__list">
          <div>
            <dt>Value at {formatPrice(position.targetPrice)}</dt>
            <dd className="mono">
              {m.atTargetValue != null
                ? formatUsd(m.atTargetValue, { decimals: 0 })
                : '—'}
            </dd>
          </div>
          <div>
            <dt>P&amp;L vs cost</dt>
            <dd
              className={`mono ${
                m.atTargetPnl == null
                  ? ''
                  : m.atTargetPnl >= 0
                    ? 'pos'
                    : 'neg'
              }`}
            >
              {m.atTargetPnl != null
                ? `${formatUsd(m.atTargetPnl, {
                    sign: true,
                    decimals: 0,
                  })} (${formatPct(m.atTargetPnlPct, 1)})`
                : '—'}
            </dd>
          </div>
          <div>
            <dt>Holding</dt>
            <dd className="mono">{formatCoins(m.coins)} DOGE</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
