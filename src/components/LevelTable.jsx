import { useState } from 'react';

/** Small "i" with the long explanation on hover (title) and tap (toggle). */
export function InfoTip({ text }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="info-tip">
      <button type="button" className="info-tip__i" title={text} aria-label="About this section" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        i
      </button>
      {open ? (
        <span className="info-tip__pop small" role="note">
          {text}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Compact level rows: rank · name (+tag) · price · % away · $ vs avg cost.
 * The long "why" / copy shows on hover (title) and on click (row expands).
 * rows: [{ id, name, tag, tagCls, price, pct, pctCls, usd, usdCls, detail: string[] }]
 */
export default function LevelTable({ rows, label }) {
  const [open, setOpen] = useState(null);
  return (
    <ol className="lvt" aria-label={label}>
      {rows.map((r, i) => {
        const detail = (r.detail || []).filter(Boolean);
        const isOpen = open === r.id;
        return (
          <li key={r.id} className={`lvt__row${r.tag ? ' lvt__row--tag' : ''}${isOpen ? ' is-open' : ''}`}>
            <button type="button" className="lvt__btn" title={detail.join('\n')} aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : r.id)}>
              <span className="lvt__rank">{i + 1}</span>
              <span className="lvt__name">
                {r.name}
                {r.tag ? <span className={`lvt__tag ${r.tagCls || ''}`}>{r.tag}</span> : null}
              </span>
              <span className="lvt__px mono">{r.price}</span>
              <span className={`lvt__pct mono ${r.pctCls || ''}`}>{r.pct}</span>
              <span className={`lvt__usd mono ${r.usdCls || 'muted'}`}>{r.usd ?? ''}</span>
            </button>
            {isOpen && detail.length ? (
              <div className="lvt__detail small">
                {detail.map((d, j) => (
                  <p key={j}>{d}</p>
                ))}
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
