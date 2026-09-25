import { useMemo } from 'react';
import { formatCoins, formatPct, formatPrice, formatUsd } from '../lib/format';
import { positionMetrics } from '../lib/math';
import {
  avgCostHint,
  displaySymbol,
  holdingFieldLabel,
  unitLabel,
} from '../lib/assets';

export default function PositionEditor({
  position,
  spot,
  asset,
  onChange,
  loaded = true,
  status = 'idle',
  error = null,
  headerAction = null,
}) {
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

  const units = unitLabel(asset);
  const sym = displaySymbol(asset);

  const fields = [
    {
      key: 'coins',
      label: holdingFieldLabel(asset),
      hint: `How many ${units} of ${sym} you own`,
      step: asset?.type === 'stock' ? 0.01 : 1,
      synced: true,
    },
    {
      key: 'avgCost',
      label: 'Average cost',
      hint: avgCostHint(asset),
      step: 'any',
      synced: true,
    },
    {
      key: 'targetPrice',
      label: 'Target price',
      hint: 'Where you’d take profit',
      step: 'any',
    },
  ];

  return (
    <section className="card">
      <div className="card__head">
        <h2>Your {sym} position</h2>
        {headerAction}
      </div>

      <p className="hint">
        What you hold, what you paid, and where you’d take profit. Holding and
        cost sync with your Positions tab.
        <span
          className={`position-sync${status === 'error' ? ' neg' : ''}`}
          role="status"
        >
          {!loaded
            ? ' Loading…'
            : status === 'error'
              ? ` Not saved: ${error || 'error'}`
              : status === 'saving' || status === 'pending'
                ? ' Saving…'
                : status === 'saved'
                  ? ' Saved.'
                  : ''}
        </span>
      </p>

      <div className="form-grid form-grid--simple">
        {fields.map(({ key, label, hint, step, synced }) => (
          <label key={key} className="field">
            <span>{label}</span>
            <input
              type="number"
              step={step}
              min="0"
              value={position[key]}
              disabled={synced && !loaded}
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
            <dt>P&amp;L vs average cost</dt>
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
            <dd className="mono">
              {formatCoins(m.coins, asset?.type === 'stock' ? 2 : 0)} {units}
            </dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
