import { useEffect, useState } from 'react';
import { addPaperIdea } from '../../lib/paperIdeas.js';
import { fetchSpot } from '../../lib/price.js';

const r = (v) => (v == null || !Number.isFinite(Number(v)) || !(Number(v) > 0) ? '' : String(Number(v) >= 1 ? Number(Number(v).toFixed(2)) : Number(Number(v).toFixed(5))));

/**
 * Compact violet paper-trade ticket. `asset` fixed (Research / setup preview) or chosen with `picker`.
 * suggest(side) → { entry, stop, target } prefill; shares are only what he types (no default size).
 */
export default function PaperTradeForm({ asset, picker = null, suggest, defaultSide = 'long', source = 'manual', onSaved, onCancel }) {
  const [side, setSide] = useState(defaultSide);
  const [vals, setVals] = useState(() => fill(suggest?.(defaultSide)));
  const [touchedQty, setTouchedQty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  function fill(s) {
    const entry = r(s?.entry);
    return { entry, stop: r(s?.stop), target: r(s?.target), qty: '' };
  }
  // New asset (picker) or side: refill from the suggestion; pull a quote when there's no entry.
  const key = `${asset?.type}:${asset?.symbol}`;
  useEffect(() => {
    setVals(fill(suggest?.(side)));
    setTouchedQty(false);
    if (!asset || suggest?.(side)?.entry) return undefined;
    const ac = new AbortController();
    fetchSpot(asset, { signal: ac.signal })
      .then((q) => q?.price > 0 && setVals((v) => (v.entry ? v : { ...v, entry: r(q.price) })))
      .catch(() => {});
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, side]);

  const set = (k) => (e) => {
    const v = { ...vals, [k]: e.target.value };
    if (k === 'qty') setTouchedQty(true);
    setVals(v);
  };
  const submit = async (e) => {
    e.preventDefault();
    if (!asset) return setErr('Pick a symbol.');
    setBusy(true);
    setErr('');
    try {
      const idea = await addPaperIdea(asset, { side, qty: vals.qty, entry: vals.entry, stop: vals.stop, target: vals.target, source });
      onSaved?.(idea);
    } catch (ex) {
      setErr(ex?.message || 'Could not save');
      setBusy(false);
    }
  };
  const e = Number(vals.entry);
  const s = Number(vals.stop);
  const risk = e > 0 && s > 0 && Number(vals.qty) > 0 ? Math.abs(e - s) * Number(vals.qty) : null;
  return (
    <form className="ptf" onSubmit={submit}>
      {picker}
      <div className="ptf__side" role="group" aria-label="Side">
        {['long', 'short'].map((x) => (
          <button key={x} type="button" className={side === x ? 'is-on' : ''} onClick={() => setSide(x)}>
            {x === 'long' ? 'Long' : 'Short'}
          </button>
        ))}
      </div>
      {[
        ['entry', 'Entry'],
        ['stop', 'Stop'],
        ['target', 'Target'],
        ['qty', asset?.type === 'crypto' ? 'Coins' : 'Shares'],
      ].map(([k, label]) => (
        <label key={k} className="ptf__f">
          <span className="small muted">{label}</span>
          <input type="number" step="any" min="0" inputMode="decimal" value={vals[k]} placeholder={k === 'stop' || k === 'target' ? 'opt.' : ''} onChange={set(k)} />
        </label>
      ))}
      <div className="ptf__act">
        <button type="submit" className="btn btn--paper" disabled={busy}>
          {busy ? 'Saving…' : 'Save paper trade'}
        </button>
        {onCancel ? (
          <button type="button" className="btn btn--ghost" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
        {risk != null ? <span className="small muted">risk ${Math.round(risk)}</span> : null}
      </div>
      {err ? <p className="small neg ptf__err">{err}</p> : null}
    </form>
  );
}
