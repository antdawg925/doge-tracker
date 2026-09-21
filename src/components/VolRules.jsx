import { VOL_RULES } from '../lib/defaults';
import { formatPrice } from '../lib/format';
import { ladderStatus } from '../lib/math';

export default function VolRules({ spot }) {
  const { sellLow, sellHigh, rebuyLow, rebuyHigh, invalidation } = VOL_RULES;
  const inSell = ladderStatus(spot, sellLow, sellHigh) === 'at';
  const inRebuy = ladderStatus(spot, rebuyLow, rebuyHigh) === 'at';
  const broken = spot != null && spot < invalidation;

  return (
    <section className="card">
      <div className="card__head">
        <h2>Vol sleeve rules</h2>
        <span className="muted">Cheat-sheet</span>
      </div>

      <div className="rules-grid">
        <div className={`rule ${inSell ? 'rule--hot' : ''}`}>
          <span className="rule__tag sell">Sell zone</span>
          <strong>
            {formatPrice(sellLow)} – {formatPrice(sellHigh)}
          </strong>
          <p className="muted small">Trim / take sleeve profits into strength</p>
        </div>
        <div className={`rule ${inRebuy ? 'rule--hot' : ''}`}>
          <span className="rule__tag buy">Rebuy zone</span>
          <strong>
            {formatPrice(rebuyHigh)} – {formatPrice(rebuyLow)}
          </strong>
          <p className="muted small">Reload sleeve on pullbacks toward cost</p>
        </div>
        <div className={`rule ${broken ? 'rule--danger' : ''}`}>
          <span className="rule__tag danger">Invalidation</span>
          <strong>Below {formatPrice(invalidation)}</strong>
          <p className="muted small">
            Weekly break of $0.067–$0.060 — stop adding; reassess thesis
          </p>
        </div>
      </div>
    </section>
  );
}
