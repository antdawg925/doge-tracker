import { useState } from 'react';
import { DEFAULT_PLAN } from '../../lib/planStore.js';
import { formatPrice } from '../../lib/format.js';

/** ISO → value for <input type="datetime-local"> in the browser's zone. */
function isoToLocalInput(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function localInputToIso(v) {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toDraft(plan) {
  const s = (v) => (v == null ? '' : String(v));
  return {
    avgCost: s(plan.avgCost),
    corePct: s(plan.corePct),
    slicePct: s(plan.slicePct),
    sellLevel: s(plan.sellLevel),
    buyBackLevel: s(plan.buyBackLevel),
    stopFloor: s(plan.stopFloor),
    breakoutLevel: s(plan.breakoutLevel),
    breakoutFloor: s(plan.breakoutFloor),
    highLow: s(plan.highZone.low),
    highHigh: s(plan.highZone.high),
    lowLow: s(plan.lowZone.low),
    lowHigh: s(plan.lowZone.high),
    atrMult: s(plan.atrMult),
    tightMult: s(plan.tightMult),
    tightenPct: s(plan.tightenPct),
    tightenRef: s(plan.tightenRef),
    anchorAt: isoToLocalInput(plan.anchorAt),
    note: plan.note || '',
  };
}

function fromDraft(d, base) {
  return {
    ...base,
    avgCost: d.avgCost,
    corePct: d.corePct,
    slicePct: d.slicePct,
    sellLevel: d.sellLevel,
    buyBackLevel: d.buyBackLevel,
    stopFloor: d.stopFloor,
    breakoutLevel: d.breakoutLevel,
    breakoutFloor: d.breakoutFloor,
    highZone: { low: d.highLow, high: d.highHigh },
    lowZone: { low: d.lowLow, high: d.lowHigh },
    atrMult: d.atrMult,
    tightMult: d.tightMult,
    tightenPct: d.tightenPct,
    tightenRef: d.tightenRef,
    // Keep the exact stored anchor unless the user actually edited it
    // (datetime-local is minute-precision; a round trip must not re-anchor the trail).
    anchorAt:
      d.anchorAt === isoToLocalInput(base.anchorAt)
        ? base.anchorAt
        : localInputToIso(d.anchorAt) || base.anchorAt,
    note: d.note,
  };
}

const GROUPS = [
  {
    title: 'Position',
    fields: [
      { key: 'avgCost', label: 'Average cost', step: '0.0001' },
      { key: 'corePct', label: 'Core % (trailing stop)', step: '1' },
      { key: 'slicePct', label: 'Trading slice %', step: '1' },
    ],
  },
  {
    title: 'Trading slice',
    fields: [
      { key: 'sellLevel', label: 'Sell into strength', step: '0.0001' },
      { key: 'buyBackLevel', label: 'Buy back', step: '0.0001' },
    ],
  },
  {
    title: 'Stops',
    fields: [
      { key: 'stopFloor', label: 'Manual stop floor', step: '0.0001' },
      { key: 'breakoutLevel', label: 'Breakout level', step: '0.0001' },
      { key: 'breakoutFloor', label: 'Floor after breakout', step: '0.0001' },
    ],
  },
  {
    title: 'Predicted zones',
    fields: [
      { key: 'highLow', label: 'High zone — low', step: '0.0001' },
      { key: 'highHigh', label: 'High zone — high', step: '0.0001' },
      { key: 'lowLow', label: 'Low zone — low', step: '0.0001' },
      { key: 'lowHigh', label: 'Low zone — high', step: '0.0001' },
    ],
  },
  {
    title: 'ATR trail',
    fields: [
      { key: 'atrMult', label: 'ATR multiplier', step: '0.05' },
      { key: 'tightMult', label: 'Tight multiplier', step: '0.05' },
      { key: 'tightenPct', label: 'Tighten above cost +%', step: '1' },
      {
        key: 'tightenRef',
        label: 'Tighten reference',
        step: '0.0001',
        placeholder: 'avg cost',
        hint: 'Blank = average cost',
      },
    ],
  },
];

/**
 * Editable plan. The parent remounts this (via `key`) when the stored plan
 * actually changes, so polling ticks never clobber an in-progress edit.
 */
export default function DogePlanForm({ plan, onSave, saving, justSaved }) {
  const [draft, setDraft] = useState(() => toDraft(plan));

  const set = (key) => (e) => setDraft((d) => ({ ...d, [key]: e.target.value }));
  const dirty = JSON.stringify(draft) !== JSON.stringify(toDraft(plan));
  const splitSum = (parseFloat(draft.corePct) || 0) + (parseFloat(draft.slicePct) || 0);
  const anchorChanged = draft.anchorAt !== isoToLocalInput(plan.anchorAt);

  const submit = async (e) => {
    e.preventDefault();
    await onSave(fromDraft(draft, plan));
  };

  const loadDefaults = () =>
    setDraft({ ...toDraft({ ...DEFAULT_PLAN, anchorAt: plan.anchorAt }), note: draft.note });

  return (
    <form className="card dp-form" onSubmit={submit}>
      <div className="card__head">
        <h2>DOGE plan</h2>
        <span className="muted small">
          {plan.updatedAt ? `Saved ${new Date(plan.updatedAt).toLocaleString()}` : 'Defaults — not saved yet'}
        </span>
      </div>

      {GROUPS.map((g) => (
        <fieldset key={g.title} className="dp-form__group">
          <legend>{g.title}</legend>
          <div className="dp-form__grid">
            {g.fields.map((f) => (
              <label key={f.key} className="field">
                <span>{f.label}</span>
                <input
                  type="number"
                  inputMode="decimal"
                  step={f.step}
                  min="0"
                  placeholder={f.placeholder}
                  value={draft[f.key]}
                  onChange={set(f.key)}
                />
                {f.hint ? <span className="field__hint">{f.hint}</span> : null}
              </label>
            ))}
            {g.title === 'ATR trail' ? (
              <label className="field dp-form__wide">
                <span>Trail anchor (highest high counted from)</span>
                <input type="datetime-local" value={draft.anchorAt} onChange={set('anchorAt')} />
                <span className="field__hint">
                  {anchorChanged
                    ? 'Changing the anchor restarts the trail (ratchet memory resets on save).'
                    : 'Moving this restarts the trail on save.'}
                </span>
              </label>
            ) : null}
          </div>
          {g.title === 'Position' && Math.abs(splitSum - 100) > 0.01 ? (
            <p className="dp-form__warn small">Core + slice = {splitSum}% (expected 100%).</p>
          ) : null}
        </fieldset>
      ))}

      <label className="field dp-form__note">
        <span>Note (optional)</span>
        <textarea
          rows={2}
          value={draft.note}
          placeholder="e.g. Expect a pop into 0.104 then chop back to 0.088"
          onChange={set('note')}
        />
      </label>

      <div className="dp-form__actions">
        <button type="submit" className="btn btn--primary" disabled={saving}>
          {saving ? 'Saving…' : justSaved ? 'Saved ✓' : 'Save plan'}
        </button>
        <button type="button" className="btn btn--ghost" disabled={!dirty} onClick={() => setDraft(toDraft(plan))}>
          Revert
        </button>
        <button type="button" className="btn btn--ghost" onClick={loadDefaults}>
          Load defaults
        </button>
        <span className="muted small">
          Every save is logged below. Sell {formatPrice(parseFloat(draft.sellLevel))} · buy back{' '}
          {formatPrice(parseFloat(draft.buyBackLevel))}
        </span>
      </div>
    </form>
  );
}
