import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../hooks/authContext.js';
import { authedFetch } from '../../lib/api.js';
import { formatCoins, formatPct, formatPrice, formatUsd } from '../../lib/format.js';
import { paperBookValue, paperValues } from '../../../shared/paper.js';
import { supabase } from '../../lib/supabase.js';

const SYMBOL = 'DOGE';
const LATE_MS = 15 * 60 * 1000;

// Times are Pacific (the header stat carries the PDT/PST label; list rows stay short).
const ptTime = (iso, { day = true, zone = true } = {}) =>
  iso
    ? new Date(iso).toLocaleString('en-US', {
        timeZone: 'America/Los_Angeles',
        ...(day ? { month: 'short', day: 'numeric' } : {}),
        hour: 'numeric',
        minute: '2-digit',
        ...(zone ? { timeZoneName: 'short' } : {}),
      })
    : '—';
const rowTime = (iso) => ptTime(iso, { zone: false });

const DECISION_COPY = {
  hold: 'Hold',
  would_sell_slice: 'Would sell slice',
  would_buy_back: 'Would buy back',
  would_exit_core: 'Would exit core',
  stop_raised: 'Stop raised',
  locked: 'Locked',
  blocked_locked: 'Blocked (locked)',
  blocked_paused: 'Blocked (paused)',
  blocked_below_baseline: 'Blocked (below start)',
  error: 'Error',
};
const DECISION_TONE = {
  would_sell_slice: 'pos',
  would_buy_back: 'dp-buy',
  would_exit_core: 'neg',
  stop_raised: 'pos',
  locked: 'neg',
  blocked_locked: 'dp-warn',
  blocked_paused: 'dp-warn',
  blocked_below_baseline: 'dp-warn',
  error: 'dp-warn',
};

const usd2 = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signedUsd = (n) => `${n < 0 ? '−' : '+'}${usd2(Math.abs(n))}`;

/** TSB Profit lock line (armed / locked banner), max-loss input, Pause switch. */
function ProfitLock({ guard, book, onAction, busy, notice }) {
  const [maxLoss, setMaxLoss] = useState(guard?.max_loss_usd != null ? String(Number(guard.max_loss_usd)) : '1');
  const baseline = guard?.baseline_value != null ? Number(guard.baseline_value) : null;
  const diff = baseline != null && book != null ? book - baseline : null;
  const savedLoss = guard?.max_loss_usd != null ? Number(guard.max_loss_usd) : 1;
  const lossValid = maxLoss.trim() !== '' && Number(maxLoss) >= 0 && Number.isFinite(Number(maxLoss));

  const saveLoss = () => {
    if (!lossValid || Number(maxLoss) === savedLoss) return;
    onAction('max-loss', { maxLossUsd: Number(maxLoss) });
  };

  if (guard?.locked) {
    return (
      <div className="tsb-locked" role="alert">
        <div>
          <strong>Locked</strong> <span className="small">{guard.lock_reason}</span>
          <p className="small muted tsb-locked__help">
            TSB keeps watching but won’t trade. Authorizing resets your starting amount to the current book
            {book != null ? ` (${usd2(book)})` : ''}; it locks again if the book falls more than {usd2(savedLoss)} below that.
          </p>
        </div>
        <button
          type="button"
          className="btn btn--primary tsb-locked__btn"
          disabled={busy}
          onClick={() => {
            if (
              window.confirm(
                `Authorize TSB to trade again?\n\nYour starting amount resets to the current book value${book != null ? ` (about ${usd2(book)})` : ''}. If the book later falls more than ${usd2(savedLoss)} below it, TSB locks again.`,
              )
            ) {
              onAction('unlock', {});
            }
          }}
        >
          Authorize next trade
        </button>
      </div>
    );
  }

  return (
    <div className="tsb-lock">
      <span className="small">
        <span className="muted">Profit lock:</span>{' '}
        {guard?.paused ? <span className="dp-warn">paused (watching only)</span> : <span className="pos">armed</span>}
        {baseline != null ? (
          <>
            <span className="muted"> · starting </span>
            <span className="mono">{usd2(baseline)}</span>
            {book != null ? (
              <>
                <span className="muted"> · book </span>
                <span className="mono">{usd2(book)}</span>{' '}
                <span className={diff >= 0 ? 'pos' : 'neg'}>({signedUsd(diff)})</span>
              </>
            ) : null}
          </>
        ) : (
          <span className="muted"> · starts on the next server run</span>
        )}
      </span>
      <label className="tsb-lock__loss small muted" title="Lock when the book falls this far below the starting amount">
        Max loss $
        <input
          type="number"
          min="0"
          step="1"
          inputMode="decimal"
          value={maxLoss}
          aria-invalid={!lossValid}
          onChange={(e) => setMaxLoss(e.target.value)}
          onBlur={saveLoss}
          onKeyDown={(e) => e.key === 'Enter' && saveLoss()}
        />
      </label>
      <button
        type="button"
        className="btn btn--ghost tsb-lock__pause"
        disabled={busy}
        onClick={() => onAction('pause', { paused: !guard?.paused })}
      >
        {guard?.paused ? 'Resume bot' : 'Pause bot'}
      </button>
      {notice ? <p className="small pos tsb-lock__notice">{notice}</p> : null}
    </div>
  );
}

const RUN_COLS =
  'id, ran_at, source, price, atr, atr_pct, stage, effective_stop, trail_level, decision, reason, kraken_balance, open_orders, error';

function RunRow({ r }) {
  return (
    <li className="bot-log__item">
      <span className="muted small mono">{rowTime(r.ran_at)}</span>
      <span className={`bot-log__decision ${DECISION_TONE[r.decision] || ''}`}>
        {DECISION_COPY[r.decision] || r.decision}
      </span>
      <span className="mono small">{formatPrice(r.price)}</span>
      <span className="bot-log__reason muted small">{r.error && r.decision === 'error' ? r.error : r.reason}</span>
    </li>
  );
}

async function fetchBotData(userId) {
  const mine = (q) => q.eq('user_id', userId).eq('symbol', SYMBOL);
  const [runs, decisions, paper, trades, guard] = await Promise.all([
    mine(supabase.from('bot_runs').select(RUN_COLS)).order('ran_at', { ascending: false }).limit(10),
    mine(supabase.from('bot_runs').select(RUN_COLS))
      .not('decision', 'in', '(hold,error)')
      .order('ran_at', { ascending: false })
      .limit(20),
    mine(supabase.from('paper_state').select('*')).maybeSingle(),
    mine(supabase.from('paper_trades').select('id, at, side, units, price, reason'))
      .order('at', { ascending: false })
      .limit(50),
    mine(supabase.from('bot_guard').select('*')).maybeSingle(),
  ]);
  const err = [runs, decisions, paper, trades, guard].find((r) => r.error)?.error;
  if (err) throw new Error(err.message);
  return {
    runs: runs.data,
    decisions: decisions.data,
    paper: paper.data,
    trades: trades.data,
    guard: guard.data,
    checkedAt: Date.now(),
  };
}

/** Compact server-bot card: status, decision log, recent runs, paper results. */
export default function BotStatus({ refreshKey }) {
  const { user, isOwner } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [restarting, setRestarting] = useState(false);
  const [guardBusy, setGuardBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const load = useCallback(() => {
    if (!supabase || !user) return Promise.resolve();
    return fetchBotData(user.id)
      .then((d) => {
        setError('');
        setData(d);
      })
      .catch((e) => setError(e.message));
  }, [user]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const restartPaper = async () => {
    if (!window.confirm('Restart the paper test from the current price? Paper trades so far are cleared.')) return;
    setRestarting(true);
    try {
      await authedFetch('/api/bot/paper/restart', { method: 'POST', body: {} });
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setRestarting(false);
    }
  };

  const guardAction = async (action, body) => {
    setGuardBusy(true);
    setError('');
    setNotice('');
    try {
      const r = await authedFetch(`/api/bot/guard/${action}`, { method: 'POST', body });
      if (action === 'unlock') {
        setNotice(
          `Unlocked. New starting amount ${usd2(r.baselineValue)}; TSB locks again if the book falls more than ${usd2(r.maxLossUsd)} below it.`,
        );
      } else if (action === 'max-loss') {
        setNotice(`Max loss saved: ${usd2(r.maxLossUsd)}.`);
      }
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setGuardBusy(false);
    }
  };

  const last = data?.runs?.[0] || null;
  const lastOk = data?.runs?.find((r) => r.decision !== 'error') || null;
  const late = last && data.checkedAt - Date.parse(last.ran_at) > LATE_MS;
  const paper = data?.paper;
  const pv = paper && lastOk ? paperValues(paper, lastOk.price) : null;

  return (
    <section className="card bot-status">
      <div className="card__head">
        <h2>Bot status</h2>
        {data ? (
          last ? (
            <span className={`badge ${late ? 'badge--warn' : 'badge--ok'}`}>
              {late ? 'Last server run is late' : 'Running on server every 5 min'}
            </span>
          ) : (
            <span className="badge">Waiting for first server run</span>
          )
        ) : null}
      </div>
      {error ? <p className="auth-card__error small">{error}</p> : null}

      <dl className="bot-status__stats">
        <div>
          <dt>Last run</dt>
          <dd>{ptTime(last?.ran_at, { day: false })}</dd>
        </div>
        <div>
          <dt>Stage</dt>
          <dd>{lastOk?.stage ?? '—'}</dd>
        </div>
        <div>
          <dt>Effective stop</dt>
          <dd className="mono">{formatPrice(lastOk?.effective_stop)}</dd>
        </div>
        {isOwner ? (
          <>
            <div>
              <dt>Kraken DOGE</dt>
              <dd className="mono">{lastOk?.kraken_balance != null ? formatCoins(Number(lastOk.kraken_balance)) : '—'}</dd>
            </div>
            <div>
              <dt>Open orders</dt>
              <dd className="mono">{lastOk?.open_orders ?? '—'}</dd>
            </div>
          </>
        ) : null}
      </dl>
      {isOwner && lastOk?.error ? <p className="dp-warn small bot-status__note">{lastOk.error}</p> : null}

      {data ? (
        <ProfitLock
          key={`${data.guard?.max_loss_usd ?? 1}-${data.guard?.locked}`}
          guard={data.guard}
          book={paper && lastOk ? paperBookValue(paper, lastOk.price) : null}
          onAction={guardAction}
          busy={guardBusy}
          notice={notice}
        />
      ) : null}

      <div className="bot-paper">
        <span className="muted small">Paper</span>
        {pv ? (
          <span className="small">
            <span className="mono">{formatUsd(pv.paperValue, { decimals: 0 })}</span>
            <span className="muted"> vs hold </span>
            <span className="mono">{formatUsd(pv.holdValue, { decimals: 0 })}</span>{' '}
            <span className={pv.diffPct > 0 ? 'pos' : pv.diffPct < 0 ? 'neg' : 'muted'}>
              ({formatPct(pv.diffPct)})
            </span>
            <span className="muted"> · since {ptTime(paper.started_at)}</span>
            {paper.data?.core_stopped ? <span className="neg"> · core stopped out</span> : null}
          </span>
        ) : (
          <span className="muted small">Starts on the next server run.</span>
        )}
        <button type="button" className="btn btn--ghost bot-paper__restart" onClick={restartPaper} disabled={restarting}>
          {restarting ? 'Restarting…' : 'Restart paper test'}
        </button>
      </div>

      <details className="bot-more">
        <summary>Decision log ({data?.decisions?.length ?? 0})</summary>
        {data?.decisions?.length ? (
          <ul className="bot-log">
            {data.decisions.map((r) => (
              <RunRow key={r.id} r={r} />
            ))}
          </ul>
        ) : (
          <p className="muted small">No decisions yet. Holds aren’t listed here.</p>
        )}
      </details>
      <details className="bot-more">
        <summary>Last {data?.runs?.length ?? 0} runs</summary>
        <ul className="bot-log">
          {(data?.runs || []).map((r) => (
            <RunRow key={r.id} r={r} />
          ))}
        </ul>
      </details>
      <details className="bot-more">
        <summary>Paper trades ({data?.trades?.length ?? 0})</summary>
        {paper ? (
          <p className="muted small">
            {formatCoins(paper.data?.notional_units)} DOGE notional ({paper.data?.units_source}) from{' '}
            {formatPrice(paper.start_price)}. Slice fills assume the level price; a stop fills at the price the 5-min check saw.
          </p>
        ) : null}
        {data?.trades?.length ? (
          <ul className="bot-log">
            {data.trades.map((t) => (
              <li key={t.id} className="bot-log__item">
                <span className="muted small mono">{rowTime(t.at)}</span>
                <span className={`bot-log__decision ${t.side === 'buy' ? 'dp-buy' : 'pos'}`}>
                  {t.side === 'buy' ? 'Buy' : 'Sell'} {formatCoins(t.units)}
                </span>
                <span className="mono small">{formatPrice(t.price)}</span>
                <span className="bot-log__reason muted small">{t.reason}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">No paper trades yet.</p>
        )}
      </details>
    </section>
  );
}
