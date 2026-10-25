import { useState } from 'react';
import { DOGE_LEVELS, ladderInfo, sellNowCalc } from '../../../shared/levels.js';

/** Read-only helpers on My Bot → DOGE: his level map ladder and a "what if I sell now" calculator. */
const px = (n, d = 4) => (n == null || !Number.isFinite(Number(n)) ? '—' : `$${Number(n).toFixed(d)}`);
const lv = (n) => { const v = Number(n); return `$${Math.round(v * 1000) % 10 ? v.toFixed(3) : v.toFixed(2)}`; };
const usd = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : `$${Math.round(Number(n)).toLocaleString('en-US')}`);
const qty = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : Math.round(Number(n)).toLocaleString('en-US'));

export function LevelLadder({ row, spot }) {
  const s = row?.snapshot || {};
  const price = spot?.price ?? s.price;
  const stopPx = row?.state?.stopPx ?? s.bottom?.price ?? null;
  const L = ladderInfo(price);
  if (!L) return null;
  const snapOn = Boolean(row?.config?.levelSnap);
  return (
    <section className="card mb-card dlv" aria-label="Level map">
      <h2 className="mb-card__title">Level map</h2>
      <p className="small dlv-next">
        {L.next ? (
          <>
            Next level <strong className="mono">{lv(L.next.price)}{L.next.approx ? '~' : ''}</strong>{' '}
            <span className="pos">+{L.next.distPct.toFixed(1)}%</span> · <span className="muted">{L.next.note}</span>
          </>
        ) : (
          'Above the whole level map'
        )}
        {L.below ? (
          <span className="muted">
            {' '}· holding above <span className="mono">{lv(L.below.price)}</span> (−{L.below.distPct.toFixed(1)}%)
          </span>
        ) : null}
      </p>
      <ol className="dlv-list">
        {[...L.rows].reverse().map((r) => {
          const isNext = L.next && r.index === L.next.index;
          const stopHere = stopPx && r.price > stopPx && (r.index === 0 || DOGE_LEVELS[r.index - 1].price <= stopPx);
          return (
            <li key={r.price} className={`dlv-row${r.hit ? ' is-hit' : ''}${isNext ? ' is-next' : ''}`}>
              <span className="mono dlv-px">{lv(r.price)}{r.approx ? '~' : ''}</span>
              <span className={`small mono dlv-d ${r.distPct >= 0 ? 'pos' : 'muted'}`}>{r.distPct >= 0 ? '+' : ''}{r.distPct.toFixed(1)}%</span>
              <span className="small dlv-note">{r.note}{stopHere ? <span className="neg"> · stop {px(stopPx)} under here</span> : null}</span>
            </li>
          );
        })}
      </ol>
      <p className="small muted">Level snap {snapOn ? 'ON' : 'off'} (Your settings → “Snap stop to my levels”). Raises only.</p>
    </section>
  );
}

export function SellNowCalc({ row, spot }) {
  const s = row?.snapshot || {};
  const [pct, setPct] = useState(30);
  const bid = s.bid && spot?.price ? Math.min(s.bid, spot.price) : spot?.price ?? s.bid ?? s.price;
  const stopPx = row?.state?.stopPx ?? s.bottom?.price ?? null;
  const c = sellNowCalc({ doge: s.book?.doge, usd: s.book?.usd, bid, sellPct: pct, feePct: row?.config?.feePct ?? 0.4, slipPct: row?.config?.sellSlipPct ?? 0.5, stopPx });
  return (
    <section className="card mb-card dsc" aria-label="What if I sell now">
      <h2 className="mb-card__title">What if I sell now?</h2>
      {!c ? (
        <p className="small muted">Needs your DOGE balance and a live price.</p>
      ) : (
        <>
          <label className="small dsc-pct">
            Sell <input type="range" min="0" max="100" step="5" value={pct} onChange={(e) => setPct(Number(e.target.value))} aria-label="Sell percent" />{' '}
            <strong className="mono">{pct}%</strong> = {qty(c.sellQty)} DOGE at ~{px(c.fill)}
          </label>
          <dl className="dl-stats dl-stats--small">
            <div>
              <dt>Cash locked now</dt>
              <dd className="pos">{usd(c.cashNow)}</dd>
            </div>
            <div>
              <dt>Runners kept</dt>
              <dd>{qty(c.keepQty)} DOGE</dd>
            </div>
            {c.runnerAt.map((r) => (
              <div key={r.price}>
                <dt>At ${r.price.toFixed(2)}</dt>
                <dd>
                  {usd(r.total)} <span className="small muted">(runners {usd(r.value)} · hold-all {usd(r.holdAll)})</span>
                </dd>
              </div>
            ))}
            {c.stopValue != null ? (
              <div>
                <dt>If the stop hits</dt>
                <dd>
                  {usd(c.stopValue)} <span className="small muted">(hold-all {usd(c.holdStopValue)})</span>
                </dd>
              </div>
            ) : null}
          </dl>
          <p className="small muted">Estimate only: totals include your cash; {row?.config?.feePct ?? 0.4}% fee and {row?.config?.sellSlipPct ?? 0.5}% under the bid. Nothing is placed from here.</p>
        </>
      )}
    </section>
  );
}
