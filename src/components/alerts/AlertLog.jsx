import { formatPrice } from '../../lib/format.js';

const RULE_TONE = {
  stop: 'neg',
  lowZoneOut: 'neg',
  buyBack: 'dp-buy',
  lowZoneIn: 'dp-buy',
  sell: 'pos',
  breakout: 'pos',
  highZoneIn: 'pos',
  highZoneOut: 'pos',
};

export default function AlertLog({ log, rules, ruleState, onClear }) {
  return (
    <section className="card dp-alerts">
      <div className="card__head">
        <h2>Alerts</h2>
        <button type="button" className="btn btn--ghost" disabled={!log.length} onClick={onClear}>
          Clear log
        </button>
      </div>

      <ul className="dp-rules">
        {rules.map((r) => {
          const armed = ruleState?.[r.id]?.armed !== false;
          return (
            <li key={r.id} className={`dp-rule${armed ? '' : ' is-fired'}`}>
              <span className="dp-rule__dot" aria-hidden />
              <span className="dp-rule__label">{r.label}</span>
              <span className="mono">
                {r.dir === 'up' ? '≥' : '≤'} {formatPrice(r.level)}
              </span>
              <span className="muted small">{armed ? 'armed' : 'fired · re-arms on pullback'}</span>
            </li>
          );
        })}
      </ul>

      {!log.length ? (
        <p className="muted small">No alerts yet. Crossings will be logged here with the time and price.</p>
      ) : (
        <ul className="dp-log">
          {log.map((e) => (
            <li key={e.id} className="dp-log__item">
              <span className="dp-log__time muted small mono">
                {new Date(e.at).toLocaleString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </span>
              <span className={`dp-log__title ${RULE_TONE[e.ruleId] || ''}`}>{e.title}</span>
              <span className="dp-log__body muted small">
                {e.body} Price {formatPrice(e.price)}.
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
