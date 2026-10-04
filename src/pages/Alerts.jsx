import { useSearchParams } from 'react-router-dom';
import { useDogePlan } from '../hooks/dogePlanContext.js';
import MyBot from '../components/bot/MyBot.jsx';
import StocksPanel from '../components/stocks/StocksPanel.jsx';

// The old DOGE plan box, paper test, decision log, runs, paper trades and Bot status card
// (DogePlanForm / DogeStopBox / PlanHistory / AlertLog / BotStatus) are hidden, not deleted:
// their data and the cron keep running.
const TABS = [
  { id: 'doge', label: 'DOGE' },
  { id: 'stocks', label: 'Stocks' },
];

export default function Alerts() {
  const ctx = useDogePlan();
  const { market, permission } = ctx;
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'stocks' ? 'stocks' : 'doge';
  const setTab = (id) => setParams(id === 'doge' ? {} : { tab: id }, { replace: true });

  return (
    <main className="scanner dp-page mb-page">
      <div className="scanner__header card mb-header">
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
            ) : null}
          </div>
          {tab === 'doge' && permission === 'default' ? (
            <div className="scanner__controls">
              <button type="button" className="btn btn--ghost stk-btn" onClick={ctx.requestPermission}>
                Enable notifications
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {ctx.storeError ? (
        <p className="auth-card__error" role="alert">
          {ctx.storeError}
        </p>
      ) : null}

      {tab === 'stocks' ? <StocksPanel /> : <MyBot refreshKey={market.updatedAt} />}
    </main>
  );
}
