import { useMemo, useState } from 'react';
import { useDogePlan } from '../hooks/dogePlanContext.js';
import { buildRules } from '../lib/alertRules.js';
import { formatTime } from '../lib/format.js';
import DogePlanForm from '../components/alerts/DogePlanForm.jsx';
import DogeStopBox from '../components/alerts/DogeStopBox.jsx';
import PlanHistory from '../components/alerts/PlanHistory.jsx';
import AlertLog from '../components/alerts/AlertLog.jsx';

export default function Alerts() {
  const ctx = useDogePlan();
  const { doc, market, snapshot, permission, pollMs } = ctx;
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  const plan = doc?.plan;
  const planKey = useMemo(() => (plan ? JSON.stringify(plan) : ''), [plan]);
  const rules = useMemo(() => buildRules(plan, snapshot), [plan, snapshot]);

  const save = async (next) => {
    setSaving(true);
    try {
      await ctx.savePlan(next);
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  const resetTrail = () => {
    if (
      window.confirm(
        'Restart the plan from now? Breakout detection starts from the current candle and the stop memory clears (the manual floor still applies).',
      )
    ) {
      ctx.resetTrail();
    }
  };

  const raiseFloor = () => {
    if (plan) save({ ...plan, stopFloor: plan.breakoutFloor, note: plan.note });
  };

  return (
    <main className="scanner dp-page">
      <div className="scanner__header card">
        <div className="scanner__title-row">
          <div>
            <p className="scanner__kicker muted">My Bot</p>
            <h1>Trade Smart Bot</h1>
            <p className="scanner__subtitle muted">
              Stage 1: the core sits on a fixed floor. Stage 2 (4h close above breakout): the floor
              steps up and an ATR trailing stop takes over, only ever moving up. The trading slice
              sells into strength and buys back lower. Price checks run every {Math.round(pollMs / 1000)}s
              while Trade Smart is open.
            </p>
          </div>
          <div className="scanner__controls">
            <div className="dp-controls">
              {permission === 'default' ? (
                <button type="button" className="btn btn--primary" onClick={ctx.requestPermission}>
                  Enable notifications
                </button>
              ) : permission === 'denied' ? (
                <span className="muted small">Notifications blocked in browser settings</span>
              ) : null}
            </div>
            <p className="scanner__updated muted">
              Updated {formatTime(market.updatedAt)}
              {market.error ? ` · ${market.error}` : ''}
            </p>
          </div>
        </div>
      </div>

      {ctx.storeError ? (
        <p className="auth-card__error" role="alert">
          {ctx.storeError}
        </p>
      ) : null}

      {!plan ? (
        <div className="card">
          <p className="muted">Loading plan…</p>
        </div>
      ) : (
        <div className="dp-grid">
          <div className="dp-col">
            <DogeStopBox
              plan={plan}
              snapshot={snapshot}
              market={market}
              onResetTrail={resetTrail}
              onRaiseFloor={raiseFloor}
            />
            <AlertLog
              log={doc.alerts.log}
              rules={rules}
              ruleState={doc.alerts.rules}
              onClear={ctx.clearAlertLog}
            />
          </div>
          <div className="dp-col">
            <DogePlanForm key={planKey} plan={plan} onSave={save} saving={saving} justSaved={justSaved} />
            <PlanHistory
              history={doc.history}
              bars={market.bars}
              onDelete={ctx.deleteHistoryEntry}
            />
          </div>
        </div>
      )}
    </main>
  );
}
