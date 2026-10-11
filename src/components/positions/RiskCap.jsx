import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { riskCapHit } from '../../../shared/riskCap.js';

const usd = (n) => (n == null || !Number.isFinite(n) ? '—' : `$${Math.abs(n) >= 100 ? Math.round(n).toLocaleString('en-US') : n.toFixed(2)}`);
const capStr = (c) => (Number(c) > 0 ? String(Number(c)) : '');

/**
 * Per-position emergency Risk cap (kill switch). Separate from the stop: it never moves the stop.
 * Blank = no cap. If the open loss goes above it, the position is halted (red RISK HIT badge).
 * Props: cap, tripped (iso|null), loss (open $ loss ≥ 0 | null), bot (bot-managed: server trips it),
 * symbol, onSave(cap|null), onResume(), onTrip(loss) (UI-only rows: paper / manual holdings).
 */
export default function RiskCap({ cap, tripped, loss, bot, symbol, onSave, onResume, onTrip }) {
  const [val, setVal] = useState(capStr(cap));
  const [ask, setAsk] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const tripSent = useRef(false);
  useEffect(() => setVal(capStr(cap)), [cap]);
  const over = riskCapHit(cap, loss);

  // Paper / manual rows: the UI is the runner — record the trip once when the loss crosses the cap.
  useEffect(() => {
    if (!onTrip || tripped || !over || tripSent.current) return;
    tripSent.current = true;
    Promise.resolve(onTrip(loss)).catch(() => {
      tripSent.current = false;
    });
  }, [onTrip, tripped, over, loss]);
  useEffect(() => {
    if (!tripped) tripSent.current = false;
  }, [tripped]);

  const save = async (next) => {
    setBusy(true);
    setErr('');
    try {
      await onSave(next);
      setAsk(null);
    } catch (e) {
      setErr(e?.message || 'Save failed');
      setVal(capStr(cap));
    } finally {
      setBusy(false);
    }
  };
  const commit = () => {
    const raw = val.trim();
    const next = raw === '' ? null : Number(raw);
    if (next != null && !(next > 0)) return setVal(capStr(cap));
    if ((next ?? null) === (Number(cap) > 0 ? Number(cap) : null)) return undefined;
    // Light confirm only when the new cap is already below the open loss (it would trip right away).
    if (next != null && loss != null && loss > next) return setAsk(next);
    save(next);
    return undefined;
  };

  return (
    <span className="rc" onClick={(e) => e.stopPropagation()}>
      <span className={`rc__in${tripped ? ' is-hit' : ''}`}>
        $
        <input
          type="number"
          min="1"
          step="1"
          inputMode="numeric"
          value={val}
          placeholder="no cap"
          disabled={busy}
          aria-label={`Risk cap $ for ${symbol}`}
          title="Emergency kill switch: if this position's open loss goes above this $, the bot stops trading it. Does not move the stop. Blank = no cap."
          onChange={(e) => setVal(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
      </span>
      {tripped ? (
        <span className="rc__hit">
          <span className="risk-hit" title={`Open loss went above the Risk cap${loss != null ? ` (now ${usd(loss)})` : ''}. ${bot ? 'The bot places, moves and cancels nothing more for it; a resting Schwab stop stays in place.' : 'Halted.'} Raise Risk or Resume to re-arm.`}>
            RISK HIT — bot stopped
          </span>
          <button
            type="button"
            className="btn btn--ghost rc__resume"
            disabled={busy || over}
            title={over ? `Still over the cap (loss ${usd(loss)} > ${usd(Number(cap))}). Raise Risk to re-arm.` : 'Re-arm: the bot resumes managing this position.'}
            onClick={async () => {
              setBusy(true);
              try {
                await onResume();
              } catch (e) {
                setErr(e?.message || 'Resume failed');
              } finally {
                setBusy(false);
              }
            }}
          >
            Resume
          </button>
        </span>
      ) : Number(cap) > 0 && loss != null ? (
        <span className={`rc__loss mono small ${over ? 'neg' : 'muted'}`} title="Open loss vs your Risk cap">
          {over ? (bot ? 'over cap · stops next check' : 'over cap') : `loss ${usd(loss)} / ${usd(Number(cap))}`}
        </span>
      ) : null}
      {err ? <span className="small neg">{err}</span> : null}
      {ask != null
        ? createPortal(
            <div className="rk-modal" role="dialog" aria-label={`Risk cap for ${symbol}`}>
              <button type="button" className="rk-modal__scrim" aria-label="Cancel" onClick={() => { setAsk(null); setVal(capStr(cap)); }} />
              <div className="rk-modal__card card">
                <h3>Risk cap · {symbol}</h3>
                <dl className="rk-grid">
                  <dt>Open loss</dt>
                  <dd className="mono neg">{usd(loss)}</dd>
                  <dt>New cap</dt>
                  <dd className="mono">{usd(ask)}</dd>
                </dl>
                <p className="small neg" style={{ margin: 0 }}>
                  The loss is already above this cap. {bot ? 'The bot stops trading this position on its next check (within 5 min). Nothing is sold; the stop stays where it is.' : 'It will show RISK HIT right away.'}
                </p>
                <div className="rk-btns">
                  <button type="button" className="btn btn--ghost" onClick={() => { setAsk(null); setVal(capStr(cap)); }} disabled={busy}>
                    Cancel
                  </button>
                  <button type="button" className="btn btn--danger" onClick={() => save(ask)} disabled={busy}>
                    {busy ? 'Saving…' : 'Set cap'}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
