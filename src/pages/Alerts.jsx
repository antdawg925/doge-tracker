import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useDogePlan } from '../hooks/dogePlanContext.js';
import { buildRules } from '../lib/alertRules.js';
import { formatTime } from '../lib/format.js';
import DogePlanForm from '../components/alerts/DogePlanForm.jsx';
import DogeStopBox from '../components/alerts/DogeStopBox.jsx';
import PlanHistory from '../components/alerts/PlanHistory.jsx';
import AlertLog from '../components/alerts/AlertLog.jsx';
import BotStatus from '../components/alerts/BotStatus.jsx';
import StocksPanel from '../components/stocks/StocksPanel.jsx';

const TABS = [
  { id: 'doge', label: 'DOGE' },
  { id: 'stocks', label: 'Stocks' },
];

export default function Alerts() {
  const ctx = useDogePlan();
  const { doc, market, snapshot, permission } = ctx;
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'stocks' ? 'stocks' : 'doge';
  const setTab = (id) => setParams(id === 'doge' ? {} : { tab: id }, { replace: true });

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
            <div className="scanner__tabs bot-tabs" role="tablist" aria-label="Bot">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  className={`scanner__tab${tab === t.id ? ' is-active' : ''}`}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            {tab === 'stocks' ? (
              <p className="scanner__subtitle muted">
                Where to put your Schwab stops. Longs trail 2.5 ATR under the highest close; shorts trail 3 ATR over the
                lowest low (2 ATR at +20%, 1.5 ATR on a squeeze). Stops only tighten. You move them at Schwab.
              </p>
            ) : (
            <p className="scanner__subtitle muted">
              Stage 1: the core sits on a fixed floor. Stage 2 (4h close above breakout): the floor
              steps up and an ATR trailing stop takes over, only ever moving up. The trading slice
              sells into strength and buys back lower. The server checks DOGE every 5 minutes, even
              with Trade Smart closed (watch-only, no orders). Browser alerts also fire while the app
              is open.
            </p>
            )}
          </div>
          {tab === 'doge' ? (
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
          ) : null}
        </div>
      </div>

      {ctx.storeError ? (
        <p className="auth-card__error" role="alert">
          {ctx.storeError}
        </p>
      ) : null}

      {tab === 'stocks' ? (
        <StocksPanel />
      ) : !plan ? (
        <div className="card">
          <p className="muted">Loading plan…</p>
        </div>
      ) : (
        <div className="dp-grid">
          <div className="dp-col">
            <BotStatus refreshKey={market.updatedAt} />
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
