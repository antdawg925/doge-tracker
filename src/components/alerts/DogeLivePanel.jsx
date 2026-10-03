import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../hooks/authContext.js';
import { authedFetch } from '../../lib/api.js';
import { supabase } from '../../lib/supabase.js';
import { BrandMark } from '../BrandMark.jsx';

/**
 * DOGE live plan on Kraken (Round 4): one compact panel. DRY-RUN until a trade key exists and
 * the Live switch is on; the log shows every order the bot would place / placed.
 */
const px = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : `$${Number(n).toFixed(4)}`);
const usd = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : `$${Math.round(Number(n)).toLocaleString('en-US')}`);
const qty = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : Math.round(Number(n)).toLocaleString('en-US'));
const ptShort = (iso) =>
  iso ? new Date(iso).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
const dayLabel = (d) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
const yes = (b) => (b ? '✓' : '✗');

const LOG_COPY = {
  would_place: 'Would place',
  would_amend: 'Would move',
  would_cancel: 'Would cancel',
  dry_fill: 'Dry fill',
  placed: 'Placed',
  amended: 'Moved',
  cancelled: 'Cancelled',
  filled: 'Filled',
  partial: 'Partial fill',
  refused: 'Refused',
  skipped: 'Skipped',
  error: 'Error',
  unfilled: 'Unfilled',
  amend_failed: 'Amend failed',
  plan_started: 'Plan started',
  plan_restarted: 'New plan',
  config_saved: 'Settings saved',
  kill_on: 'Kill switch on',
  kill_off: 'Kill switch off',
  live_on: 'Live on',
  live_off: 'Live off',
};
const ROLE_COPY = { stop: 'stop', zone: 'zone sell', pot: 'pot buy', orphan: 'old bot order' };

const DEFAULTS = { startValue: 19000, startDate: '', startDoge: 110000, startUsd: 9000, potUsd: 9000, zones: [{ price: 0.2, keepPct: 40 }, { price: 0.3, keepPct: 20 }, { price: 0.4, keepPct: 10 }] };

function Settings({ config, isOwner, busy, onSave, fresh }) {
  const init = { ...DEFAULTS, ...(config || {}), startDate: config?.startDate || new Date().toISOString().slice(0, 10) };
  const [f, setF] = useState(init);
  const [note, setNote] = useState(null);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const setZone = (i, k) => (e) => setF((x) => ({ ...x, zones: x.zones.map((z, j) => (j === i ? { ...z, [k]: e.target.value } : z)) }));
  const fromKraken = async () => {
    setNote('Reading Kraken…');
    try {
      const r = await authedFetch('/api/bot/doge-live/balances', { method: 'POST', body: {} });
      setF((x) => ({ ...x, startDoge: Math.floor(r.doge), startUsd: Math.floor(r.usd * 100) / 100, startValue: r.value ? Math.round(r.value) : x.startValue, potUsd: Math.min(Number(x.potUsd) || 0, Math.floor(r.usd)) }));
      setNote(`Kraken now: ${qty(r.doge)} DOGE + ${usd(r.usd)} at ${px(r.price)} = ${usd(r.value)}`);
    } catch (e) {
      setNote(e.message);
    }
  };
  const submit = (e) => {
    e.preventDefault();
    onSave({ ...f, startValue: Number(f.startValue), startDoge: Number(f.startDoge), startUsd: Number(f.startUsd), potUsd: Number(f.potUsd), zones: f.zones.map((z) => ({ price: Number(z.price), keepPct: Number(z.keepPct) })) });
  };
  return (
    <form className="dl-form" onSubmit={submit}>
      <div className="dl-form__row">
        <label>Start value $<input type="number" step="any" min="1" value={f.startValue} onChange={set('startValue')} /></label>
        <label>Start date<input type="date" value={f.startDate} onChange={set('startDate')} /></label>
        <label>DOGE<input type="number" step="any" min="0" value={f.startDoge} onChange={set('startDoge')} /></label>
        <label>USD<input type="number" step="any" min="0" value={f.startUsd} onChange={set('startUsd')} /></label>
        <label>Pot $<input type="number" step="any" min="0" value={f.potUsd} onChange={set('potUsd')} /></label>
      </div>
      <div className="dl-form__row">
        {f.zones.map((z, i) => (
          <span key={i} className="dl-zone">
            Zone {i + 1} <input aria-label={`Zone ${i + 1} price`} type="number" step="any" min="0" value={z.price} onChange={setZone(i, 'price')} />
            keep <input aria-label={`Zone ${i + 1} keep %`} type="number" step="any" min="0" max="100" value={z.keepPct} onChange={setZone(i, 'keepPct')} />%
          </span>
        ))}
      </div>
      <div className="dl-form__row">
        {isOwner ? (
          <button type="button" className="btn btn--ghost stk-btn" disabled={busy} onClick={fromKraken}>
            Use my Kraken balances
          </button>
        ) : null}
        <button type="submit" className="btn btn--primary stk-btn" disabled={busy}>
          {fresh ? 'Start plan' : 'Save'}
        </button>
        {note ? <span className="small muted">{note}</span> : null}
      </div>
    </form>
  );
}

export default function DogeLivePanel({ refreshKey }) {
  const { user, isOwner } = useAuth();
  const [row, setRow] = useState(undefined);
  const [log, setLog] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [confirmLive, setConfirmLive] = useState(false);

  const load = useCallback(async () => {
    if (!supabase || !user) return;
    const [p, l] = await Promise.all([
      supabase.from('doge_live_plans').select('*').eq('user_id', user.id).maybeSingle(),
      supabase.from('doge_live_log').select('id, at, mode, role, action, status, side, ordertype, price, qty, reason').eq('user_id', user.id).neq('action', 'flag').order('at', { ascending: false }).limit(10),
    ]);
    setRow(p.data ?? null);
    setLog(l.data ?? []);
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

  if (row === undefined) return null;
  const s = row?.snapshot;
  const live = s?.mode === 'live';
  const ended = row?.status === 'ended';

  return (
    <section className={`card dl${live ? ' dl--live' : ''}${row?.kill_switch ? ' dl--killed' : ''}`}>
      <div className="card__head dl__head">
        <h2 className="card__title">
          DOGE plan <BrandMark brand="kraken" height={12} />
        </h2>
        {row ? (
          <span className={`dl-mode ${live ? 'dl-mode--live' : ''}`} title={live ? 'Real Kraken orders' : 'Computes and logs orders; places nothing'}>
            {live ? 'LIVE' : 'DRY-RUN'}
          </span>
        ) : null}
      </div>

      {!row ? (
        <>
          <p className="small muted">Pot breakout buy, pot stop, account lock stop and zone sells as Kraken orders. Starts in dry-run.</p>
          <Settings config={null} isOwner={isOwner} busy={busy} fresh onSave={(config) => call('save', { config, startNew: true })} />
        </>
      ) : (
        <>
          {row.kill_switch ? (
            <div className="dl-kill" role="alert">
              <strong>KILL SWITCH ON</strong> · bot orders cancelled, nothing placed.
              <button type="button" className="btn btn--ghost stk-btn" disabled={busy} onClick={() => call('kill', { on: false })}>
                Resume
              </button>
            </div>
          ) : null}
          <dl className="dl-stats">
            <div>
              <dt>Start</dt>
              <dd>{usd(s?.startValue ?? row.config?.startValue)}<span className="small muted"> · {dayLabel(s?.startDate ?? row.config?.startDate)}</span></dd>
            </div>
            <div>
              <dt>Account · HWM</dt>
              <dd>{usd(s?.account)}<span className="small muted"> · {usd(s?.hwm)}</span></dd>
            </div>
            <div>
              <dt>Locked</dt>
              <dd className={s?.lockActive ? 'pos' : ''}>{s?.lockActive ? usd(s.lock) : <span className="small muted">at {usd(s?.lockActivatesAt)}</span>}</dd>
            </div>
            <div>
              <dt>Stop</dt>
              <dd className="mono">
                {s?.stop ? (
                  <>
                    {px(s.stop.price)}
                    <span className="small muted"> × {qty(s.stop.qty)} · {s.stop.kind === 'lock' ? 'lock' : 'pot'}</span>
                  </>
                ) : (
                  <span className="small muted">{s?.lockActive ? 'none (cash covers lock)' : 'none yet'}</span>
                )}
              </dd>
            </div>
            <div>
              <dt>Next zone</dt>
              <dd className="mono">
                {s?.zone ? (
                  <>
                    {px(s.zone.price)}
                    <span className="small muted"> sell {qty(s.zone.sellQty)} → {s.zone.keepPct}%{s.zone.armed ? ' · armed' : ''}</span>
                  </>
                ) : (
                  <span className="small muted">all done</span>
                )}
              </dd>
            </div>
            <div>
              <dt>Breakout</dt>
              <dd className="mono">
                {s?.pot?.status === 'waiting' ? (
                  <>
                    {px(s?.signal?.trigger)}
                    <span className="small muted" title={`DOGE close ${px(s?.signal?.close)} vs SMA50 ${px(s?.signal?.sma50)}; BTC ${usd(s?.signal?.btcClose)} vs SMA50 ${usd(s?.signal?.btcSma)}`}>
                      {' '}
                      SMA50 {yes(s?.signal?.aboveSma)} BTC {yes(s?.signal?.btcOk)}
                    </span>
                  </>
                ) : s?.pot?.status === 'held' ? (
                  <span className="small">pot {qty(s.pot.qty)} @ {px(s.pot.price)}</span>
                ) : (
                  <span className="small muted">pot {s?.pot?.status || '—'}</span>
                )}
              </dd>
            </div>
          </dl>

          {ended ? <p className="small neg dl-note">Plan ended (lock stop filled). No re-entry; start a new plan to continue.</p> : null}
          {s?.flags?.filter((f) => !['dry_fill', 'ended'].includes(f.code)).length ? (
            <ul className="dl-flags small">
              {s.flags
                .filter((f) => !['dry_fill', 'ended'].includes(f.code))
                .map((f) => (
                  <li key={f.code} className={['stop_crossed', 'kill_switch', 'no_trade_key'].includes(f.code) ? 'neg' : 'dp-warn'}>
                    {f.message}
                  </li>
                ))}
            </ul>
          ) : null}

          <div className="dl-log">
            <div className="small muted dl-log__head">
              {live ? 'Order log' : 'Dry-run log (would place)'} · last run {ptShort(row.last_run_at)} PT
            </div>
            {log.length ? (
              <ul>
                {log.map((l) => (
                  <li key={l.id} className="small" title={l.reason || ''}>
                    <span className="muted">{ptShort(l.at)}</span>{' '}
                    <span className={l.status === 'error' || l.status === 'refused' ? 'neg' : l.mode === 'live' ? 'pos' : ''}>
                      {l.mode === 'live' ? 'LIVE ' : ''}
                      {LOG_COPY[l.status] || l.status}
                    </span>{' '}
                    {l.role === 'plan' ? (
                      <span className="muted">{l.reason}</span>
                    ) : (
                      <>
                        {ROLE_COPY[l.role] || l.role} {l.side} {l.ordertype} <span className="mono">{qty(l.qty)} @ {px(l.price)}</span>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="small muted">No orders yet: nothing to place at current prices.</p>
            )}
          </div>

          <div className="dl-actions">
            <label className={`stk-switch stk-switch--sm${row.live_enabled ? ' is-on' : ''}`} title={s?.tradeKeyConfigured ? 'Place real Kraken orders' : 'Needs a Kraken trade key (KRAKEN_TRADE_KEY / KRAKEN_TRADE_SECRET) in the server env'}>
              <input
                type="checkbox"
                checked={Boolean(row.live_enabled)}
                disabled={busy || (!row.live_enabled && (!isOwner || !s?.tradeKeyConfigured))}
                onChange={(e) => (e.target.checked ? setConfirmLive(true) : call('live', { enabled: false }))}
              />
              <span>Live{!s?.tradeKeyConfigured ? ' (no trade key)' : ''}</span>
            </label>
            {!row.kill_switch ? (
              <button type="button" className="btn stk-btn stk-kill" disabled={busy} onClick={() => window.confirm('Kill switch: cancel every bot order on Kraken and place nothing until you resume?') && call('kill', { on: true })}>
                Kill switch
              </button>
            ) : null}
            <button type="button" className="btn btn--ghost stk-btn" disabled={busy} onClick={() => setShowSettings((v) => !v)}>
              {showSettings ? 'Hide settings' : 'Settings'}
            </button>
            <button
              type="button"
              className={`btn ${ended ? 'btn--primary' : 'btn--ghost'} stk-btn`}
              disabled={busy}
              onClick={() => window.confirm('Start a new plan? HWM, lock, pot and zones reset (bot orders from the old plan are cancelled).') && call('new-plan', { confirm: 'NEW' })}
            >
              Start new plan
            </button>
          </div>
          {confirmLive ? (
            <div className="stk-schwab__confirm dl-confirm" role="dialog" aria-label="Turn on live Kraken orders">
              <span className="small">
                Turn on LIVE: the bot will place, move and cancel real Kraken orders on XDGUSD (stop-loss, zone limits, the one-time pot buy). Kill switch stays one click away.
              </span>
              <button type="button" className="btn btn--primary stk-btn" disabled={busy} onClick={async () => (await call('live', { enabled: true, confirm: 'LIVE' })) && setConfirmLive(false)}>
                Go live
              </button>
              <button type="button" className="btn btn--ghost stk-btn" onClick={() => setConfirmLive(false)}>
                Cancel
              </button>
            </div>
          ) : null}
          {showSettings ? <Settings key={JSON.stringify(row.config)} config={row.config} isOwner={isOwner} busy={busy} fresh={false} onSave={async (config) => (await call('save', { config })) && setShowSettings(false)} /> : null}
        </>
      )}
      {msg ? <p className="small neg">{msg}</p> : null}
    </section>
  );
}
