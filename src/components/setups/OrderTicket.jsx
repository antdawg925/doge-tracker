import { useEffect, useRef, useState } from 'react';

const newReqId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);
import { authedFetch } from '../../lib/api.js';
import { formatPrice } from '../../lib/format.js';
import { maxGapUpPct } from '../../../shared/stockEngine.js';

const usd = (n) => (n == null || !Number.isFinite(n) ? '—' : `$${Math.round(n).toLocaleString('en-US')}`);
const r2 = (v) => (v >= 1 ? Number(v.toFixed(2)) : Number(v.toFixed(4)));

/** Live bid / ask / last for one symbol (Schwab, read-only). null fields when unavailable. */
function useQuote(symbol) {
  const [q, setQ] = useState(null);
  useEffect(() => {
    let dead = false;
    setQ(null);
    if (!symbol) return undefined;
    authedFetch('/api/schwab/quote', { method: 'POST', body: { symbol } })
      .then((r) => !dead && setQ(r?.available ? r : { available: false }))
      .catch(() => !dead && setQ({ available: false }));
    return () => {
      dead = true;
    };
  }, [symbol]);
  return q;
}

/**
 * Quick order entry for Buy dips / Sell highs: Shares (final, never resized) + Price (live bid for buys,
 * live ask for shorts, else last). Est. risk = shares × |price − stop|, live. Shares are only what he types (no suggested size); empty → 'Enter shares'. Paper and real buttons both get { shares, price }.
 */
export default function OrderTicket({ symbol, side, last, stop, target, onPaper, onReal, realLabel, busy = false, paperBusy = false, blocked = false, note = null, compact = false, dailyBars = null, limitPrice = null, mode = 'both' }) {
  const short = side === 'short';
  const quote = useQuote(symbol);
  const [shares, setShares] = useState('');
  const [price, setPrice] = useState('');
  const [src, setSrc] = useState('');
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    setShares('');
    setTouched(false);
  }, [symbol]);
  // Prefill once the quote arrives (unless he already typed a price).
  const [confirming, setConfirming] = useState(null);
  // One press = one order: an in-flight guard plus one request id per order (server dedupes on it).
  const inFlight = useRef(false);
  const reqId = useRef(newReqId());
  const [sending, setSending] = useState(false);
  const submit = async (fn, o) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    try {
      const done = await fn({ ...o, requestId: reqId.current });
      if (done !== false) {
        reqId.current = newReqId(); // next order = a new, separate confirm
        setConfirming(null);
      }
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  };
  useEffect(() => {
    if (touched) return;
    // Orders are LIMIT orders at the setup's Target price (editable); live bid/ask only as a fallback.
    if (limitPrice > 0) {
      setPrice(String(r2(limitPrice)));
      setSrc('target');
      return;
    }
    const live = short ? quote?.ask : quote?.bid;
    const px = live || quote?.last || last;
    if (px > 0) {
      setPrice(String(r2(px)));
      setSrc(live ? (short ? 'ask' : 'bid') : quote?.last ? 'last' : 'last (delayed)');
    }
  }, [quote, last, short, touched, limitPrice]);

  const sh = Math.floor(Number(shares));
  const px = Number(price);
  const st = Number(stop);
  const per = px > 0 && st > 0 ? Math.abs(px - st) : null;
  const wrongSide = px > 0 && st > 0 && (short ? !(st > px) : !(st < px));
  const risk = sh > 0 && per != null ? sh * per : null;
  const cost = sh > 0 && px > 0 ? sh * px : null;
  const toStop = per != null && px > 0 ? (per / px) * 100 : null;
  const reward = sh > 0 && px > 0 && target > 0 ? sh * (short ? px - target : target - px) : null;
  const ok = sh > 0 && px > 0 && !wrongSide;
  // B14: shorts can gap up through the stop. Gap risk = loss if it opens past the stop by the largest
  // overnight gap-up of the last 60 days (sizing stays his call; shown only).
  const gapPct = short && dailyBars?.length > 1 ? maxGapUpPct(dailyBars) : null;
  const gapRisk = short && gapPct > 0 && sh > 0 && px > 0 && st > 0 ? sh * (st * (1 + gapPct) - px) : null;

  return (
    <div className={`otk${compact ? ' otk--compact' : ''}`}>
      <div className="otk__inputs">
        <label className="otk__f">
          <span className="small muted">Shares</span>
          <input type="number" min="1" step="1" inputMode="numeric" value={shares} placeholder="Enter shares" onChange={(e) => setShares(e.target.value)} />
        </label>
        <label className="otk__f">
          <span className="small muted">
            Price {src ? <span className="otk__src">{touched ? 'yours' : src}</span> : null}
          </span>
          <input
            type="number"
            min="0"
            step="any"
            inputMode="decimal"
            value={price}
            onChange={(e) => {
              setTouched(true);
              setPrice(e.target.value);
            }}
          />
        </label>
      </div>
      <div className="otk__nums">
        <p className="otk__risk">
          Est. risk <strong>{risk != null ? usd(risk) : '—'}</strong>
        </p>
        <p className="otk__total">
          Total <strong>{cost != null ? usd(cost) : '—'}</strong>
        </p>
      </div>
      <p className="small muted otk__sub">
        Stop {formatPrice(st)} · {toStop != null ? `${toStop.toFixed(1)}% to stop` : '—'} · reward {reward != null ? <span className={reward >= 0 ? 'pos' : 'neg'}>{usd(reward)}</span> : '—'} to target
      </p>
      {gapRisk != null ? (
        <p className="small otk__sub" title="If it gaps up past your stop by its largest overnight gap of the last 60 days">
          Gap risk ≈ <strong className="neg">{usd(gapRisk)}</strong> <span className="muted">(if it gaps {(gapPct * 100).toFixed(1)}% over the stop)</span>
        </p>
      ) : null}
      {wrongSide ? <p className="small neg otk__sub">Price must be {short ? 'below the cover stop' : 'above the stop'}.</p> : null}
      <div className="otk__btns">
        {mode !== 'real' ? (
          <button type="button" className="btn btn--paper stk-btn act-btn" disabled={paperBusy || sending || !ok} onClick={() => submit(onPaper, { shares: sh, price: px })} title="Paper limit order (no real money)">
            {paperBusy || sending ? 'Saving…' : !(sh > 0) ? 'Enter shares' : mode === 'paper' ? `Confirm paper ${short ? 'short' : 'buy'} ${sh} sh` : short ? 'Paper short' : 'Paper buy'}
          </button>
        ) : null}
        {mode !== 'paper' ? (
          <button type="button" className={`btn ${short ? 'btn--short' : 'btn--gold'} stk-btn act-btn`} disabled={busy || sending || !ok || blocked} onClick={() => setConfirming({ shares: sh, price: px })}>
            {busy ? 'Saving…' : !(sh > 0) ? 'Enter shares' : realLabel ? realLabel(sh, px) : `${short ? 'Short $' : 'Buy $'} ${sh} sh`}
          </button>
        ) : null}
      </div>
      {note}
      {confirming ? (
        <div className="otk__confirm" role="alertdialog" aria-label="Confirm real order">
          <p className="otk__confirm-head"><strong>REAL ORDER at Schwab, GTC</strong></p>
          <p className="mono">
            {short ? 'SELL SHORT' : 'BUY'} {confirming.shares} {symbol} · LIMIT {formatPrice(confirming.price)}
          </p>
          <p className="small">
            Total <strong>{usd(confirming.shares * confirming.price)}</strong> · Est. risk <strong className="neg">{usd(confirming.shares * Math.abs(confirming.price - st))}</strong> to stop {formatPrice(st)}
          </p>
          <p className="small muted">Sent to Schwab now. Good-till-cancelled; it can only fill in the regular session. Stop is placed after the fill (market hours).</p>
          <div className="otk__btns">
            <button type="button" className="btn btn--ghost stk-btn" onClick={() => setConfirming(null)} disabled={busy || sending}>Back</button>
            <button type="button" className={`btn ${short ? 'btn--short' : 'btn--gold'} stk-btn`} disabled={busy || sending} onClick={() => submit(onReal, confirming)}>
              {busy || sending ? 'Placing…' : `Place ${short ? 'short' : 'buy'} at Schwab`}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
