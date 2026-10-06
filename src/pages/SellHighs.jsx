import { useEffect, useState } from 'react';
import { useAuth } from '../hooks/authContext.js';
import { authedFetch } from '../lib/api.js';
import { fetchSellHighs } from '../lib/sellHighsClient.js';
import { formatPct, formatPrice, formatTime } from '../lib/format.js';
import { SHORT_RISK_USD, sharesForRisk, shortDollarRisk } from '../../shared/sellHighs.js';
import SetupPreview from '../components/setups/SetupPreview.jsx';

const usd = (n) => (n == null || !Number.isFinite(n) ? '—' : `$${Math.round(n).toLocaleString('en-US')}`);
const day = (ms) => (ms ? new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—');
const pct1 = (n) => (n == null || !Number.isFinite(n) ? '—' : `${n.toFixed(1)}%`);

/** Schwab borrow cell: ETB / HTB (rate) / No short, or — when Schwab isn't connected. */
export function BorrowTag({ b }) {
  if (!b || !b.status) return <span className="muted">—</span>;
  if (b.status === 'NOT_SHORTABLE') return <span className="sh-borrow sh-borrow--no">No short</span>;
  if (b.status === 'HTB')
    return (
      <span className="sh-borrow sh-borrow--htb" title={b.htbQuantity != null ? `${b.htbQuantity.toLocaleString('en-US')} sh available` : undefined}>
        HTB{b.htbRate != null ? ` ${b.htbRate}%` : ''}
      </span>
    );
  return <span className="sh-borrow sh-borrow--etb">ETB</span>;
}

function SqueezeTag({ sq }) {
  if (!sq?.flag) return null;
  return (
    <span className={`sh-squeeze${sq.level === 'extreme' ? ' sh-squeeze--x' : ''}`} title={`Short ${pct1(sq.siPct)} of float, ${sq.dtc?.toFixed?.(1) ?? '—'} days to cover`}>
      Squeeze risk
    </span>
  );
}

function ConfirmSheet({ row, risk, onRisk, onClose, onConfirm, busy, msg, borrowAvailable }) {
  const shares = sharesForRisk(Number(risk), row.entry, row.stop);
  const loss = shortDollarRisk(shares, row.entry, row.stop);
  const blocked = row.borrow?.isShortable === false;
  return (
    <div className="dip-sheet sh-sheet" role="dialog" aria-label={`Sell high ${row.symbol}`}>
      <div className="dip-sheet__card card">
        <div className="dip-sheet__head">
          <h2>
            Sell high · short {row.symbol}
          </h2>
          <button type="button" className="btn btn--ghost stk-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <p className="small muted">
          SELL_SHORT limit just under resistance {formatPrice(row.resistance)}, regular hours. On fill a BUY_TO_COVER stop goes above; it only moves down. Default dry-run until Stocks Live is on.
        </p>
        <label className="dip-sheet__amt">
          <span className="small muted">$ risk (sets shares)</span>
          <input type="number" min="0" step="25" value={risk} onChange={(e) => onRisk(e.target.value)} autoFocus />
        </label>
        <dl className="dip-sheet__facts small">
          <div>
            <dt>Shares</dt>
            <dd className="mono">{shares || '—'}</dd>
          </div>
          <div>
            <dt>Short limit</dt>
            <dd className="mono">{formatPrice(row.entry)}</dd>
          </div>
          <div>
            <dt>Cover stop</dt>
            <dd className="mono neg">{formatPrice(row.stop)}</dd>
          </div>
          <div>
            <dt>Cover target</dt>
            <dd className="mono pos">{formatPrice(row.cover)}</dd>
          </div>
          <div>
            <dt>$ risk</dt>
            <dd className="mono neg">{loss != null ? usd(loss) : '—'}</dd>
          </div>
          <div>
            <dt>R:R</dt>
            <dd className="mono">{row.rr?.toFixed?.(2) ?? row.rr}</dd>
          </div>
          <div>
            <dt>Notional</dt>
            <dd className="mono">{shares ? usd(shares * row.entry) : '—'}</dd>
          </div>
          <div>
            <dt>Short % float</dt>
            <dd className="mono">{pct1(row.siPct)}</dd>
          </div>
          <div>
            <dt>Borrow</dt>
            <dd className="mono">{borrowAvailable ? <BorrowTag b={row.borrow} /> : <span className="muted">Schwab off</span>}</dd>
          </div>
        </dl>
        {row.squeeze?.flag ? (
          <p className="warn-banner small">
            Squeeze risk: {pct1(row.siPct)} of float short, {row.dtc?.toFixed?.(1)} days to cover. Shorts can gap through the stop.
          </p>
        ) : null}
        {row.earningsWarn ? <p className="warn-banner small">Earnings {day(row.earningsAt)} — inside the fill window. Gap risk.</p> : null}
        {blocked ? <p className="small neg">Schwab says {row.symbol} is not shortable right now.</p> : null}
        {msg ? <p className="small neg">{msg}</p> : null}
        <div className="dip-sheet__actions">
          <button type="button" className="btn btn--ghost stk-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn--danger stk-btn sh-confirm" disabled={busy || !shares || blocked} onClick={() => onConfirm(shares)}>
            {busy ? 'Saving…' : `Confirm short ${shares || ''} sh`}
          </button>
        </div>
      </div>
    </div>
  );
}

/** My Bot → Sell highs: weak names bouncing into a major resistance → short there. */
export default function SellHighs() {
  const { hasBotAccess, isOwner } = useAuth();
  const canTrade = hasBotAccess || isOwner;
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [progress, setProgress] = useState('');
  const [tick, setTick] = useState(0);
  const [sheet, setSheet] = useState(null);
  const [risk, setRisk] = useState(String(SHORT_RISK_USD));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [preview, setPreview] = useState(null);

  useEffect(() => {
    const ac = new AbortController();
    setErr('');
    setProgress('Scanning…');
    fetchSellHighs({ signal: ac.signal, onProgress: (d, t) => setProgress(`Levels ${d}/${t}…`) })
      .then((r) => {
        setData(r);
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

  const confirm = async (shares, target = sheet) => {
    const sheet = target;
    if (!sheet) return;
    setBusy(true);
    setMsg('');
    try {
      await authedFetch('/api/bot/stocks/plans/create', {
        method: 'POST',
        body: {
          side: 'short',
          symbol: sheet.symbol,
          shares,
          riskUsd: Number(risk),
          limit: sheet.entry,
          stop: sheet.stop,
          t1: sheet.cover,
          ladder: sheet.ladder,
          borrow: sheet.borrow,
          squeeze: sheet.squeeze?.flag ? sheet.squeeze : null,
          confirm: 'SHORT',
          dryRun: true,
        },
      });
      setSheet(null);
      setPreview(null);
      alert(`${sheet.symbol}: Sell highs short saved (dry-run). See My Bot → Stocks.`);
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  };

  const rows = data?.rows;
  const list = rows || [];
  const cols = 12;

  return (
    <div className="scanner scanner--embedded bot-scan dip sh">
      <div className="scanner__header card">
        <div className="scanner__title-row">
          <div>
            <p className="small muted bot-scan__lead">Sell highs · weak names bouncing into resistance.</p>
            {data && !data.borrowAvailable ? <p className="small muted sh-note">Borrow column: connect Schwab on My Bot → Stocks to see ETB / HTB from Schwab quotes.</p> : null}
          </div>
          <div className="scanner__controls">
            <button type="button" className="btn" disabled={Boolean(progress)} onClick={() => setTick((n) => n + 1)}>
              {progress || 'Refresh'}
            </button>
            <p className="scanner__updated muted">Updated {formatTime(data?.updatedAt || null)}</p>
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
              <th className="num">Short at</th>
              <th className="num">% away</th>
              <th className="num">Stop</th>
              <th className="num">Cover</th>
              <th className="num">R:R</th>
              <th className="num">Short %</th>
              <th className="num">DTC</th>
              <th>Borrow</th>
              <th>Earnings</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows == null ? (
              <tr>
                <td colSpan={cols} className="muted">
                  {progress || 'Loading…'}
                </td>
              </tr>
            ) : !list.length ? (
              <tr>
                <td colSpan={cols} className="muted">
                  No sell-high setups right now (need a weak, bouncing name with a major resistance above).
                </td>
              </tr>
            ) : (
              list.map((r) => (
                <tr key={r.symbol} className={`stp-row${preview?.symbol === r.symbol ? ' is-selected' : ''}`} onClick={() => { setPreview(r); setMsg(''); }} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setPreview(r)} title="Preview chart">
                  <td>
                    <strong>{r.symbol}</strong>
                    <div className="muted small">
                      Stage {r.stage} {r.stage === 4 ? '· Decline' : '· Top'}
                    </div>
                    <SqueezeTag sq={r.squeeze} />
                  </td>
                  <td className="num mono">{formatPrice(r.price)}</td>
                  <td className="num mono">{formatPrice(r.entry)}</td>
                  <td className="num mono pos">{formatPct(r.awayPct, 1)}</td>
                  <td className="num mono neg">{formatPrice(r.stop)}</td>
                  <td className="num mono pos">{formatPrice(r.cover)}</td>
                  <td className="num mono">{r.rr?.toFixed?.(2)}</td>
                  <td className={`num mono${r.squeeze?.flag ? ' neg' : ''}`}>{pct1(r.siPct)}</td>
                  <td className={`num mono${r.squeeze?.flag ? ' neg' : ''}`}>{r.dtc != null ? r.dtc.toFixed(1) : '—'}</td>
                  <td>
                    <BorrowTag b={r.borrow} />
                  </td>
                  <td className={`small ${r.earningsWarn ? 'neg' : 'muted'}`}>{r.earningsAt ? day(r.earningsAt) : '—'}</td>
                  <td>
                    {canTrade ? (
                      <button type="button" className="btn btn--danger stk-btn dip-buy sh-short" onClick={(e) => { e.stopPropagation(); setSheet(r); setMsg(''); }}>
                        Short
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
      {preview && !sheet ? (
        <SetupPreview
          row={preview}
          side="short"
          entry={preview.entry}
          stop={preview.stop}
          target={preview.cover}
          amount={risk}
          onAmount={setRisk}
          amountLabel="$ risk (sets shares)"
          amountStep={25}
          shares={sharesForRisk(Number(risk), preview.entry, preview.stop)}
          confirmLabel={canTrade ? `Short ${sharesForRisk(Number(risk), preview.entry, preview.stop) || ''} sh @ ${formatPrice(preview.entry)}` : 'Bot access needed'}
          blocked={!canTrade || preview.borrow?.isShortable === false}
          facts={[
            { k: 'Shares', v: sharesForRisk(Number(risk), preview.entry, preview.stop) || '—' },
            { k: 'Short limit', v: formatPrice(preview.entry) },
            { k: 'Cover stop', v: formatPrice(preview.stop), cls: 'neg' },
            { k: 'Cover target', v: formatPrice(preview.cover), cls: 'pos' },
            { k: '$ risk', v: usd(shortDollarRisk(sharesForRisk(Number(risk), preview.entry, preview.stop), preview.entry, preview.stop)), cls: 'neg' },
            { k: 'R:R', v: preview.rr?.toFixed?.(2) ?? '—' },
            { k: 'Short % float', v: pct1(preview.siPct), cls: preview.squeeze?.flag ? 'neg' : '' },
            { k: 'Days to cover', v: preview.dtc != null ? preview.dtc.toFixed(1) : '—', cls: preview.squeeze?.flag ? 'neg' : '' },
            { k: 'Borrow', v: data?.borrowAvailable ? <BorrowTag b={preview.borrow} /> : 'Schwab off' },
          ]}
          note={
            <>
              {preview.squeeze?.flag ? <p className="warn-banner small">Squeeze risk: {pct1(preview.siPct)} of float short, {preview.dtc?.toFixed?.(1)} days to cover.</p> : null}
              {preview.earningsWarn ? <p className="warn-banner small">Earnings {day(preview.earningsAt)} — inside the fill window. Gap risk.</p> : null}
              {preview.borrow?.isShortable === false ? <p className="small neg">Schwab says {preview.symbol} is not shortable right now.</p> : null}
            </>
          }
          onConfirm={(sh) => confirm(sh, preview)}
          onClose={() => setPreview(null)}
          busy={busy}
          msg={msg}
        />
      ) : null}
      {sheet ? (
        <ConfirmSheet row={sheet} risk={risk} onRisk={setRisk} onClose={() => setSheet(null)} onConfirm={confirm} busy={busy} msg={msg} borrowAvailable={Boolean(data?.borrowAvailable)} />
      ) : null}
    </div>
  );
}
