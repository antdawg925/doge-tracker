import { useCallback, useEffect, useState } from 'react';
import { authedFetch } from '../../lib/api.js';
import { formatPrice } from '../../lib/format.js';

const px = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : formatPrice(Number(n)));

/**
 * My Bot → Stocks: Buy dips (long) and Sell highs (short) plans: pending limit → filled stop → ratchet.
 * Default dry-run; per-user Stocks Live switch (also needs Schwab Live ON to send orders).
 */
export default function DipPlansPanel() {
  const [plans, setPlans] = useState(null);
  const [live, setLive] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await authedFetch('/api/bot/stocks/plans/list', { method: 'POST', body: {} });
      setPlans(r.plans || []);
      setLive(Boolean(r.stocksLive));
      setErr('');
    } catch (e) {
      setErr(e.message);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
  }, [load]);

  const act = async (path, body) => {
    setBusy(true);
    setErr('');
    try {
      await authedFetch(path, { method: 'POST', body });
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (plans === null) return <p className="muted small">Loading stock plans…</p>;

  return (
    <div className="dip-plans">
      <div className="dip-plans__head">
        <h3 className="mlv__h">Buy dips &amp; Sell highs</h3>
        <label className={`stk-switch stk-switch--sm${live ? ' is-on' : ''}`} title="When ON (and Schwab Live is ON), pending plans place real LIMIT buys / SELL_SHORT limits in RTH. Default is dry-run.">
          <input
            type="checkbox"
            checked={live}
            disabled={busy}
            onChange={(e) => {
              if (e.target.checked) {
                if (!window.confirm('Turn on LIVE stock plans? Real Schwab LIMIT buys and SELL_SHORT limits will place in regular hours for pending plans (never TSLA). A protective STOP follows each fill: up-only for buys, down-only (BUY_TO_COVER) for Sell highs shorts.')) return;
                act('/api/bot/stocks/plans/live', { enabled: true, confirm: 'LIVE' });
              } else act('/api/bot/stocks/plans/live', { enabled: false });
            }}
          />
          <span>Stocks Live {live ? 'ON' : 'OFF'}</span>
        </label>
      </div>
      <p className="small muted">From My Bot → Buy dips and Sell highs. Default dry-run logs what it would do. Unfilled entries cancel after 10 days, or if price crosses the stop first.</p>
      {err ? <p className="small neg">{err}</p> : null}
      {!plans.length ? (
        <p className="muted small">No plans yet.</p>
      ) : (
        <ul className="dip-plans__list">
          {plans.map((p) => {
            const stop = Number(p.last_stop_price || p.stop_price);
            const next = p.next_rung;
            const short = p.side === 'short';
            return (
              <li key={p.id} className={`dip-plans__row dip-plans__row--${p.status}`}>
                <div className="dip-plans__sym">
                  <strong>{p.symbol}</strong>
                  <span className={`dip-plans__side dip-plans__side--${short ? 'short' : 'long'}`}>{short ? 'Sell high' : 'Buy dip'}</span>
                  <span className={`dip-plans__st dip-plans__st--${p.status}`}>{p.status}{p.dry_run ? ' · dry' : ''}</span>
                </div>
                <div className="dip-plans__nums mono small">
                  <span>{short ? `−${p.shares}` : p.shares} sh</span>
                  <span>{short ? 'Short' : 'L'} {px(p.limit_price)}</span>
                  <span className="neg">{short ? 'Cover stop' : 'S'} {px(stop)}</span>
                  {p.t1_price ? <span className="pos">{short ? 'Cover' : 'T1'} {px(p.t1_price)}</span> : null}
                  {short && p.risk_usd ? <span className="muted">risk ${Math.round(Number(p.risk_usd))}</span> : null}
                  {next?.trigger ? (
                    short ? (
                      <span className="muted">next ↓ close&lt;{px(next.trigger)} → {px(next.stop)}</span>
                    ) : (
                      <span className="muted">next ↑ close&gt;{px(next.trigger)} → {px(next.stop)}</span>
                    )
                  ) : null}
                </div>
                <div className="dip-plans__acts">
                  {['pending', 'working'].includes(p.status) ? (
                    <button type="button" className="stk-linkbtn" disabled={busy} onClick={() => window.confirm(`Cancel ${p.symbol} ${short ? 'Sell highs short' : 'buy'} plan?`) && act('/api/bot/stocks/plans/cancel', { id: p.id })}>
                      Cancel
                    </button>
                  ) : null}
                  {p.status === 'filled' ? (
                    <button
                      type="button"
                      className="stk-linkbtn"
                      disabled={busy}
                      onClick={() => {
                        const v = short
                          ? window.prompt(`Lower ${p.symbol} cover stop below ${px(stop)}`, String((stop * 0.98).toFixed(2)))
                          : window.prompt(`Raise ${p.symbol} stop above ${px(stop)}`, String((stop * 1.02).toFixed(2)));
                        if (v && (short ? Number(v) < stop : Number(v) > stop)) act('/api/bot/stocks/plans/raise', { id: p.id, price: Number(v) });
                      }}
                    >
                      {short ? 'Lower stop' : 'Raise stop'}
                    </button>
                  ) : null}
                </div>
                {p.last_error ? <p className="small neg">{p.last_error}</p> : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
