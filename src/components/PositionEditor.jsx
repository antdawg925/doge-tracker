import { formatUsd } from '../lib/format';

const FIELDS = [
  { key: 'accountSize', label: 'Account size ($)', step: 100 },
  { key: 'dogeValue', label: 'Current DOGE value ($)', step: 50 },
  { key: 'avgCost', label: 'Avg cost ($/DOGE)', step: 0.001 },
  { key: 'coreUsd', label: 'Core target ($)', step: 100 },
  { key: 'sleeveUsd', label: 'Vol sleeve ($)', step: 100 },
  { key: 'cashUsd', label: 'Cash ($)', step: 100 },
  { key: 'targetDogeUsd', label: 'DOGE book target ($)', step: 500 },
  { key: 'targetPrice', label: 'Core target price ($)', step: 0.01 },
];

export default function PositionEditor({ position, onChange, onReset }) {
  const handle = (key, raw) => {
    const n = parseFloat(raw);
    onChange({ ...position, [key]: Number.isFinite(n) ? n : 0 });
  };

  const sumCheck = position.coreUsd + position.sleeveUsd + position.cashUsd;

  return (
    <section className="card">
      <div className="card__head">
        <h2>Position inputs</h2>
        <button type="button" className="btn btn--ghost" onClick={onReset}>
          Reset defaults
        </button>
      </div>

      <p className="hint">
        Edits persist in localStorage. These are planning defaults — not a live
        brokerage feed.
      </p>

      <div className="form-grid">
        {FIELDS.map(({ key, label, step }) => (
          <label key={key} className="field">
            <span>{label}</span>
            <input
              type="number"
              step={step}
              value={position[key]}
              onChange={(e) => handle(key, e.target.value)}
            />
          </label>
        ))}
      </div>

      <p className="muted small">
        Core + sleeve + cash = {formatUsd(sumCheck)}
        {Math.abs(sumCheck - position.accountSize) > 1 && (
          <span className="warn-inline">
            {' '}
            (differs from account {formatUsd(position.accountSize)})
          </span>
        )}
      </p>
    </section>
  );
}
