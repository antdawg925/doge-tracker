import { useEffect, useState } from 'react';
import { useAuth } from '../hooks/authContext.js';
import { authedFetch } from '../lib/api.js';
import { fetchDipBuys } from '../lib/dipBuysClient.js';
import { formatPct, formatPrice, formatTime } from '../lib/format.js';
import { dollarRisk, sharesForAmount } from '../../shared/dipBuys.js';
import SetupPreview from '../components/setups/SetupPreview.jsx';
import EarningsCell from '../components/setups/EarningsCell.jsx';
import LiveOrderNote, { useLiveGates } from '../components/setups/LiveOrderNote.jsx';
import OrderTicket from '../components/setups/OrderTicket.jsx';
import { addPaperIdea } from '../lib/paperIdeas.js';

const usd = (n) => (n == null || !Number.isFinite(n) ? '—' : `$${Math.round(n).toLocaleString('en-US')}`);
const day = (ms) => (ms ? new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—');

/** Move from entry to a level as a signed % for this side (loss negative, gain positive). */
const movePct = (entry, level, short) => (entry > 0 && level > 0 ? ((short ? entry - level : level - entry) / entry) * 100 : null);
const PctUnder = ({ v }) => (v == null ? null : <span className={`pct-under ${v < 0 ? 'neg' : 'pos'}`}>{`${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(1)}%`}</span>);

function ConfirmSheet({ row, onClose, onConfirm, onPaper, gates, busy, msg }) {
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
          Limit at major support{row.buyZone === 'sma50' ? ' / SMA50 zone' : ''}.
        </p>
        <dl className="dip-sheet__facts small">
          <div>
            <dt>Target price</dt>
            <dd className="mono">{formatPrice(row.buy)}</dd>
          </div>
          <div>
            <dt>Stop</dt>
            <dd className="mono neg">{formatPrice(row.stop)} <PctUnder v={movePct(row.buy, row.stop, false)} /></dd>
          </div>
          <div>
            <dt>Sell target</dt>
            <dd className="mono pos">{formatPrice(row.t1)} <PctUnder v={movePct(row.buy, row.t1, false)} /></dd>
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
        <OrderTicket
          symbol={row.symbol}
          side="long"
          last={row.price}
          stop={row.stop}
          target={row.t1}
          limitPrice={row.buy}
          onPaper={(o) => onPaper(row, o)}
          onReal={onConfirm}
          busy={busy}
          blocked={false}
          note={<LiveOrderNote gates={gates} />}
        />
        <button type="button" className="btn btn--ghost stk-btn otk__cancel" onClick={onClose} disabled={busy}>
          Cancel
        </button>
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
  const [preview, setPreview] = useState(null);
  const [paperMsg, setPaperMsg] = useState('');
  const gates = useLiveGates();
  /** Paper idea at the current price with this setup's stop/target (no real money). */
  const paperQuick = async (r, shares, price = r.buy) => {
    setPaperMsg('Saving paper idea…');
    try {
      const i = await addPaperIdea({ symbol: r.symbol, name: r.name, type: 'stock' }, { side: 'long', qty: shares, entry: price, limit: price, stop: r.stop, target: r.t1, source: 'setup' });
      setPaperMsg(`Paper LIMIT buy ${i.qty} ${i.symbol} @ ${formatPrice(i.limit_price)} (GTC) pending → Positions · Paper · Pending orders. Fills when price trades there; exits at target or stop.`);
    } catch (e) {
      setPaperMsg(`Paper idea failed: ${e.message}`);
    }
  };

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

  const confirm = async ({ shares, price }, target = sheet) => {
    const sheet = target;
    if (!sheet) return;
    setBusy(true);
    setMsg('');
    try {
      await authedFetch('/api/bot/stocks/plans/create', {
        method: 'POST',
        body: {
          symbol: sheet.symbol,
          shares,
          amountUsd: Number((shares * price).toFixed(2)),
          limit: price,
          stop: sheet.stop,
          t1: sheet.t1,
          ladder: sheet.ladder,
          confirm: 'BUY',
          dryRun: false,
          placeNow: true, // his explicit order: GTC LIMIT placed at Schwab right away
        },
      });
      setSheet(null);
      setPreview(null);
      setMsg('');
      alert(`${sheet.symbol}: REAL limit buy ${shares} @ ${formatPrice(price)} placed at Schwab (GTC). See Positions → Real → Pending orders.`);
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
            <p className="small muted bot-scan__rule">Target price = limit buy at major support. Sell target = nearest major resistance at least 1 weekly ATR above it (2+ touches or monthly), capped at 2.5 ATR so it's reachable in the hold. Paper buy and Buy $ both place a GTC limit at the Target price.</p>
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
      {paperMsg ? <p className={`small ${paperMsg.startsWith('Paper idea failed') ? 'neg' : 'rpaper__msg'}`}>{paperMsg}</p> : null}
      <div className="card scanner-table-wrap">
        <table className="scanner-table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th className="num">Current price</th>
              <th className="num">Target price</th>
              <th className="num">% away</th>
              <th className="num">Stop</th>
              <th className="num" title="Nearest major resistance ≥1 weekly ATR above the target price (≥2 touches or monthly), capped at +2.5 ATR">Sell target</th>
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
                <tr key={r.symbol} className={`stp-row${preview?.symbol === r.symbol ? ' is-selected' : ''}`} onClick={() => { setPreview(r); setMsg(''); }} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setPreview(r)} title="Preview chart">
                  <td>
                    <strong>{r.symbol}</strong>
                    <div className="muted small">
                      {r.stage} · {r.stageLabel}
                    </div>
                  </td>
                  <td className="num mono">{formatPrice(r.price)}</td>
                  <td className="num mono">{formatPrice(r.buy)}</td>
                  <td className="num mono neg">{formatPct(r.awayPct, 1)}</td>
                  <td className="num mono">{formatPrice(r.stop)}<PctUnder v={movePct(r.buy, r.stop, false)} /></td>
                  <td className="num mono pos">{formatPrice(r.t1)}<PctUnder v={movePct(r.buy, r.t1, false)} /></td>
                  <td className="num mono">{r.rr?.toFixed?.(2)}</td>
                  <EarningsCell earningsAt={r.earningsAt} warn={r.earningsWarn} side="long" />
                  <td>
                    {canBuy ? (
                      <span className="act-pair">
                        <button type="button" className="btn btn--paper stk-btn act-btn" title="Paper LIMIT buy at the Target price, GTC (no real money)" onClick={(e) => { e.stopPropagation(); paperQuick(r, sharesForAmount(Number(amount), r.buy)); }}>
                          Paper buy
                        </button>
                        <button type="button" className="btn btn--gold stk-btn act-btn dip-buy" onClick={(e) => { e.stopPropagation(); setSheet(r); setMsg(''); }}>
                          Buy $
                        </button>
                      </span>
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
      {preview && !sheet ? (
        <SetupPreview
          row={preview}
          side="long"
          entry={preview.buy}
          stop={preview.stop}
          target={preview.t1}
          blocked={!canBuy}
          facts={[
            { k: 'Target price', v: formatPrice(preview.buy) },
            { k: 'Stop', v: <>{formatPrice(preview.stop)} <PctUnder v={movePct(preview.buy, preview.stop, false)} /></>, cls: 'neg' },
            { k: 'Sell target', v: <>{formatPrice(preview.t1)} <PctUnder v={movePct(preview.buy, preview.t1, false)} /></>, cls: 'pos' },
            { k: 'R:R', v: preview.rr?.toFixed?.(2) ?? '—' },
            { k: 'Stage', v: `${preview.stage} · ${preview.stageLabel}` },
            { k: 'Earnings', v: day(preview.earningsAt), cls: preview.earningsWarn ? 'neg' : '' },
          ]}
          note={preview.earningsWarn ? <p className="warn-banner small">Earnings {day(preview.earningsAt)} — before a typical fill window. Gap risk.</p> : null}
          realNote={<LiveOrderNote gates={gates} />}
          onConfirm={(o) => confirm(o, preview)}
          onClose={() => setPreview(null)}
          busy={busy}
          msg={msg}
        />
      ) : null}
      {sheet ? <ConfirmSheet row={sheet} onClose={() => setSheet(null)} onConfirm={confirm} onPaper={(r, o) => { paperQuick(r, o.shares, o.price); setSheet(null); }} gates={gates} busy={busy} msg={msg} /> : null}
    </div>
  );
}
