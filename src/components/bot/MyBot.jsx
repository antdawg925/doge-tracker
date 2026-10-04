import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../hooks/authContext.js';
import { authedFetch } from '../../lib/api.js';
import { supabase } from '../../lib/supabase.js';
import { BrandMark } from '../BrandMark.jsx';
import { LOG_COPY, QuietHours, ROLE_COPY, Settings } from '../alerts/DogeLivePanel.jsx';

/**
 * My Bot → DOGE: one screen. Hero (bottom stop) · Position · Orders · Quick actions ·
 * Your settings (drawer) · Activity (drawer). Every write goes through /api/bot/doge-live/*,
 * the same server paths and checks as the Telegram commands.
 */
const px = (n, d = 4) => (n == null || !Number.isFinite(Number(n)) ? '—' : `$${Number(n).toFixed(d)}`);
const usd = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : `$${Math.round(Number(n)).toLocaleString('en-US')}`);
const qty = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : Math.round(Number(n)).toLocaleString('en-US'));
const pct = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : `${n >= 0 ? '+' : ''}${Number(n).toFixed(1)}%`);
const pt = (iso) =>
  iso ? `${new Date(iso).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} PT` : '—';
const LATE_MS = 15 * 60000;
const URGENT = new Set(['stop_crossed', 'kill_switch', 'no_trade_key', 'order_gone', 'no_stop_level', 'raise_crossed', 'near_stop', 'drop_1h']);

function Hero({ row, busy, call, isOwner, checkedAt }) {
  const s = row.snapshot || {};
  const b = s.bottom || {};
  const live = s.mode === 'live';
  const stopPx = row.state?.stopPx ?? b.price ?? null;
  const dist = stopPx && s.price ? (s.price / stopPx - 1) * 100 : null;
  const stopped = row.status === 'stopped' || row.status === 'ended';
  const [raiseTo, setRaiseTo] = useState('');
  const [lowering, setLowering] = useState(false);
  const [lowerTo, setLowerTo] = useState('');
  const [lowerWord, setLowerWord] = useState('');
  const rv = Number(raiseTo);
  const raiseOk = raiseTo !== '' && rv > (stopPx || 0) && (!s.bid || rv < s.bid);
  const late = row.last_run_at && checkedAt - Date.parse(row.last_run_at) > LATE_MS;
  return (
    <section className={`card mb-hero${live ? ' mb-hero--live' : ''}${row.kill_switch ? ' mb-hero--killed' : ''}`}>
      <div className="mb-hero__top">
        <span className="small muted">
          Bottom stop <BrandMark brand="kraken" height={11} />
        </span>
        <span className={`dl-mode ${live ? 'dl-mode--live' : ''}`} title={live ? 'Real Kraken orders' : 'Computes and logs orders; places nothing'}>
          {live ? 'LIVE' : 'DRY-RUN'}
        </span>
      </div>
      {row.kill_switch ? (
        <div className="dl-kill" role="alert">
          <strong>KILL SWITCH ON</strong> · bot orders cancelled, no protective stop.
          <button type="button" className="btn btn--ghost stk-btn" disabled={busy} onClick={() => call('kill', { on: false })}>
            Resume
          </button>
        </div>
      ) : null}
      <div className="mb-hero__body">
        <div className="mb-hero__px mono">{px(stopPx)}</div>
        <dl className="mb-facts small">
          <div>
            <dt>Price</dt>
            <dd className="mono">{px(s.price)}</dd>
          </div>
          <div>
            <dt>Distance</dt>
            <dd className={dist != null && dist < 3 ? 'neg' : ''}>{dist != null ? `${dist.toFixed(1)}% above` : '—'}</dd>
          </div>
          <div>
            <dt>Covers</dt>
            <dd className="mono">{s.stop ? `${qty(s.stop.qty)} DOGE` : '—'}</dd>
          </div>
          <div>
            <dt>Last raised</dt>
            <dd title={row.state?.stopReason || ''}>
              {pt(row.state?.stopSetAt)} <span className="muted">· {row.state?.stopReason || '—'}</span>
            </dd>
          </div>
        </dl>
      </div>
      {stopped ? (
        <p className="small neg">{row.state?.endReason || 'Bottom stop filled.'} No re-entry; start a new plan in Your settings.</p>
      ) : (
        <div className="mb-row">
          <input type="number" step="0.0001" min="0" placeholder={stopPx ? (stopPx * 1.02).toFixed(4) : '0.0890'} value={raiseTo} onChange={(e) => setRaiseTo(e.target.value)} aria-label="New stop price" />
          <button type="button" className="btn btn--primary stk-btn" disabled={busy || !raiseOk} title={raiseTo !== '' && !raiseOk ? 'Above the current stop and below the market' : ''} onClick={async () => (await call('stop', { price: rv })) && setRaiseTo('')}>
            Raise stop
          </button>
          <button
            type="button"
            className="btn btn--ghost stk-btn"
            disabled={busy || row.kill_switch}
            onClick={() => window.confirm(`Sell 30% of your DOGE now${live ? ' (REAL order at Kraken' : ' (dry-run'}: IOC limit 0.5% under the bid)? The stop resizes to the rest.`) && call('sell', { pct: 30, confirm: 'SELL' })}
          >
            Sell 30% now
          </button>
          {isOwner ? (
            <button type="button" className="mb-link small" onClick={() => setLowering((v) => !v)}>
              Lower stop…
            </button>
          ) : null}
        </div>
      )}
      {lowering ? (
        <div className="stk-schwab__confirm dl-confirm" role="dialog" aria-label="Lower the stop">
          <span className="small">Lowering gives back protection. New stop</span>
          <input type="number" step="0.0001" min="0" value={lowerTo} onChange={(e) => setLowerTo(e.target.value)} aria-label="Lower stop to" />
          <input type="text" placeholder="type LOWER" value={lowerWord} onChange={(e) => setLowerWord(e.target.value)} aria-label="Type LOWER to confirm" />
          <button
            type="button"
            className="btn stk-btn stk-kill"
            disabled={busy || lowerWord !== 'LOWER' || !(Number(lowerTo) > 0 && Number(lowerTo) < (stopPx || Infinity))}
            onClick={async () => {
              if (await call('stop', { price: Number(lowerTo), lower: true, confirm: 'LOWER' })) {
                setLowering(false);
                setLowerTo('');
                setLowerWord('');
              }
            }}
          >
            Lower stop
          </button>
        </div>
      ) : null}
      <p className={`mb-beat small ${late ? 'dp-warn' : 'muted'}`}>
        {late ? '⚠️ Server check is late' : '● Server checks every 5 min'} · last run {pt(row.last_run_at)} · auto-raise {row.config?.trailEnabled === false ? 'off' : `trail ${px(b.trail)}`}
        {b.lockPx ? ` · lock ${px(b.lockPx)}` : ''}
      </p>
    </section>
  );
}

function Position({ row }) {
  const s = row.snapshot || {};
  const doge = s.book?.doge;
  const start = row.config?.startValue;
  const vs = s.account && start ? (s.account / start - 1) * 100 : null;
  const items = [
    ['DOGE held', qty(doge)],
    ['Value', usd(doge != null && s.price ? doge * s.price : null)],
    ['Cash', usd(s.book?.usd)],
    ['Account vs start', <span key="a">{usd(s.account)} <span className={vs >= 0 ? 'pos' : 'neg'}>{pct(vs)}</span></span>],
    ['Locked', s.lockActive ? <span key="l" className="pos">{usd(s.lock)}</span> : <span key="l" className="muted">at {usd(s.lockActivatesAt)}</span>],
    ['HWM', usd(s.hwm)],
  ];
  return (
    <section className="card mb-card">
      <h2 className="mb-card__title">
        Position <span className="small muted">{s.bookSource === 'kraken' ? 'Kraken' : 'plan'}</span>
      </h2>
      <dl className="mb-grid">
        {items.map(([k, v]) => (
          <div key={k}>
            <dt className="small muted">{k}</dt>
            <dd className="mono">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Orders({ row, botBuys }) {
  const s = row.snapshot || {};
  const o = s.orders || {};
  const live = s.mode === 'live';
  const rows = [];
  if (o.stop) rows.push({ k: 'stop', who: 'Bot', what: `Stop-loss sell${live ? '' : ' (would place)'}`, price: o.stop.price, qty: o.stop.qty });
  if (o.zone) rows.push({ k: 'zone', who: 'Bot', what: 'Zone sell', price: o.zone.price, qty: o.zone.qty });
  if (o.pot) rows.push({ k: 'pot', who: 'Bot', what: 'Pot buy', price: o.pot.price, qty: o.pot.qty });
  if (o.sell) rows.push({ k: 'sell', who: 'Bot', what: 'Sell now', price: o.sell.price, qty: o.sell.qty });
  for (const b of botBuys) rows.push({ k: b.id, who: 'Bot', what: `Your buy via bot (${b.status}${b.repegs ? `, re-pegged ${b.repegs}×` : ''})`, price: b.price, qty: b.qty - (b.filled_qty || 0) });
  for (const b of s.userBuys || []) rows.push({ k: b.txid, who: 'You', what: 'Your buy', price: b.price, qty: b.qty, note: pct(b.distPct) });
  for (const b of s.userSells || []) rows.push({ k: b.txid, who: 'You', what: 'Your sell', price: b.price, qty: b.qty });
  return (
    <section className="card mb-card">
      <h2 className="mb-card__title">
        Orders <span className="small muted">{live ? 'at Kraken' : 'dry-run: nothing at Kraken'}</span>
      </h2>
      {rows.length ? (
        <ul className="mb-orders small">
          {rows.map((r) => (
            <li key={r.k}>
              <span className={`mb-tag ${r.who === 'You' ? 'mb-tag--you' : ''}`}>{r.who}</span>
              <span>{r.what}</span>
              <span className="mono">{qty(r.qty)} @ {px(r.price, r.price < 1 ? 5 : 2)}</span>
              {r.note ? <span className="muted">{r.note}</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="small muted">No open orders.</p>
      )}
    </section>
  );
}

function QuickActions({ row, busy, setBusy, setMsg, reload, isOwner }) {
  const [amt, setAmt] = useState('');
  const [plan, setPlan] = useState(null);
  const [sp, setSp] = useState('');
  const [sAmt, setSAmt] = useState('');
  const [unit, setUnit] = useState('pct');
  const [result, setResult] = useState('');
  const s = row.snapshot || {};
  const run = async (fn) => {
    setBusy(true);
    setMsg(null);
    setResult('');
    try {
      await fn();
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  };
  const preview = () =>
    run(async () => {
      setPlan(await authedFetch('/api/bot/doge-live/buy-plan', { method: 'POST', body: { usd: Number(amt) } }));
    });
  const buy = () =>
    run(async () => {
      const r = await authedFetch('/api/bot/doge-live/buy', { method: 'POST', body: { usd: plan.usd, confirm: 'BUY' } });
      setResult(r.text);
      setPlan(null);
      setAmt('');
      await reload();
    });
  const held = Number(s.book?.doge || 0);
  const sellQty = unit === 'pct' ? (held * Number(sAmt)) / 100 : Number(sAmt);
  const sell = () =>
    window.confirm(`${s.mode === 'live' ? 'REAL' : 'Dry-run'} GTC limit sell ${qty(sellQty)} DOGE @ $${sp}? The bottom stop covers the rest.`) &&
    run(async () => {
      const r = await authedFetch('/api/bot/doge-live/limit-sell', { method: 'POST', body: { price: Number(sp), ...(unit === 'pct' ? { pct: Number(sAmt) } : { qty: Number(sAmt) }), confirm: 'SELL' } });
      setResult(r.text);
      setSp('');
      setSAmt('');
      await reload();
    });
  return (
    <section className="card mb-card">
      <h2 className="mb-card__title">Quick actions</h2>
      <div className="mb-qa">
        <div className="mb-qa__col">
          <div className="small muted">Buy (post-only limit at the best bid)</div>
          <div className="mb-row">
            <span className="mb-unit">$</span>
            <input type="number" min="1" step="1" placeholder="1000" value={amt} onChange={(e) => (setAmt(e.target.value), setPlan(null))} aria-label="Buy amount in dollars" />
            <button type="button" className="btn btn--ghost stk-btn" disabled={busy || !(Number(amt) > 0) || !isOwner || row.kill_switch} title={!isOwner ? 'Owner account only' : ''} onClick={preview}>
              Preview
            </button>
          </div>
          {plan ? (
            <div className="mb-plan small">
              <pre>{plan.text.replace(/\n?Dry-run: reply.*$|\n?Reply "yes".*$/m, '')}</pre>
              <button type="button" className="btn btn--primary stk-btn" disabled={busy} onClick={buy}>
                {plan.dry ? 'Confirm (dry-run)' : `Confirm buy ${qty(plan.plan.qty)} DOGE`}
              </button>
              <button type="button" className="btn btn--ghost stk-btn" onClick={() => setPlan(null)}>
                Cancel
              </button>
            </div>
          ) : null}
        </div>
        <div className="mb-qa__col">
          <div className="small muted">Limit sell</div>
          <div className="mb-row">
            <span className="mb-unit">$</span>
            <input type="number" min="0" step="0.0001" placeholder={s.price ? (s.price * 1.05).toFixed(4) : 'price'} value={sp} onChange={(e) => setSp(e.target.value)} aria-label="Sell price" />
            <input type="number" min="0" step="any" placeholder={unit === 'pct' ? '30' : 'DOGE'} value={sAmt} onChange={(e) => setSAmt(e.target.value)} aria-label={unit === 'pct' ? 'Percent of DOGE' : 'DOGE amount'} />
            <select value={unit} onChange={(e) => setUnit(e.target.value)} aria-label="Amount unit">
              <option value="pct">% of DOGE</option>
              <option value="qty">DOGE</option>
            </select>
            <button type="button" className="btn btn--ghost stk-btn" disabled={busy || !(Number(sp) > 0) || !(sellQty >= 50) || row.kill_switch} onClick={sell}>
              Sell
            </button>
          </div>
          {sp && sAmt ? <div className="small muted">≈ {qty(sellQty)} DOGE · {usd(sellQty * Number(sp))}</div> : null}
        </div>
      </div>
      {result ? <pre className="mb-result small">{result}</pre> : null}
    </section>
  );
}

function YourSettings({ row, busy, call, isOwner, userId }) {
  const s = row.snapshot || {};
  const [confirmLive, setConfirmLive] = useState(false);
  return (
    <details className="card mb-drawer">
      <summary>
        <span className="mb-card__title">Your settings</span>
        <span className="mb-follow small">Following Anthony&apos;s plan</span>
      </summary>
      <div className="mb-drawer__body">
        <div className="mb-row">
          <label className={`stk-switch stk-switch--sm${row.live_enabled ? ' is-on' : ''}`} title={s.tradeKeyConfigured ? 'Place real Kraken orders' : 'Needs a Kraken trade key in the server env'}>
            <input type="checkbox" checked={Boolean(row.live_enabled)} disabled={busy || (!row.live_enabled && (!isOwner || !s.tradeKeyConfigured))} onChange={(e) => (e.target.checked ? setConfirmLive(true) : call('live', { enabled: false }))} />
            <span>Live{!s.tradeKeyConfigured ? ' (no trade key)' : ''}</span>
          </label>
          {!row.kill_switch ? (
            <button type="button" className="btn stk-btn stk-kill" disabled={busy} onClick={() => window.confirm('Kill switch: cancel every bot order on Kraken (INCLUDING the protective stop) and place nothing until you resume?') && call('kill', { on: true })}>
              Kill switch
            </button>
          ) : (
            <button type="button" className="btn btn--ghost stk-btn" disabled={busy} onClick={() => call('kill', { on: false })}>
              Resume (kill switch is on)
            </button>
          )}
        </div>
        {confirmLive ? (
          <div className="stk-schwab__confirm dl-confirm" role="dialog" aria-label="Turn on live Kraken orders">
            <span className="small">Turn on LIVE: the bot will place and move a real Kraken stop-loss under your DOGE on XDGUSD. Kill switch stays one click away.</span>
            <button type="button" className="btn btn--primary stk-btn" disabled={busy} onClick={async () => (await call('live', { enabled: true, confirm: 'LIVE' })) && setConfirmLive(false)}>
              Go live
            </button>
            <button type="button" className="btn btn--ghost stk-btn" onClick={() => setConfirmLive(false)}>
              Cancel
            </button>
          </div>
        ) : null}
        <QuietHours userId={userId} />
        <div className="small muted mb-sub">Start values, your stop overrides and risk</div>
        <Settings key={JSON.stringify(row.config)} config={row.config} isOwner={isOwner} busy={busy} fresh={false} onSave={(config) => call('save', { config })} />
        <button
          type="button"
          className="btn btn--ghost stk-btn"
          disabled={busy}
          onClick={() => window.confirm('Start a new plan? The stop restarts at the bottom stop; HWM and lock reset.') && call('new-plan', { confirm: 'NEW' })}
        >
          Start new plan
        </button>
      </div>
    </details>
  );
}

function Activity({ log, lastRun }) {
  return (
    <details className="card mb-drawer">
      <summary>
        <span className="mb-card__title">Activity</span>
        <span className="small muted">last {log.length} · run {pt(lastRun)}</span>
      </summary>
      <ul className="mb-log small">
        {log.map((l) => (
          <li key={l.id} title={l.reason || ''}>
            <span className="muted">{pt(l.at).replace(' PT', '')}</span>{' '}
            <span className={l.status === 'error' || l.status === 'refused' ? 'neg' : l.mode === 'live' ? 'pos' : ''}>
              {l.mode === 'live' ? 'LIVE ' : ''}
              {LOG_COPY[l.status] || l.status}
            </span>{' '}
            {l.role === 'plan' ? <span className="muted">{l.reason}</span> : <>{ROLE_COPY[l.role] || l.role} <span className="mono">{px(l.price)} × {qty(l.qty)}</span></>}
          </li>
        ))}
        {!log.length ? <li className="muted">Nothing yet.</li> : null}
      </ul>
    </details>
  );
}

export default function MyBot({ refreshKey }) {
  const { user, isOwner } = useAuth();
  const [row, setRow] = useState(undefined);
  const [log, setLog] = useState([]);
  const [botBuys, setBotBuys] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [checkedAt, setCheckedAt] = useState(0);

  const load = useCallback(async () => {
    if (!supabase || !user) return;
    const [p, l, b] = await Promise.all([
      supabase.from('doge_live_plans').select('*').eq('user_id', user.id).maybeSingle(),
      supabase.from('doge_live_log').select('id, at, mode, role, action, status, side, ordertype, price, qty, reason').eq('user_id', user.id).neq('action', 'flag').order('at', { ascending: false }).limit(10),
      supabase.from('doge_buy_orders').select('id, status, price, qty, filled_qty, repegs').eq('user_id', user.id).in('status', ['open', 'resting']),
    ]);
    setRow(p.data ?? null);
    setLog(l.data ?? []);
    setBotBuys(b.data ?? []);
    setCheckedAt(Date.now());
  }, [user]);
  useEffect(() => {
    load();
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
  }, [load, refreshKey]);

  const call = async (path, body) => {
    setBusy(true);
    setMsg(null);
    try {
      await authedFetch(`/api/bot/doge-live/${path}`, { method: 'POST', body });
      await load();
      return true;
    } catch (e) {
      setMsg(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (row === undefined) return <div className="card"><p className="muted">Loading…</p></div>;
  if (!row) {
    return (
      <section className="card mb-card">
        <h2 className="mb-card__title">
          DOGE bottom stop <BrandMark brand="kraken" height={12} />
        </h2>
        <p className="small muted">One Kraken stop-loss under all your DOGE that only moves up. Starts in dry-run.</p>
        <Settings config={null} isOwner={isOwner} busy={busy} fresh onSave={(config) => call('save', { config, startNew: true })} />
        {msg ? <p className="small neg">{msg}</p> : null}
      </section>
    );
  }
  const flags = (row.snapshot?.flags || []).filter((f) => !['dry_fill', 'stopped'].includes(f.code));
  return (
    <div className="mb">
      <Hero row={row} busy={busy} call={call} isOwner={isOwner} checkedAt={checkedAt} />
      {msg ? <p className="small neg mb-msg" role="alert">{msg}</p> : null}
      {flags.length ? (
        <ul className="dl-flags small mb-flags">
          {flags.map((f) => (
            <li key={f.code} className={URGENT.has(f.code) ? 'neg' : 'dp-warn'}>
              {f.message}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mb-two">
        <Position row={row} />
        <Orders row={row} botBuys={botBuys} />
      </div>
      <QuickActions row={row} busy={busy} setBusy={setBusy} setMsg={setMsg} reload={load} isOwner={isOwner} />
      <YourSettings row={row} busy={busy} call={call} isOwner={isOwner} userId={user?.id} />
      <Activity log={log} lastRun={row.last_run_at} />
    </div>
  );
}
