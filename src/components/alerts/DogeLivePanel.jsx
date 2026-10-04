import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../hooks/authContext.js';
import { authedFetch } from '../../lib/api.js';
import { supabase } from '../../lib/supabase.js';
import { BrandMark } from '../BrandMark.jsx';

/**
 * DOGE bottom stop on Kraken: one compact panel. The hero is the always-on stop (only moves
 * up). DRY-RUN until a trade key exists and the Live switch is on; the log shows every order
 * the bot would place / placed.
 */
const px = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : `$${Number(n).toFixed(4)}`);
const usd = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : `$${Math.round(Number(n)).toLocaleString('en-US')}`);
const qty = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : Math.round(Number(n)).toLocaleString('en-US'));
const pct = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : `${n >= 0 ? '+' : ''}${Number(n).toFixed(1)}%`);
const ptShort = (iso) =>
  iso ? new Date(iso).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';

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
  stop_raised: 'Stop raised',
  stop_lowered: 'Stop lowered',
  sell_requested: 'Sell requested',
  user_buy_filled: 'Your buy filled',
};
const ROLE_COPY = { stop: 'stop-loss', zone: 'zone sell', pot: 'pot buy', sell: 'sell now', orphan: 'old bot order', user: 'your order' };

const DEFAULTS = { bottomStop: '', startValue: 19000, startDate: '', startDoge: 110000, startUsd: 9000, potEnabled: false, potUsd: 9000, zonesEnabled: false, zones: [{ price: 0.2, keepPct: 40 }, { price: 0.3, keepPct: 20 }, { price: 0.4, keepPct: 10 }] };

function Settings({ config, isOwner, busy, onSave, fresh }) {
  const init = { ...DEFAULTS, ...(config || {}), bottomStop: config?.bottomStop ?? '', startDate: config?.startDate || new Date().toISOString().slice(0, 10) };
  const [f, setF] = useState(init);
  const [note, setNote] = useState(null);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
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
    onSave({
      ...f,
      bottomStop: f.bottomStop === '' ? null : Number(f.bottomStop),
      startValue: Number(f.startValue),
      startDoge: Number(f.startDoge),
      startUsd: Number(f.startUsd),
      potUsd: Number(f.potUsd),
      zones: f.zones.map((z) => ({ price: Number(z.price), keepPct: Number(z.keepPct) })),
    });
  };
  return (
    <form className="dl-form" onSubmit={submit}>
      <div className="dl-form__row">
        {fresh ? (
          <label>
            Bottom stop $<input type="number" step="0.0001" min="0" required value={f.bottomStop} onChange={set('bottomStop')} />
          </label>
        ) : null}
        <label>Start value $<input type="number" step="any" min="1" value={f.startValue} onChange={set('startValue')} /></label>
        <label>Start date<input type="date" value={f.startDate} onChange={set('startDate')} /></label>
        <label>DOGE<input type="number" step="any" min="0" value={f.startDoge} onChange={set('startDoge')} /></label>
        <label>USD<input type="number" step="any" min="0" value={f.startUsd} onChange={set('startUsd')} /></label>
      </div>
      <div className="dl-form__row">
        <label className="dl-check">
          <input type="checkbox" checked={Boolean(f.potEnabled)} onChange={set('potEnabled')} /> Breakout pot buy
        </label>
        {f.potEnabled ? <label>Pot $<input type="number" step="any" min="0" value={f.potUsd} onChange={set('potUsd')} /></label> : null}
        <label className="dl-check">
          <input type="checkbox" checked={Boolean(f.zonesEnabled)} onChange={set('zonesEnabled')} /> Zone sells
        </label>
        {f.zonesEnabled
          ? f.zones.map((z, i) => (
              <span key={i} className="dl-zone">
                {i + 1}: <input aria-label={`Zone ${i + 1} price`} type="number" step="any" min="0" value={z.price} onChange={setZone(i, 'price')} />
                keep <input aria-label={`Zone ${i + 1} keep %`} type="number" step="any" min="0" max="100" value={z.keepPct} onChange={setZone(i, 'keepPct')} />%
              </span>
            ))
          : null}
      </div>
      <div className="dl-form__row">
        {isOwner ? (
          <button type="button" className="btn btn--ghost stk-btn" disabled={busy} onClick={fromKraken}>
            Use my Kraken balances
          </button>
        ) : null}
        <button type="submit" className="btn btn--primary stk-btn" disabled={busy}>
          {fresh ? 'Start' : 'Save'}
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
  const [raiseTo, setRaiseTo] = useState('');
  const [lowering, setLowering] = useState(false);
  const [lowerTo, setLowerTo] = useState('');
  const [lowerWord, setLowerWord] = useState('');

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
  const stopped = row?.status === 'stopped' || row?.status === 'ended';
  const b = s?.bottom || {};
  const stopPx = row?.state?.stopPx ?? b.price ?? null;
  const dist = stopPx && s?.price ? (s.price / stopPx - 1) * 100 : null;
  const raiseVal = Number(raiseTo);
  const raiseOk = raiseTo !== '' && raiseVal > (stopPx || 0) && (!s?.bid || raiseVal < s.bid);
  const hideFlags = new Set(['dry_fill', 'stopped']);
  const flags = (s?.flags || []).filter((f) => !hideFlags.has(f.code));

  return (
    <section className={`card dl${live ? ' dl--live' : ''}${row?.kill_switch ? ' dl--killed' : ''}`}>
      <div className="card__head dl__head">
        <h2 className="card__title">
          DOGE bottom stop <BrandMark brand="kraken" height={12} />
        </h2>
        {row ? (
          <span className={`dl-mode ${live ? 'dl-mode--live' : ''}`} title={live ? 'Real Kraken orders' : 'Computes and logs orders; places nothing'}>
            {live ? 'LIVE' : 'DRY-RUN'}
          </span>
        ) : null}
      </div>

      {!row ? (
        <>
          <p className="small muted">One Kraken stop-loss under all your DOGE that only moves up. Starts in dry-run.</p>
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

          <div className="dl-hero">
            <div className="dl-hero__main">
              <div className="dl-hero__label small muted">Stop {stopped ? '(filled)' : ''}</div>
              <div className="dl-hero__px mono">{px(stopPx)}</div>
              <div className="small">
                <span className="mono">{px(s?.price)}</span> now · <span className={dist != null && dist < 3 ? 'neg' : ''}>{dist != null ? `${dist.toFixed(1)}% above stop` : '—'}</span>
              </div>
            </div>
            <dl className="dl-hero__facts small">
              <div>
                <dt>Covers</dt>
                <dd className="mono">{s?.stop ? `${qty(s.stop.qty)} DOGE` : '—'}</dd>
              </div>
              <div>
                <dt>Last set</dt>
                <dd title={b.reason || row?.state?.stopReason || ''}>
                  {ptShort(row?.state?.stopSetAt)} PT · <span className="muted">{row?.state?.stopReason || '—'}</span>
                </dd>
              </div>
              <div>
                <dt>Auto-raise to</dt>
                <dd className="mono" title={`ATR trail = 4h high close ${px(b.hc)} − ${b.trailMult ?? '—'}×ATR; lock price applies once the account lock is active`}>
                  trail {px(b.trail)}
                  {b.lockPx ? ` · lock ${px(b.lockPx)}` : ''}
                </dd>
              </div>
            </dl>
          </div>

          {!stopped ? (
            <div className="dl-actions dl-raise">
              <input type="number" step="0.0001" min="0" placeholder={stopPx ? (stopPx * 1.02).toFixed(4) : '0.0890'} value={raiseTo} onChange={(e) => setRaiseTo(e.target.value)} aria-label="New stop price" />
              <button type="button" className="btn btn--primary stk-btn" disabled={busy || !raiseOk} title={raiseTo !== '' && !raiseOk ? 'Must be above the current stop and below the market' : ''} onClick={async () => (await call('stop', { price: raiseVal })) && setRaiseTo('')}>
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
                <button type="button" className="btn btn--ghost stk-btn dl-lower" disabled={busy} onClick={() => setLowering((v) => !v)}>
                  Lower stop…
                </button>
              ) : null}
            </div>
          ) : (
            <p className="small neg dl-note">{row?.state?.endReason || 'Bottom stop filled.'} No re-entry; Start new plan to protect again.</p>
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

          <dl className="dl-stats dl-stats--small">
            <div>
              <dt>Account · HWM</dt>
              <dd>
                {usd(s?.account)}
                <span className="small muted"> · {usd(s?.hwm)}</span>
              </dd>
            </div>
            <div>
              <dt>Locked</dt>
              <dd className={s?.lockActive ? 'pos' : ''}>{s?.lockActive ? usd(s.lock) : <span className="small muted">at {usd(s?.lockActivatesAt)}</span>}</dd>
            </div>
            <div>
              <dt>Holding</dt>
              <dd className="small">
                {qty(s?.book?.doge)} DOGE + {usd(s?.book?.usd)}
                <span className="muted"> {s?.bookSource === 'kraken' ? '(Kraken)' : '(plan)'}</span>
              </dd>
            </div>
          </dl>

          {s?.userBuys?.length ? (
            <div className="dl-buys small">
              <span className="muted">Your buy orders (coached on Telegram, never changed): </span>
              {s.userBuys.map((o) => (
                <span key={o.txid} className="mono dl-buy">
                  {qty(o.qty)} @ {px(o.price)} <span className="muted">({pct(o.distPct)})</span>
                </span>
              ))}
            </div>
          ) : null}

          {flags.length ? (
            <ul className="dl-flags small">
              {flags.map((f) => (
                <li key={f.code} className={['stop_crossed', 'kill_switch', 'no_trade_key', 'order_gone', 'no_stop_level'].includes(f.code) ? 'neg' : 'dp-warn'}>
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
                        {ROLE_COPY[l.role] || l.role} <span className="mono">{px(l.price)} × {qty(l.qty)}</span>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="small muted">No orders yet.</p>
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
              className={`btn ${stopped ? 'btn--primary' : 'btn--ghost'} stk-btn`}
              disabled={busy}
              onClick={() => window.confirm('Start a new plan? The stop restarts at the bottom stop in Settings; HWM and lock reset.') && call('new-plan', { confirm: 'NEW' })}
            >
              Start new plan
            </button>
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
          {showSettings ? <Settings key={JSON.stringify(row.config)} config={row.config} isOwner={isOwner} busy={busy} fresh={false} onSave={async (config) => (await call('save', { config })) && setShowSettings(false)} /> : null}
        </>
      )}
      {msg ? <p className="small neg">{msg}</p> : null}
    </section>
  );
}
