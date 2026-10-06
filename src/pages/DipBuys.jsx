import { useEffect, useState } from 'react';
import { useAuth } from '../hooks/authContext.js';
import { authedFetch } from '../lib/api.js';
import { fetchDipBuys } from '../lib/dipBuysClient.js';
import { formatPct, formatPrice, formatTime } from '../lib/format.js';
import { dollarRisk, sharesForAmount } from '../../shared/dipBuys.js';

const usd = (n) => (n == null || !Number.isFinite(n) ? '—' : `$${Math.round(n).toLocaleString('en-US')}`);
const day = (ms) => (ms ? new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—');

function ConfirmSheet({ row, amount, onAmount, onClose, onConfirm, busy, msg }) {
  const shares = sharesForAmount(Number(amount), row.buy);
  const risk = dollarRisk(shares, row.buy, row.stop);
  return (
    <div className="dip-sheet" role="dialog" aria-label={`Buy ${row.symbol}`}>
      <div className="dip-sheet__card card">
        <div className="dip-sheet__head">
          <h2>Buy dip · {row.symbol}</h2>
          <button type="button" className="btn btn--ghost stk-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <p className="small muted">
          Limit at major support{row.buyZone === 'sma50' ? ' / SMA50 zone' : ''}. Default dry-run until Stocks Live is on.
        </p>
        <label className="dip-sheet__amt">
          <span className="small muted">$ to spend</span>
          <input type="number" min="0" step="50" value={amount} onChange={(e) => onAmount(e.target.value)} autoFocus />
        </label>
        <dl className="dip-sheet__facts small">
          <div>
            <dt>Shares</dt>
            <dd className="mono">{shares || '—'}</dd>
          </div>
          <div>
            <dt>Limit</dt>
            <dd className="mono">{formatPrice(row.buy)}</dd>
          </div>
          <div>
            <dt>Stop</dt>
            <dd className="mono neg">{formatPrice(row.stop)}</dd>
          </div>
          <div>
            <dt>T1</dt>
            <dd className="mono pos">{formatPrice(row.t1)}</dd>
          </div>
          <div>
            <dt>$ risk</dt>
            <dd className="mono neg">{risk != null ? usd(risk) : '—'}</dd>
          </div>
          <div>
            <dt>R:R</dt>
            <dd className="mono">{row.rr?.toFixed?.(2) ?? row.rr}</dd>
          </div>
        </dl>
        {row.earningsWarn ? (
          <p className="warn-banner small">Earnings {day(row.earningsAt)} — before a typical fill window. Gap risk.</p>
        ) : null}
        {msg ? <p className="small neg">{msg}</p> : null}
        <div className="dip-sheet__actions">
          <button type="button" className="btn btn--ghost stk-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary stk-btn" disabled={busy || !shares} onClick={() => onConfirm(shares)}>
            {busy ? 'Saving…' : `Confirm buy ${shares || ''} sh`}
          </button>
        </div>
      </div>
    </div>
  );
}

/** My Bot → Buy dips: liquid Momentum/Investable names in an uptrend/base with a major support to buy. */
export default function DipBuys() {
  const { hasBotAccess, isOwner } = useAuth();
  const canBuy = hasBotAccess || isOwner;
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [progress, setProgress] = useState('');
  const [updatedAt, setUpdatedAt] = useState(0);
  const [tick, setTick] = useState(0);
  const [sheet, setSheet] = useState(null);
  const [amount, setAmount] = useState('1000');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    const ac = new AbortController();
    setErr('');
    setProgress('Scanning…');
    fetchDipBuys({ signal: ac.signal, onProgress: (d, t) => setProgress(`Levels ${d}/${t}…`) })
      .then((r) => {
        setRows(r.rows);
        setUpdatedAt(r.updatedAt);
        setProgress('');
      })
      .catch((e) => {
        if (e?.name !== 'AbortError') {
          setErr(e.message || 'Scan failed');
          setProgress('');
        }
      });
    return () => ac.abort();
  }, [tick]);

  const confirm = async (shares) => {
    if (!sheet) return;
    setBusy(true);
    setMsg('');
    try {
      await authedFetch('/api/bot/stocks/plans/create', {
        method: 'POST',
        body: {
          symbol: sheet.symbol,
          shares,
          amountUsd: Number(amount),
          limit: sheet.buy,
          stop: sheet.stop,
          t1: sheet.t1,
          ladder: sheet.ladder,
          confirm: 'BUY',
          dryRun: true,
        },
      });
      setSheet(null);
      setMsg('');
      alert(`${sheet.symbol}: plan saved (dry-run). See My Bot → Stocks.`);
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  };

  const list = rows || [];

  return (
    <div className="scanner scanner--embedded bot-scan dip">
      <div className="scanner__header card">
        <div className="scanner__title-row">
          <div>
            <p className="small muted bot-scan__lead">Buy dips · Momentum + Investable names, stage 1–2.</p>
          </div>
          <div className="scanner__controls">
            <button type="button" className="btn" disabled={Boolean(progress)} onClick={() => setTick((n) => n + 1)}>
              {progress || 'Refresh'}
            </button>
            <p className="scanner__updated muted">Updated {formatTime(updatedAt || null)}</p>
          </div>
        </div>
      </div>
      {err ? <p className="auth-card__error">{err}</p> : null}
      <div className="card scanner-table-wrap">
        <table className="scanner-table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th className="num">Price</th>
              <th className="num">Buy</th>
              <th className="num">% away</th>
              <th className="num">Stop</th>
              <th className="num">T1</th>
              <th className="num">R:R</th>
              <th>Earnings</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows === null ? (
              <tr>
                <td colSpan={9} className="muted">
                  {progress || 'Loading…'}
                </td>
              </tr>
            ) : !list.length ? (
              <tr>
                <td colSpan={9} className="muted">
                  No dip setups right now (need stage 1–2 with a major support below).
                </td>
              </tr>
            ) : (
              list.map((r) => (
                <tr key={r.symbol}>
                  <td>
                    <strong>{r.symbol}</strong>
                    <div className="muted small">
                      {r.stage} · {r.stageLabel}
                    </div>
                  </td>
                  <td className="num mono">{formatPrice(r.price)}</td>
                  <td className="num mono">{formatPrice(r.buy)}</td>
                  <td className="num mono neg">{formatPct(r.awayPct, 1)}</td>
                  <td className="num mono">{formatPrice(r.stop)}</td>
                  <td className="num mono pos">{formatPrice(r.t1)}</td>
                  <td className="num mono">{r.rr?.toFixed?.(2)}</td>
                  <td className={`small ${r.earningsWarn ? 'neg' : 'muted'}`}>{r.earningsAt ? day(r.earningsAt) : '—'}</td>
                  <td>
                    {canBuy ? (
                      <button type="button" className="btn btn--primary stk-btn dip-buy" onClick={() => { setSheet(r); setMsg(''); }}>
                        Buy
                      </button>
                    ) : (
                      <span className="muted small">Bot access</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {sheet ? <ConfirmSheet row={sheet} amount={amount} onAmount={setAmount} onClose={() => setSheet(null)} onConfirm={confirm} busy={busy} msg={msg} /> : null}
    </div>
  );
}
