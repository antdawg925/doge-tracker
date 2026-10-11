import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { fetchYahooChart } from '../../lib/yahoo.js';
import { formatPrice } from '../../lib/format';

const usd = (n) => (n == null || !Number.isFinite(n) ? '—' : `$${Math.abs(n) >= 100 ? Math.round(n).toLocaleString('en-US') : n.toFixed(2)}`);
const rp = (v) => (v >= 1 ? Number(v.toFixed(2)) : Number(v.toFixed(5)));

/** Current $ risk for a stop: shares × distance from entry to stop in the losing direction. */
export const riskFor = (it, stop = it.stop) => (stop > 0 && it.entry > 0 && it.shares > 0 ? Math.max(0, (it.side === 'short' ? stop - it.entry : it.entry - stop) * it.shares) : null);

/** New stop for a hard $ loss cap: entry ∓ risk / shares (long below, short above). Shares never change. */
export const stopFor = (it, risk) => rp(it.side === 'short' ? it.entry + risk / it.shares : it.entry - risk / it.shares);

/** 14-day ATR from Yahoo daily candles (stocks; crypto via SYM-USD). */
function useAtr(symbol, assetType, on) {
  const [atr, setAtr] = useState(null);
  useEffect(() => {
    if (!on || !symbol) return undefined;
    const ac = new AbortController();
    fetchYahooChart(assetType === 'crypto' ? `${symbol}-USD` : symbol, '3mo', { signal: ac.signal, interval: '1d' })
      .then(({ bars }) => {
        const b = bars.slice(-15);
        let s = 0;
        let n = 0;
        for (let i = 1; i < b.length; i += 1) {
          s += Math.max(b[i].high - b[i].low, Math.abs(b[i].high - b[i - 1].close), Math.abs(b[i].low - b[i - 1].close));
          n += 1;
        }
        setAtr(n ? s / n : null);
      })
      .catch(() => setAtr(null));
    return () => ac.abort();
  }, [symbol, assetType, on]);
  return atr;
}

function Confirm({ it, risk, onCancel, onSave }) {
  const atr = useAtr(it.symbol, it.assetType, true);
  const [loosenOk, setLoosenOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const short = it.side === 'short';
  const newStop = stopFor(it, risk);
  const oldRisk = riskFor(it);
  const px = it.price;
  const looser = it.stop > 0 && (short ? newStop > it.stop : newStop < it.stop);
  const beyond = px > 0 && (short ? newStop <= px : newStop >= px);
  const dist = px > 0 ? Math.abs(px - newStop) : null;
  const near = atr && dist != null && !beyond && dist < atr;
  const botTightenOnly = it.kind === 'bot' && looser;
  const tsla = it.symbol === 'TSLA' && it.kind === 'bot';
  const can = !(looser && !loosenOk) && !botTightenOnly && !tsla && newStop > 0;
  const save = async () => {
    setBusy(true);
    setErr('');
    try {
      await onSave(newStop, risk);
    } catch (e) {
      setErr(e?.message || 'Save failed');
      setBusy(false);
    }
  };
  // Portal: table rows use filter on hover, which would trap a position:fixed modal inside the row.
  return createPortal(
    <div className="rk-modal" role="dialog" aria-label={`Change risk for ${it.symbol}`}>
      <button type="button" className="rk-modal__scrim" aria-label="Cancel" onClick={onCancel} />
      <div className="rk-modal__card card">
        <h3>
          Risk $ · {it.symbol} <span className="muted small">{short ? 'short' : 'long'} {it.shares} sh @ {formatPrice(it.entry)}</span>
        </h3>
        <dl className="rk-grid">
          <dt>Stop</dt>
          <dd className="mono">
            {it.stop > 0 ? formatPrice(it.stop) : 'none'} → <strong className="neg">{formatPrice(newStop)}</strong>
          </dd>
          <dt>Risk</dt>
          <dd className="mono">
            {usd(oldRisk)} → <strong>{usd(risk)}</strong>
          </dd>
          <dt>Price now</dt>
          <dd className="mono">{px > 0 ? formatPrice(px) : '—'}</dd>
          <dt>To new stop</dt>
          <dd className="mono">{dist != null ? `${usd(dist)}/sh · ${((dist / px) * 100).toFixed(1)}%` : '—'}</dd>
        </dl>
        <ul className="rk-warn small">
          {looser ? (
            <li className="neg">
              Looser stop ({short ? 'moves up' : 'moves down'} from {formatPrice(it.stop)}). Your rule: stops only tighten.
              {botTightenOnly ? ' The bot only tightens plan stops, so this can’t be saved here.' : null}
            </li>
          ) : null}
          {beyond ? <li className="neg">New stop is already {short ? 'below' : 'above'} the current price: it would trigger immediately.</li> : null}
          {near ? <li className="dp-warn">Within 1 ATR ({usd(atr)}) of price: likely shakeout.</li> : null}
          {it.kind === 'bot' && it.live ? <li className="dp-warn">Live Schwab plan: the bot’s stop updates now; the Schwab order moves only in market hours with Live on. TSLA is never touched.</li> : null}
          {it.kind === 'bot' && !it.live ? <li className="muted">Bot plan (not live): updates the bot’s stop; nothing is sent to Schwab.</li> : null}
          {it.kind === 'real' ? <li className="muted">Tracking only: no order is placed or moved for this holding.</li> : null}
          {tsla ? <li className="neg">TSLA is never touched by the bot.</li> : null}
        </ul>
        {looser && !botTightenOnly ? (
          <label className="rk-loosen small">
            <input type="checkbox" checked={loosenOk} onChange={(e) => setLoosenOk(e.target.checked)} /> Loosen anyway
          </label>
        ) : null}
        {err ? <p className="small neg">{err}</p> : null}
        <div className="rk-btns">
          <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" onClick={save} disabled={busy || !can}>
            {busy ? 'Saving…' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Editable Risk $ for one open position. it = { kind: 'real'|'paper'|'bot', symbol, assetType, side, shares,
 * entry, stop, price, live }. Nothing saves until Confirm in the modal; onSave(newStop, newRisk).
 */
export default function RiskEdit({ it, onSave }) {
  const cur = riskFor(it);
  const [val, setVal] = useState(cur != null ? String(Math.round(cur)) : '');
  const [ask, setAsk] = useState(null);
  useEffect(() => setVal(cur != null ? String(Math.round(cur)) : ''), [cur]);
  if (!(it.shares > 0) || !(it.entry > 0)) return <span className="muted small">—</span>;
  const open = () => {
    const r = Number(val);
    if (!(r > 0)) return setVal(cur != null ? String(Math.round(cur)) : '');
    if (cur != null && Math.abs(r - cur) < 0.5) return undefined;
    setAsk(r);
    return undefined;
  };
  return (
    <span className="rk" onClick={(e) => e.stopPropagation()}>
      <span className="rk__in">
        $
        <input
          type="number"
          min="1"
          step="1"
          inputMode="numeric"
          value={val}
          placeholder="set"
          aria-label={`Risk $ for ${it.symbol}`}
          title={it.stop > 0 ? `Stop ${formatPrice(it.stop)} · hard $ loss cap for the whole position` : 'Hard $ loss cap for the whole position (sets the stop)'}
          onChange={(e) => setVal(e.target.value)}
          onBlur={open}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
      </span>
      {it.stop > 0 ? <span className="rk__stop mono small muted">stop {formatPrice(it.stop)}</span> : null}
      {ask != null ? (
        <Confirm
          it={it}
          risk={ask}
          onCancel={() => {
            setAsk(null);
            setVal(cur != null ? String(Math.round(cur)) : '');
          }}
          onSave={async (stop, risk) => {
            await onSave(stop, risk);
            setAsk(null);
          }}
        />
      ) : null}
    </span>
  );
}
