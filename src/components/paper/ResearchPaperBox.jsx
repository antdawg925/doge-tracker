import { useCallback, useEffect, useState } from 'react';
import ModePill from '../common/ModePill.jsx';
import PaperTradeForm from './PaperTradeForm.jsx';
import { formatPrice, formatUsd } from '../../lib/format';
import { closePaperIdea, ideaPnl, listPaperIdeas } from '../../lib/paperIdeas.js';

const tone = (n) => (n == null || n === 0 ? '' : n > 0 ? 'pos' : 'neg');

/** Research: violet Paper trade ticket (prefilled from the levels) + this symbol's open paper ideas. */
export default function ResearchPaperBox({ asset, spot, major, enabled = true }) {
  const [ideas, setIdeas] = useState([]);
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState('');
  const sym = String(asset?.symbol || '').toUpperCase();
  const load = useCallback(() => {
    if (!enabled || !sym) return;
    listPaperIdeas({ symbol: sym })
      .then((l) => setIdeas(l.filter((i) => i.status === 'open')))
      .catch(() => setIdeas([]));
  }, [sym, enabled]);
  useEffect(() => {
    setOpen(false);
    setMsg('');
    load();
  }, [load]);
  if (!enabled || !asset) return null;

  const suggest = (side) => {
    if (!(spot > 0)) return {};
    const atr = major?.atrW || 0;
    const r1 = major?.resistances?.[0]?.price;
    const s1 = major?.supports?.[0]?.price;
    return side === 'short'
      ? { entry: spot, stop: r1 ? r1 + atr : atr ? spot + 2 * atr : null, target: s1 ?? null }
      : { entry: spot, stop: major?.holdingStop?.price ?? null, target: r1 ?? null };
  };

  return (
    <section className="card rpaper mode-card--paper">
      <div className="rpaper__head">
        <h2>
          <ModePill mode="paper" /> Paper ideas
        </h2>
        <button type="button" className="btn btn--paper" onClick={() => (setOpen((v) => !v), setMsg(''))} aria-expanded={open}>
          {open ? 'Close ticket' : 'Paper trade'}
        </button>
      </div>
      {open ? (
        <PaperTradeForm
          asset={asset}
          suggest={suggest}
          source="research"
          onSaved={(i) => {
            setOpen(false);
            setMsg(`Saved: paper ${i.side} ${i.qty} ${i.symbol} @ ${formatPrice(i.entry_price)}`);
            load();
          }}
        />
      ) : null}
      {msg ? <p className="small rpaper__msg">{msg}</p> : null}
      {ideas.length ? (
        <ul className="rpaper__list">
          {ideas.map((i) => {
            const { pnl } = ideaPnl(i, spot);
            return (
              <li key={i.id} className="small">
                <span className="mono">
                  {i.side === 'short' ? 'Short' : 'Long'} {i.qty} @ {formatPrice(i.entry_price)}
                </span>
                <span className={`mono ${tone(pnl)}`}>{formatUsd(pnl, { sign: true, decimals: 2 })}</span>
                <button
                  type="button"
                  className="stk-linkbtn"
                  disabled={!(spot > 0)}
                  title={`Close at the live price ${formatPrice(spot)}`}
                  onClick={async () => {
                    if (!window.confirm(`Close this paper ${i.symbol} idea at ${formatPrice(spot)}?`)) return;
                    await closePaperIdea(i.id, spot).catch((e) => setMsg(e.message));
                    load();
                  }}
                >
                  Close
                </button>
              </li>
            );
          })}
        </ul>
      ) : !open && !msg ? (
        <p className="small muted">Track a {sym} idea with no real money. Entry, stop and target come from the levels.</p>
      ) : null}
    </section>
  );
}
