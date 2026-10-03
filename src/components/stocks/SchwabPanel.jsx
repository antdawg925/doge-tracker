import { useEffect, useState } from 'react';
import { authedFetch } from '../../lib/api.js';
import { BrandMark } from '../BrandMark.jsx';

const fmtLeft = (ms) => {
  if (ms == null) return '—';
  const h = ms / 3600_000;
  if (h >= 48) return `${Math.floor(h / 24)} days`;
  if (h >= 24) return '1 day';
  if (h >= 1) return `${Math.floor(h)} h`;
  return `${Math.max(1, Math.round(ms / 60_000))} min`;
};
const ptWhen = (iso) =>
  iso ? new Date(iso).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';

/**
 * Connect Schwab · account · Live switch (confirm) · kill switch. Orders: protective STOPs only,
 * for shares you hold at Schwab, on positions you mark Live.
 */
export default function SchwabPanel({ schwab, onChanged, onError }) {
  const { status, reload } = schwab;
  const c = status?.connection;
  const [busy, setBusy] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState('');

  // Return from Schwab: #schwab-finish=<one-time code> → confirm under this login.
  useEffect(() => {
    const m = window.location.hash.match(/schwab-finish=([A-Za-z0-9_-]+)/);
    const q = new URLSearchParams(window.location.search);
    if (m) {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
      setBusy('finish');
      authedFetch('/api/schwab/finish', { method: 'POST', body: { code: m[1] } })
        .then((r) => setNotice(r.needsAccount ? 'Schwab connected. Pick the account the bot manages.' : 'Schwab connected.'))
        .catch((e) => onError?.(e.message))
        .finally(() => {
          setBusy('');
          reload();
        });
    } else if (q.get('schwab') === 'error') {
      onError?.(`Schwab sign-in didn't finish (${q.get('reason') || 'error'}). Nothing was connected; try Connect Schwab again.`);
      q.delete('schwab');
      q.delete('reason');
      window.history.replaceState(null, '', `${window.location.pathname}${q.toString() ? `?${q}` : ''}`);
    }
  }, [reload, onError]);

  const act = async (key, path, body) => {
    setBusy(key);
    try {
      const r = await authedFetch(path, { method: 'POST', body });
      await reload();
      await onChanged?.();
      return r;
    } catch (e) {
      onError?.(e.message);
      return null;
    } finally {
      setBusy('');
    }
  };
  const connect = async () => {
    setBusy('connect');
    try {
      const r = await authedFetch('/api/schwab/connect', { method: 'POST', body: {} });
      window.location.assign(r.url);
    } catch (e) {
      onError?.(e.message);
      setBusy('');
    }
  };

  if (!status || status.forbidden) return null;
  if (!status.configured) return <div className="stk-schwab small muted">Schwab: not configured on the server yet.</div>;

  const expired = c?.status === 'expired';
  const soon = c && !expired && c.expiresInMs != null && c.expiresInMs < 2 * 86400_000;
  const needAccount = c && !expired && !c.accounts.some((a) => a.selected);

  return (
    <div className={`stk-schwab${c?.killSwitch ? ' stk-schwab--killed' : ''}`}>
      {c?.killSwitch ? (
        <div className="stk-schwab__kill" role="alert">
          <strong>LIVE ORDERS PAUSED</strong> — the bot sends no Schwab order actions (no place, move or cancel). Your orders at Schwab stay as they are.
          <button type="button" className="btn btn--ghost stk-btn" disabled={Boolean(busy)} onClick={() => act('kill', '/api/schwab/kill', { on: false })}>
            Resume live orders
          </button>
        </div>
      ) : null}
      <div className="stk-schwab__row">
        {c ? <BrandMark brand="schwab" height={20} className="stk-schwab__logo" /> : <strong className="stk-schwab__title">Schwab</strong>}
        {!c ? (
          <>
            <span className="small muted">Not connected · stops are watch-only + paper.</span>
            <button type="button" className="btn btn--primary stk-btn stk-btn--brand" disabled={Boolean(busy)} onClick={connect}>
              <BrandMark brand="schwab" height={16} decorative />
              {busy === 'connect' || busy === 'finish' ? 'Connecting…' : 'Connect Schwab'}
            </button>
          </>
        ) : expired ? (
          <>
            <span className="neg small">Connection expired · the bot is watch-only for your Schwab stops (orders already at Schwab stay).</span>
            <button type="button" className="btn btn--primary stk-btn" disabled={Boolean(busy)} onClick={connect}>
              Reconnect
            </button>
          </>
        ) : (
          <>
            <span className={`small ${soon ? 'dp-warn' : 'pos'}`} title={`Schwab login ends ${ptWhen(c.refreshExpiresAt)} PT (7 days after connecting)`}>
              Schwab connected{c.accountLast4 ? ` · …${c.accountLast4}` : ''} · expires in {fmtLeft(c.expiresInMs)}
            </span>
            <button type="button" className={`btn ${soon ? 'btn--primary' : 'btn--ghost'} stk-btn`} disabled={Boolean(busy)} onClick={connect}>
              Reconnect
            </button>
            {c.accounts.length > 1 ? (
              <label className="small muted stk-schwab__acct">
                Account
                <select value={c.accounts.find((a) => a.selected)?.index ?? ''} disabled={Boolean(busy)} onChange={(e) => act('acct', '/api/schwab/account', { index: Number(e.target.value) })}>
                  {needAccount ? <option value="">Pick…</option> : null}
                  {c.accounts.map((a) => (
                    <option key={a.index} value={a.index}>
                      …{a.last4}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </>
        )}
      </div>

      {c && !expired ? (
        <div className="stk-schwab__row">
          <label className={`stk-switch${c.liveEnabled ? ' is-on' : ''}`}>
            <input
              type="checkbox"
              checked={c.liveEnabled}
              disabled={Boolean(busy) || needAccount}
              onChange={(e) => (e.target.checked ? setConfirming(true) : act('live', '/api/schwab/live', { enabled: false }))}
            />
            <span>Live Schwab stops {c.liveEnabled ? 'ON' : 'OFF'}</span>
          </label>
          <span className="small muted">
            {c.liveEnabled ? 'Only positions you mark Live below.' : 'Off: watch-only + paper.'} · {c.actionsToday}/{c.dailyCap} order actions today
          </span>
          {!c.killSwitch ? (
            <button type="button" className="btn stk-btn stk-kill" disabled={Boolean(busy)} onClick={() => act('kill', '/api/schwab/kill', { on: true })} title="Kill switch: stops every Schwab order action until you resume">
              Pause live orders entirely
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn--ghost stk-btn small"
            disabled={Boolean(busy)}
            onClick={() => window.confirm('Disconnect Schwab? Tokens are deleted; orders already at Schwab stay in place.') && act('disc', '/api/schwab/disconnect', {})}
          >
            Disconnect
          </button>
        </div>
      ) : null}

      {confirming ? (
        <div className="stk-schwab__confirm" role="dialog" aria-label="Turn on live Schwab stops">
          <p>
            <strong>Turn on LIVE Schwab stops for account …{c?.accountLast4}?</strong> The bot will place and move real <strong>STOP</strong> orders (good till canceled) at Schwab for positions you mark <em>Live</em>:
          </p>
          <ul className="small">
            <li>Protective stops only, for shares you actually hold there (never more; never opens positions; never market orders).</li>
            <li>Stops only tighten; at most one move per position per day after the close; nothing &gt; 15% in one step; max 20 order actions a day.</li>
            <li>A stop already through the price is not placed (you get a review alert). Your own Schwab stop is never duplicated.</li>
          </ul>
          <div className="stk-form__actions">
            <button
              type="button"
              className="btn btn--primary"
              disabled={Boolean(busy)}
              onClick={async () => {
                setConfirming(false);
                await act('live', '/api/schwab/live', { enabled: true, confirm: 'LIVE' });
              }}
            >
              Turn on live stops
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {notice ? <p className="small pos">{notice}</p> : null}
    </div>
  );
}

/** Per-position Live toggle + the bot's Schwab order state. */
export function LiveCell({ p, lo, conn, onToggle, onAdopt, onCancel, busy }) {
  const usable = conn && conn.status === 'connected' && conn.accounts?.some((a) => a.selected);
  const px = (n) => (Number.isFinite(Number(n)) && n != null ? `$${Number(n).toFixed(Number(n) < 1 ? 4 : 2)}` : '—');
  const f = lo?.flag;
  return (
    <div className="stk-live-cell">
      <label className={`stk-switch stk-switch--sm${p.live ? ' is-on' : ''}`} title={usable ? 'Let the bot manage a real Schwab stop for this position' : 'Connect Schwab and pick an account first'}>
        <input type="checkbox" checked={Boolean(p.live)} disabled={!usable || busy} onChange={(e) => onToggle(p, e.target.checked)} />
        <span>{p.live ? 'Live' : 'Off'}</span>
        {p.live ? <BrandMark brand="schwab" height={14} className="stk-live-cell__mark" /> : null}
      </label>
      {p.live && lo?.status === 'working' ? (
        <span className="small pos" title={`Order ${lo.order_id}${lo.adopted ? ' (yours, bot-managed)' : ''}`}>
          Schwab {px(lo.stop_price)} ×{Number(lo.qty)}
          {conn?.killSwitch ? null : (
            <button type="button" className="stk-linkbtn" disabled={busy} onClick={() => window.confirm(`Cancel the bot's Schwab stop order ${lo.order_id} for ${p.symbol}? Your shares will have no bot stop.`) && onCancel(p)}>
              cancel
            </button>
          )}
        </span>
      ) : null}
      {p.live && lo?.status === 'filled' ? <span className="small neg">Filled {px(lo.fill_price)}</span> : null}
      {p.live && f && f.code !== 'own_stop' ? <span className={`small ${f.code === 'kill_switch' || f.code === 'not_found' || f.code === 'stop_crossed' ? 'neg' : 'dp-warn'}`}>{f.message}</span> : null}
      {lo?.foreign_stops?.length && lo.status !== 'working' ? (
        <span className="small dp-warn stk-own">
          Your stop at Schwab:{' '}
          {lo.foreign_stops.map((o) => (
            <span key={o.orderId || o.stopPrice}>
              {o.orderType} {px(o.stopPrice)} ×{o.qty}{' '}
              {o.manageable && p.live ? (
                <button type="button" className="stk-linkbtn" disabled={busy} onClick={() => window.confirm(`Let the bot manage your Schwab order ${o.orderId}? It will then move that order (tighten only) instead of placing a new one.`) && onAdopt(p, o.orderId)}>
                  Let bot manage this order
                </button>
              ) : o.why ? (
                <span className="muted">({o.why})</span>
              ) : null}
            </span>
          ))}
        </span>
      ) : null}
    </div>
  );
}
