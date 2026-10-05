import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchYahooChart } from '../../lib/yahoo.js';
import { useAuth } from '../../hooks/authContext.js';
import { authedFetch } from '../../lib/api.js';
import { supabase } from '../../lib/supabase.js';
import { SHORT_KINGS_WATCHLIST } from '../../lib/shortKings.js';
import PlanTrade from './PlanTrade.jsx';
import PaperBar from './PaperBar.jsx';
import SchwabPanel, { LiveCell } from './SchwabPanel.jsx';
import DipPlansPanel from './DipPlansPanel.jsx';
import useSchwabStatus from './useSchwabStatus.js';
import { paperTally } from '../../../shared/stockPaper.js';

// Watch-only: the server tells you where to put the stop; you move it at Schwab.
const REFRESH_MS = 60_000;

const px = (n) =>
  Number.isFinite(n) ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 4 : 2 })}` : '—';
const signed = (n, f) => (Number.isFinite(n) ? `${n < 0 ? '−' : '+'}${f(Math.abs(n))}` : '—');
const pct = (n, d = 1) => (Number.isFinite(n) ? `${n.toFixed(d)}%` : '—');
const ptTime = (iso) =>
  iso
    ? new Date(iso).toLocaleString('en-US', {
        timeZone: 'America/Los_Angeles',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : '—';
/** A stop move in the last 3 days still reads as an action ("Raise to $X, was $Y"). */
const recentMove = (m) => Boolean(m?.day) && Date.now() - Date.parse(`${m.day}T12:00:00Z`) < 3 * 86400000;
const todayEt = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());

const DECISION = {
  hold: 'Hold',
  stop_set: 'Stop set',
  stop_raised: 'Stop raised',
  stop_lowered: 'Stop lowered',
  near_stop: 'Near stop',
  stop_hit: 'Stop hit',
  squeeze_warning: 'Squeeze',
  earnings_soon: 'Earnings',
  error: 'Error',
};
const TONE = { stop_raised: 'pos', stop_lowered: 'pos', stop_set: 'pos', stop_hit: 'neg', squeeze_warning: 'dp-warn', near_stop: 'dp-warn', earnings_soon: 'dp-warn', error: 'dp-warn' };

const EMPTY = { symbol: '', side: 'long', shares: '', entry_price: '', entry_date: '', risk_usd: '100', notes: '' };

async function loadStocks(userId) {
  const [pos, stops, alerts, orders, guard, live, prefs] = await Promise.all([
    supabase.from('stock_positions').select('*').eq('user_id', userId).order('created_at', { ascending: true }),
    supabase.from('stock_stops').select('position_id, stop, initial_stop, data, updated_at').eq('user_id', userId),
    supabase.from('stock_alert_log').select('id, symbol, fired_at, kind, title, message').eq('user_id', userId).order('fired_at', { ascending: false }).limit(20),
    supabase.from('stock_paper_orders').select('*').eq('user_id', userId),
    supabase.from('stock_guard').select('*').eq('user_id', userId).eq('book', 'stocks').maybeSingle(),
    supabase.from('stock_live_orders').select('*').eq('user_id', userId),
    supabase.from('stop_reminder_prefs').select('symbol, remind').eq('user_id', userId),
  ]);
  const err = [pos, stops, alerts, orders, guard, live].find((r) => r.error)?.error;
  if (err) throw new Error(err.message);
  return {
    positions: pos.data,
    stops: new Map(stops.data.map((s) => [s.position_id, s])),
    alerts: alerts.data,
    orders: new Map(orders.data.map((o) => [o.position_id, o])),
    tally: paperTally(orders.data),
    guard: guard.data,
    live: new Map((live.data || []).map((o) => [o.position_id, o])),
    prefs: new Map((prefs.data || []).map((r) => [r.symbol, r.remind])),
  };
}

/** Missing-stop reminders: TSLA (long-term hold) is off by default; everything else on. */
const REMIND_OFF_BY_DEFAULT = new Set(['TSLA']);
const remindOn = (prefs, symbol) => (prefs?.has(symbol) ? Boolean(prefs.get(symbol)) : !REMIND_OFF_BY_DEFAULT.has(symbol));

function Flags({ f }) {
  if (!f) return <span className="muted">—</span>;
  const out = [];
  if (f.squeezeToday || f.squeezeAt) out.push(<span key="sq" className="stk-flag stk-flag--neg" title={`Up day on ≥3× avg volume${f.squeezeAt ? ` (${f.squeezeAt})` : ''}; trail tightened to 1.5 ATR`}>Squeeze</span>);
  if (f.si) out.push(<span key="si" className="stk-flag stk-flag--warn" title={`Short interest ${f.siPct != null ? `${(f.siPct * 100).toFixed(1)}% of float` : 'n/a'} · ${f.daysToCover ?? '—'} days to cover. Started at 2.5 ATR.`}>SI {f.siPct != null ? `${Math.round(f.siPct * 100)}%` : ''}</span>);
  if (f.earningsSoon) out.push(<span key="er" className="stk-flag stk-flag--warn" title={`Earnings ${f.earningsDate}`}>ER {f.earningsDate?.slice(5)}</span>);
  if (f.profitTight) out.push(<span key="pt" className="stk-flag" title="Profit ≥ 20%: trail at 2 ATR">2 ATR</span>);
  if (!out.length) return <span className="muted">—</span>;
  return <span className="stk-flags">{out}</span>;
}

const PAPER_COPY = {
  placed: 'Paper placed', modified: 'Paper moved', filled: 'Paper filled', closed: 'Paper closed', blocked: 'Paper blocked',
  live_placed: 'LIVE placed', live_modified: 'LIVE moved', live_filled: 'LIVE filled', live_canceled: 'LIVE canceled', live_flag: 'LIVE note',
  live_error: 'LIVE error', live_adopted: 'LIVE adopted', live_setting: 'LIVE', live_request: 'LIVE req',
};
const PAPER_TONE = {
  placed: 'dp-buy', modified: 'pos', filled: 'neg', closed: 'muted', blocked: 'dp-warn',
  live_placed: 'dp-buy', live_modified: 'pos', live_filled: 'neg', live_canceled: 'muted', live_flag: 'dp-warn', live_error: 'neg', live_adopted: 'pos', live_setting: 'muted',
};

function PositionLog({ positionId }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    let live = true;
    Promise.all([
      supabase
        .from('stock_runs')
        .select('id, ran_at, pass, decision, price, stop, reason, error')
        .eq('position_id', positionId)
        .neq('decision', 'hold')
        .order('ran_at', { ascending: false })
        .limit(15),
      supabase
        .from('stock_paper_events')
        .select('id, at, kind, old_price, new_price, fill_price, pnl, reason, guard_note')
        .eq('position_id', positionId)
        .neq('kind', 'live_request')
        .order('at', { ascending: false })
        .limit(15),
    ]).then(([runs, ev]) => {
      if (!live) return;
      const a = (runs.data || []).map((r) => ({ ...r, key: `r${r.id}`, t: r.ran_at }));
      const b = (ev.data || []).map((e) => ({
        key: `p${e.id}`,
        t: e.at,
        ran_at: e.at,
        paperKind: e.kind,
        price: e.fill_price ?? e.new_price,
        reason:
          e.kind === 'modified'
            ? `${px(e.old_price)} → ${px(e.new_price)}${e.guard_note ? ` (${e.guard_note})` : ''}`
            : e.kind === 'filled' || e.kind === 'closed'
              ? `${e.reason} · P/L ${signed(e.pnl, (x) => `$${x.toFixed(2)}`)}${e.guard_note ? ` (${e.guard_note})` : ''}`
              : e.reason,
      }));
      setRows([...a, ...b].sort((x, y) => Date.parse(y.t) - Date.parse(x.t)).slice(0, 20));
    });
    return () => {
      live = false;
    };
  }, [positionId]);
  if (!rows) return <p className="muted small">Loading…</p>;
  if (!rows.length) return <p className="muted small">No decisions yet (holds aren’t listed).</p>;
  return (
    <ul className="bot-log">
      {rows.map((r) => (
        <li key={r.key} className="bot-log__item">
          <span className="muted small mono">{ptTime(r.ran_at)}</span>
          {r.paperKind ? (
            <span className={`bot-log__decision ${PAPER_TONE[r.paperKind] || ''}`}>{PAPER_COPY[r.paperKind]}</span>
          ) : (
            <span className={`bot-log__decision ${TONE[r.decision] || ''}`}>{DECISION[r.decision] || r.decision}</span>
          )}
          <span className="mono small">{px(r.price)}</span>
          <span className="bot-log__reason muted small">{r.decision === 'error' ? r.error : r.reason}</span>
        </li>
      ))}
    </ul>
  );
}

const roundPx = (v) => (v >= 1 ? Math.round(v * 100) / 100 : Math.round(v * 10000) / 10000);
const ptClock = (d) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' });

/** New positions only: pull the live price for the symbol and fill Entry $ unless the user typed one. */
function useLiveEntry({ symbol, editing, setDraft }) {
  const touched = useRef(false);
  const [live, setLive] = useState(null); // { symbol, price, at } | { symbol, error } | { symbol, loading }
  const seq = useRef(0);
  const pull = useCallback(
    async (sym, { force = false } = {}) => {
      const s = String(sym || '').trim().toUpperCase();
      if (editing || !/^[A-Z][A-Z0-9.^=-]{0,9}$/.test(s)) return;
      const id = ++seq.current;
      if (force) touched.current = false;
      setLive((l) => ({ ...(l?.symbol === s ? l : {}), symbol: s, loading: true }));
      try {
        const q = await fetchYahooChart(s, '5d', { interval: '1d' });
        if (id !== seq.current) return;
        const price = Number(q?.spot);
        if (!Number.isFinite(price) || price <= 0) throw new Error('no price');
        setLive({ symbol: s, price: roundPx(price), at: new Date() });
        if (!touched.current) setDraft((d) => (d && d.symbol.trim().toUpperCase() === s ? { ...d, entry_price: String(roundPx(price)) } : d));
      } catch {
        if (id === seq.current) setLive({ symbol: s, error: true });
      }
    },
    [editing, setDraft],
  );
  // Debounced on symbol change (covers typed symbols and presets).
  useEffect(() => {
    if (editing) return undefined;
    const s = String(symbol || '').trim().toUpperCase();
    if (!s) {
      setLive(null);
      return undefined;
    }
    if (live?.symbol === s && (live.loading || live.price)) return undefined;
    const t = setTimeout(() => pull(s), 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, editing, pull]);
  return { live, pull, touch: () => (touched.current = true) };
}

function PositionForm({ draft, setDraft, onSave, onCancel, onClose, onDelete, busy, editing }) {
  const set = (k) => (e) => setDraft((d) => ({ ...d, [k]: e.target.value }));
  const { live, pull, touch } = useLiveEntry({ symbol: draft.symbol, editing, setDraft });
  const sym = draft.symbol.trim().toUpperCase();
  const liveHere = live && live.symbol === sym ? live : null;
  return (
    <form
      className="stk-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <label>
        Symbol
        <input
          value={draft.symbol}
          onChange={(e) => setDraft((d) => ({ ...d, symbol: e.target.value.toUpperCase() }))}
          onBlur={() => {
            if (!editing && sym && !(liveHere && (liveHere.loading || liveHere.price))) pull(sym);
          }}
          required
          maxLength={10}
          autoFocus={!draft.symbol}
        />
      </label>
      <label>
        Side
        <select value={draft.side} onChange={set('side')}>
          <option value="long">Long</option>
          <option value="short">Short</option>
        </select>
      </label>
      <label>
        Shares
        <input type="number" min="0" step="any" inputMode="decimal" value={draft.shares} onChange={set('shares')} required autoFocus={Boolean(draft.symbol) && !draft.shares} />
      </label>
      <label>
        <span className="stk-entry-label">
          Entry $
          {!editing && sym ? (
            <span className="stk-live small muted">
              {liveHere?.price ? `live ${px(liveHere.price)} · ${ptClock(liveHere.at)} PT` : liveHere?.loading ? 'fetching…' : liveHere?.error ? 'no quote' : ''}
              <button type="button" className="stk-live__btn" title="Re-pull live price" aria-label="Refresh live price" onClick={() => pull(sym, { force: true })} disabled={liveHere?.loading}>
                ↻
              </button>
            </span>
          ) : null}
        </span>
        <input
          type="number"
          min="0"
          step="any"
          inputMode="decimal"
          value={draft.entry_price}
          onChange={(e) => {
            touch();
            set('entry_price')(e);
          }}
          required
        />
      </label>
      <label>
        Entry date
        <input type="date" value={draft.entry_date} max={todayEt()} onChange={set('entry_date')} required />
      </label>
      <label>
        <span className="stk-entry-label">
          Max loss $<span className="stk-live small muted">Whole position closes if it's down this much</span>
        </span>
        <input type="number" min="0" step="1" inputMode="decimal" value={draft.risk_usd} onChange={set('risk_usd')} required title="Whole position closes if it's down this much" />
      </label>
      <div className="stk-form__actions">
        <button type="submit" className="btn btn--primary" disabled={busy}>
          {busy ? 'Saving…' : editing ? 'Save' : 'Add'}
        </button>
        <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        {editing ? (
          <>
            <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
              Mark closed
            </button>
            <button type="button" className="btn btn--ghost-danger btn--ghost" onClick={onDelete} disabled={busy}>
              Delete
            </button>
          </>
        ) : null}
      </div>
    </form>
  );
}

function PaperCell({ o }) {
  if (!o) return <span className="muted small">—</span>;
  if (o.status === 'working') return <span className="small">Working <span className="mono">{px(o.stop_price)}</span></span>;
  if (o.status === 'filled')
    return (
      <span className="small neg" title={`Paper: stopped out at ${px(o.fill_price)} on ${ptTime(o.filled_at)} PT (stop ${px(o.stop_price)}${o.data?.gap ? ', gapped through' : ''}) · P/L ${signed(o.realized_pnl, (x) => `$${x.toFixed(2)}`)}`}>
        Filled <span className="mono">{px(o.fill_price)}</span> {o.filled_at ? <span className="muted">{new Date(o.filled_at).toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric' })}</span> : null}
      </span>
    );
  if (o.status === 'blocked') return <span className="small dp-warn" title={o.data?.blocked_reason || ''}>Blocked</span>;
  return <span className="small muted">Closed</span>;
}

function Row({ p, s, o, lo, conn, liveActions, onEdit, remind, onRemind }) {
  const [open, setOpen] = useState(false);
  const d = s?.data;
  const isLong = p.side === 'long';
  const price = d?.price;
  const entry = Number(p.entry_price);
  const shares = Number(p.shares);
  const pnl = Number.isFinite(price) ? (isLong ? price - entry : entry - price) * shares : null;
  const pnlPct = Number.isFinite(price) ? ((isLong ? price - entry : entry - price) / entry) * 100 : null;
  const stopNum = s ? Number(s.stop) : null;
  const hitPnl = Number.isFinite(stopNum) && shares > 0 ? (isLong ? stopNum - entry : entry - stopNum) * shares : null;
  const cap = Number(p.risk_usd);
  // Which rule is in charge: from the run snapshot, else inferred (stop sits on the max-loss cap → cap).
  const capStop = cap > 0 && shares > 0 ? (isLong ? entry - cap / shares : entry + cap / shares) : null;
  const rule = d?.rule || (Number.isFinite(stopNum) ? (capStop != null && Math.abs(stopNum - capStop) < 0.005 ? 'risk' : 'atr') : null);
  const ruleText = rule === 'risk' ? `Risk cap $${cap.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : rule === 'atr' ? 'ATR stop' : null;
  return (
    <>
      <tr className={d?.hit ? 'stk-row--hit' : d?.near ? 'stk-row--near' : ''}>
        <td>
          <button type="button" className="stk-sym" onClick={() => setOpen((o) => !o)} aria-expanded={open} title="Decision log">
            {p.symbol}
          </button>{' '}
          <span className={`stk-side stk-side--${p.side}`}>{isLong ? 'L' : 'S'}</span>{' '}
          <button
            type="button"
            className={`stk-remind${remind ? ' is-on' : ''}`}
            onClick={() => onRemind?.(p.symbol, !remind)}
            title={remind ? 'Telegram reminds you if there is no stop order on these shares (click to turn off)' : 'No missing-stop reminders for this symbol (click to remind me)'}
            aria-pressed={remind}
          >
            {remind ? '🔔' : '🔕'}
          </button>
        </td>
        <td className="num mono">{shares.toLocaleString('en-US')}</td>
        <td className="num mono">{px(entry)}</td>
        <td className="num mono">{px(price)}</td>
        <td className={`num mono ${pnl > 0 ? 'is-pos' : pnl < 0 ? 'is-neg' : ''}`}>
          {signed(pnl, (x) => `$${x.toFixed(0)}`)} <span className="small">{pnlPct != null ? `(${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)` : ''}</span>
        </td>
        <td className="stk-stop">
          {s ? (
            d?.hit ? (
              <strong className="neg">Stop hit {px(s.stop)}</strong>
            ) : (
              <>
                {recentMove(d?.move) ? <span className="stk-move">{isLong ? 'Raise' : 'Lower'} to </span> : null}
                <span className="mono">{px(s.stop)}</span>
                {recentMove(d?.move) ? (
                  <span className="small muted"> was {px(d.move.from)}</span>
                ) : (
                  <span className="small muted"> {isLong ? 'stop' : 'buy-stop'}</span>
                )}
                {ruleText ? <span className={`stk-rule small ${rule === 'risk' ? 'stk-rule--cap' : ''}`} title={d?.ruleHeld ? 'Held by the ratchet (stops only tighten)' : 'Tighter of the ATR stop and your max-loss cap'}>{ruleText}</span> : null}
              </>
            )
          ) : (
            <span className="muted small">next run…</span>
          )}
        </td>
        <td className={`num mono ${d?.near || d?.hit ? 'is-neg' : ''}`}>{pct(d?.distPct)}</td>
        <td className="num mono" title={d ? `${pct(d.atrPct)} of price · trail ${d.mult} ATR` : undefined}>
          {px(d?.atr)}
        </td>
        <td>
          <Flags f={d?.flags} />
        </td>
        <td className={`num mono ${hitPnl < 0 ? 'is-neg' : hitPnl > 0 ? 'is-pos' : ''}`} title={s ? `If the whole position fills at the stop ${px(s.stop)} (${shares} × ${px(Math.abs(entry - s.stop))})` : undefined}>
          {hitPnl == null ? '—' : hitPnl < -0.005 ? `−$${Math.abs(hitPnl).toFixed(2)}` : `+$${Math.max(0, hitPnl).toFixed(2)} locked`}
        </td>
        <td>
          <PaperCell o={o} />
        </td>
        <td>
          <LiveCell p={p} lo={lo} conn={conn} {...liveActions} />
        </td>
        <td className="action">
          <button type="button" className="btn btn--ghost stk-edit" onClick={() => onEdit(p)}>
            Edit
          </button>
        </td>
      </tr>
      {open ? (
        <tr className="stk-log-row">
          <td colSpan={13}>
            <p className="small muted stk-log-head">
              Initial {px(s?.initial_stop)} · trail {d?.mult ?? '—'} ATR from {isLong ? 'highest close' : 'lowest low'} {px(d?.extreme)} · last candle {d?.lastBar || '—'} · checked {ptTime(s?.updated_at)} PT
              {' · '}in charge: <strong>{ruleText || '—'}</strong>
              {d?.ruleHeld ? ' (held by ratchet)' : ''} {Number.isFinite(d?.atrStop) ? ` · ATR stop ${px(d.atrStop)}` : ''}
              {capStop != null ? ` · cap stop ${px(capStop)} (max loss $${cap})` : ' · no max-loss cap'}
            </p>
            {o?.status === 'filled' ? (
              <p className="small neg stk-log-head">
                Paper: stopped out at {px(o.fill_price)} on {ptTime(o.filled_at)} PT (stop {px(o.stop_price)}{o.data?.gap ? ', gapped through' : ''}) · P/L{' '}
                {signed(o.realized_pnl, (x) => `$${x.toFixed(2)}`)}. Your real position is unchanged.
              </p>
            ) : null}
            <PositionLog positionId={p.id} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

export default function StocksPanel() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(null); // form open when non-null
  const [editingId, setEditingId] = useState(null);
  const [formKey, setFormKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [notice, setNotice] = useState('');
  const schwab = useSchwabStatus();
  const [liveBusy, setLiveBusy] = useState(false);

  const load = useCallback(() => {
    if (!supabase || !user) return Promise.resolve();
    return loadStocks(user.id)
      .then((d) => {
        setData(d);
        setError('');
      })
      .catch((e) => setError(e.message));
  }, [user]);

  useEffect(() => {
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const refreshServer = async () => {
    try {
      await authedFetch('/api/bot/stocks/refresh', { method: 'POST', body: {} });
    } catch (e) {
      setError(e.message);
    }
    await load();
  };

  const liveCall = async (path, body) => {
    setLiveBusy(true);
    setError('');
    try {
      await authedFetch(path, { method: 'POST', body });
    } catch (e) {
      setError(e.message);
    }
    await Promise.all([load(), schwab.reload()]);
    setLiveBusy(false);
  };
  const liveActions = {
    busy: liveBusy,
    onToggle: (p, live) => {
      if (live && !window.confirm(`Make ${p.symbol} Live? ${schwab.status?.connection?.liveEnabled ? 'The bot places a real Schwab STOP for the shares you hold now.' : 'Orders start once "Live Schwab stops" is ON.'}`)) return;
      liveCall('/api/schwab/position-live', { positionId: p.id, live });
    },
    onAdopt: (p, orderId) => liveCall('/api/schwab/adopt', { positionId: p.id, orderId }),
    onCancel: (p) => liveCall('/api/schwab/cancel', { positionId: p.id }),
  };

  const openNew = (preset = {}) => {
    setFormKey((k) => k + 1);
    setPlanning(false);
    setEditingId(null);
    setNotice('');
    setDraft({ ...EMPTY, entry_date: todayEt(), ...preset });
  };
  const openEdit = (p) => {
    setFormKey((k) => k + 1);
    setPlanning(false);
    setEditingId(p.id);
    setDraft({
      symbol: p.symbol,
      side: p.side,
      shares: String(Number(p.shares)),
      entry_price: String(Number(p.entry_price)),
      entry_date: p.entry_date,
      risk_usd: String(Number(p.risk_usd)),
      notes: p.notes || '',
    });
  };

  const save = async () => {
    const row = {
      symbol: draft.symbol.trim().toUpperCase(),
      side: draft.side,
      shares: Number(draft.shares),
      entry_price: Number(draft.entry_price),
      entry_date: draft.entry_date,
      risk_usd: draft.risk_usd === '' ? 100 : Number(draft.risk_usd),
      notes: draft.notes || null,
    };
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(row.symbol)) return setError('Enter a stock symbol.');
    if (!(row.shares > 0) || !(row.entry_price > 0) || !(row.risk_usd >= 0)) return setError('Shares and entry must be above 0.');
    setBusy(true);
    setError('');
    const r = editingId
      ? await supabase.from('stock_positions').update(row).eq('id', editingId).eq('user_id', user.id)
      : await supabase.from('stock_positions').insert({ ...row, user_id: user.id });
    if (r.error) {
      setBusy(false);
      return setError(r.error.message);
    }
    setDraft(null);
    setEditingId(null);
    setNotice(`${row.symbol} saved. Computing the stop…`);
    await refreshServer();
    setNotice('');
    setBusy(false);
  };

  const closePos = async () => {
    if (!window.confirm(`Mark ${draft.symbol} closed? The bot stops watching it.`)) return;
    setBusy(true);
    const r = await supabase.from('stock_positions').update({ status: 'closed' }).eq('id', editingId).eq('user_id', user.id);
    setBusy(false);
    if (r.error) return setError(r.error.message);
    setDraft(null);
    setEditingId(null);
    load();
  };
  const deletePos = async () => {
    if (!window.confirm(`Delete ${draft.symbol} and its stop history?`)) return;
    setBusy(true);
    const r = await supabase.from('stock_positions').delete().eq('id', editingId).eq('user_id', user.id);
    setBusy(false);
    if (r.error) return setError(r.error.message);
    setDraft(null);
    setEditingId(null);
    load();
  };
  const reopen = async (p) => {
    const r = await supabase.from('stock_positions').update({ status: 'active' }).eq('id', p.id).eq('user_id', user.id);
    if (r.error) return setError(r.error.message);
    refreshServer();
  };

  const active = data?.positions.filter((p) => p.status === 'active') || [];
  const closed = data?.positions.filter((p) => p.status === 'closed') || [];
  const lastChecked = [...(data?.stops.values() || [])].map((s) => s.updated_at).sort().at(-1);

  return (
    <section className="card stk">
      <div className="card__head stk-head">
        <h2>Stocks</h2>
        <span className="small muted">
          {schwab.status?.connection?.liveEnabled && !schwab.status.connection.killSwitch && schwab.status.connection.status === 'connected' ? 'LIVE stops on Live positions' : 'Watch-only'} · every 5 min in market hours + after the close{lastChecked ? ` · checked ${ptTime(lastChecked)} PT` : ''}
        </span>
      </div>

      <SchwabPanel schwab={schwab} onChanged={load} onError={setError} />

      <DipPlansPanel />

      {data && (data.tally.orders || data.guard) ? (
        <PaperBar key={`${data.guard?.max_loss_usd ?? 1}`} tally={data.tally} guard={data.guard} onChanged={refreshServer} onError={setError} />
      ) : null}

      <div className="stk-toolbar">
        <button type="button" className="btn btn--primary stk-btn" onClick={() => openNew()}>
          + Position
        </button>
        <button type="button" className="btn btn--ghost" onClick={() => openNew({ symbol: 'SPY', side: 'long' })}>
          Add SPY
        </button>
        <button type="button" className="btn btn--ghost" onClick={() => openNew({ symbol: 'QQQ', side: 'long' })}>
          Add QQQ
        </button>
        <select
          className="stk-pick"
          value=""
          aria-label="From My Shorts"
          onChange={(e) => e.target.value && openNew({ symbol: e.target.value, side: 'short' })}
        >
          <option value="">From My Shorts…</option>
          {SHORT_KINGS_WATCHLIST.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={`btn btn--ghost${planning ? ' is-active' : ''}`}
          onClick={() => {
            setDraft(null);
            setPlanning((v) => !v);
          }}
        >
          Plan a trade
        </button>
      </div>

      {error ? <p className="auth-card__error small">{error}</p> : null}
      {notice ? <p className="small pos">{notice}</p> : null}

      {draft ? (
        <PositionForm
          key={formKey}
          draft={draft}
          setDraft={setDraft}
          onSave={save}
          onCancel={() => {
            setDraft(null);
            setEditingId(null);
          }}
          onClose={closePos}
          onDelete={deletePos}
          busy={busy}
          editing={Boolean(editingId)}
        />
      ) : null}

      {planning ? <PlanTrade onAdd={(pre) => openNew(pre)} /> : null}

      {!data ? (
        <p className="muted small">Loading…</p>
      ) : active.length ? (
        <div className="stk-scroll">
          <table className="scanner-table stk-table">
            <thead>
              <tr>
                <th>Symbol</th>
                <th className="num">Shares</th>
                <th className="num">Entry</th>
                <th className="num">Price</th>
                <th className="num">P/L</th>
                <th title="Move your Schwab stop here">Schwab stop</th>
                <th className="num" title="Room before the stop, % of price">To stop</th>
                <th className="num">ATR</th>
                <th>Flags</th>
                <th className="num" title="$ result if the whole position fills at the stop">Risk if hit</th>
                <th title="Simulated stop order the bot manages">Paper</th>
                <th title="Real Schwab stop order the bot manages (off by default)">Live</th>
                <th className="action" />
              </tr>
            </thead>
            <tbody>
              {active.map((p) => (
                <Row
                  key={p.id}
                  p={p}
                  s={data.stops.get(p.id)}
                  o={data.orders.get(p.id)}
                  lo={data.live.get(p.id)}
                  conn={schwab.status?.connection}
                  liveActions={liveActions}
                  onEdit={openEdit}
                  remind={remindOn(data.prefs, p.symbol)}
                  onRemind={async (symbol, on) => {
                    const r = await supabase.from('stop_reminder_prefs').upsert({ user_id: user.id, symbol, remind: on, updated_at: new Date().toISOString() });
                    if (r.error) setError(r.error.message);
                    await load();
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted small">No stock positions yet. Add one; the bot works out where your Schwab stop goes.</p>
      )}

      {data?.alerts?.length ? (
        <details className="bot-more">
          <summary>Alerts ({data.alerts.length})</summary>
          <ul className="bot-log">
            {data.alerts.map((a) => (
              <li key={a.id} className="bot-log__item">
                <span className="muted small mono">{ptTime(a.fired_at)}</span>
                <span className="bot-log__decision">{a.title}</span>
                <span className="bot-log__reason muted small">{a.message}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {closed.length ? (
        <details className="bot-more">
          <summary>Closed ({closed.length})</summary>
          <ul className="bot-log">
            {closed.map((p) => (
              <li key={p.id} className="bot-log__item">
                <span className="mono small">{p.symbol}</span>
                <span className="small muted">
                  {p.side} {Number(p.shares)} @ {px(Number(p.entry_price))} · closed {ptTime(p.closed_at)}
                </span>
                <button type="button" className="btn btn--ghost" onClick={() => reopen(p)}>
                  Reopen
                </button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
