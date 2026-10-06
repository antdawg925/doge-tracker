import { useSearchParams } from 'react-router-dom';
import { useDogePlan } from '../hooks/dogePlanContext.js';
import MyBot from '../components/bot/MyBot.jsx';
import StocksPanel from '../components/stocks/StocksPanel.jsx';
import DipBuys from './DipBuys.jsx';
import SellHighs from './SellHighs.jsx';

// The old DOGE plan box, paper test, decision log, runs, paper trades and Bot status card
// (DogePlanForm / DogeStopBox / PlanHistory / AlertLog / BotStatus) are hidden, not deleted:
// their data and the cron keep running.
const TABS = [
  { id: 'doge', label: 'DOGE' },
  { id: 'stocks', label: 'Stocks' },
  { id: 'buy-dips', label: 'Buy dips' },
  { id: 'sell-highs', label: 'Sell highs' },
];
const TAB_IDS = new Set(TABS.map((t) => t.id));

export default function Alerts() {
  const ctx = useDogePlan();
  const { market, permission } = ctx;
  const [params, setParams] = useSearchParams();
  const rawTab = params.get('tab');
  const tab = TAB_IDS.has(rawTab) ? rawTab : 'doge';
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
            ) : tab === 'buy-dips' ? (
              <p className="scanner__subtitle muted">
                Uptrend / base names with a major support below. Limit at the floor, stop = support − 1 weekly ATR. Plans show under Stocks. TSLA excluded.
              </p>
            ) : tab === 'sell-highs' ? (
              <p className="scanner__subtitle muted">
                Weak names (stage 3–4, below SMA50, downtrend) bouncing toward a major resistance. Short just under it, cover stop = resistance + 1 weekly ATR, cover at the next support. $100 risk default. TSLA excluded.
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

      {tab === 'stocks' ? <StocksPanel /> : tab === 'buy-dips' ? <DipBuys /> : tab === 'sell-highs' ? <SellHighs /> : <MyBot refreshKey={market.updatedAt} />}
    </main>
  );
}
