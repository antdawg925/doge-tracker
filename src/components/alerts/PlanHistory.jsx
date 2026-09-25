import { formatPrice } from '../../lib/format.js';

const when = (iso) =>
  new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

/** High / low traded since a timestamp, from the 4h bars we already have. */
function rangeSince(bars, iso) {
  const t = Date.parse(iso);
  if (!bars?.length || !Number.isFinite(t)) return null;
  const covered = t >= bars[0].t;
  let hi = -Infinity;
  let lo = Infinity;
  for (const b of bars) {
    if (b.t + 4 * 3600 * 1000 <= t) continue;
    if (b.high > hi) hi = b.high;
    if (b.low < lo) lo = b.low;
  }
  return Number.isFinite(hi) ? { hi, lo, covered } : null;
}

export default function PlanHistory({ history, bars, onDelete }) {
  return (
    <section className="card dp-history">
      <div className="card__head">
        <h2>Plan history</h2>
        <span className="muted small">{history.length} saved · newest first</span>
      </div>
      {!history.length ? (
        <p className="muted small">
          Each Save adds a dated entry here so you can compare your predicted zones with what price
          actually did.
        </p>
      ) : (
        <ul className="dp-history__list">
          {history.map((h) => {
            const p = h.plan;
            const r = rangeSince(bars, h.savedAt);
            const hitHigh = r && r.hi >= p.highZone.low;
            const hitLow = r && r.lo <= p.lowZone.high;
            return (
              <li key={h.id} className="dp-history__item">
                <div className="dp-history__top">
                  <strong className="small">{when(h.savedAt)}</strong>
                  {h.market?.price ? (
                    <span className="muted small mono">
                      px {formatPrice(h.market.price)} · stop {formatPrice(h.market.effectiveStop)}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className="dp-history__del"
                    aria-label="Delete entry"
                    title="Delete entry"
                    onClick={() => onDelete(h.id)}
                  >
                    ×
                  </button>
                </div>
                <div className="dp-history__vals mono small">
                  <span>sell {formatPrice(p.sellLevel)}</span>
                  <span>buy {formatPrice(p.buyBackLevel)}</span>
                  <span>floor {formatPrice(p.stopFloor)}</span>
                  <span>
                    hi {formatPrice(p.highZone.low)}–{formatPrice(p.highZone.high)}
                  </span>
                  <span>
                    lo {formatPrice(p.lowZone.low)}–{formatPrice(p.lowZone.high)}
                  </span>
                  <span>
                    ATR {p.atrMult}×/{p.tightMult}× @+{p.tightenPct}%
                  </span>
                  <span>
                    {p.corePct}/{p.slicePct}
                  </span>
                </div>
                {r ? (
                  <div className="dp-history__since small">
                    Since: high <span className="mono">{formatPrice(r.hi)}</span>
                    {hitHigh ? <span className="badge badge--hit">high zone hit</span> : null} · low{' '}
                    <span className="mono">{formatPrice(r.lo)}</span>
                    {hitLow ? <span className="badge badge--hit">low zone hit</span> : null}
                    {!r.covered ? <span className="muted"> (last ~120d only)</span> : null}
                  </div>
                ) : null}
                {h.note ? <p className="dp-history__note small">“{h.note}”</p> : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
