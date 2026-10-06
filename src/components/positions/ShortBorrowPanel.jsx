import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase.js';
import { fetchYahooChart } from '../../lib/yahoo.js';
import { fetchSchwabBorrow } from '../../lib/schwabBorrow.js';
import { formatPrice } from '../../lib/format.js';
import { borrowEstimate } from '../../../shared/borrowCost.js';

const money = (n, { sign = false } = {}) => {
  if (n == null || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const s = abs >= 100 ? abs.toLocaleString('en-US', { maximumFractionDigits: 0 }) : abs.toFixed(2);
  return `${n < 0 ? '−' : sign && n > 0 ? '+' : ''}$${s}`;
};
const tone = (n) => (n == null || n === 0 ? '' : n > 0 ? 'pos' : 'neg');
const rangeFor = (days) => (days == null || days <= 80 ? '3mo' : days <= 170 ? '6mo' : days <= 350 ? '1y' : '2y');

/** Open shorts: My Bot stock positions (side short) + filled Sell highs plans. Own rows only. */
async function loadShorts(userId) {
  const [pos, plans] = await Promise.all([
    supabase.from('stock_positions').select('id, symbol, shares, entry_price, entry_date, created_at').eq('user_id', userId).eq('side', 'short').eq('status', 'active'),
    supabase.from('stock_plans').select('id, symbol, filled_shares, shares, filled_price, limit_price, filled_at').eq('user_id', userId).eq('side', 'short').eq('status', 'filled'),
  ]);
  const out = [];
  for (const p of pos.data || []) out.push({ key: `p-${p.id}`, symbol: p.symbol, shares: Number(p.shares), entry: Number(p.entry_price), openedAt: p.entry_date || p.created_at, source: 'My Bot' });
  for (const p of plans.data || []) out.push({ key: `s-${p.id}`, symbol: p.symbol, shares: Number(p.filled_shares || p.shares), entry: Number(p.filled_price || p.limit_price), openedAt: p.filled_at, source: 'Sell highs' });
  return out;
}

/**
 * Positions → Shorts: estimated borrow cost from Schwab's htbRate (|rate| / 100 × value / 360 per day),
 * days held, borrow paid so far, short P/L and net after borrow. Estimate, not the statement.
 */
export default function ShortBorrowPanel({ userId }) {
  const [rows, setRows] = useState(null);
  const [borrowOn, setBorrowOn] = useState(false);

  useEffect(() => {
    let dead = false;
    (async () => {
      const shorts = await loadShorts(userId).catch(() => []);
      if (!shorts.length) return !dead && setRows([]);
      const syms = [...new Set(shorts.map((s) => s.symbol))];
      const [borrow, charts] = await Promise.all([
        fetchSchwabBorrow(syms),
        Promise.all(
          syms.map((s) => {
            const maxDays = Math.max(...shorts.filter((x) => x.symbol === s).map((x) => Math.floor((Date.now() - Date.parse(x.openedAt)) / 86400000) || 0));
            return fetchYahooChart(s, rangeFor(maxDays), { interval: '1d' }).catch(() => null);
          }),
        ),
      ]);
      const chartBy = Object.fromEntries(syms.map((s, i) => [s, charts[i]]));
      const out = shorts.map((s) => {
        const ch = chartBy[s.symbol];
        const price = ch?.spot ?? ch?.bars?.at?.(-1)?.close ?? null;
        const b = borrow.available ? borrow.rows?.[s.symbol] ?? null : null;
        const est = borrowEstimate({ borrow: b, shares: s.shares, price, entryPrice: s.entry, openedAt: s.openedAt, closes: ch?.bars?.map((x) => ({ t: x.t, close: x.close })) });
        return { ...s, price, borrow: b, est };
      });
      if (!dead) {
        setBorrowOn(Boolean(borrow.available));
        setRows(out);
      }
    })();
    return () => {
      dead = true;
    };
  }, [userId]);

  if (!rows?.length) return null;
  const rateTip = (r) =>
    r.est.known
      ? `Schwab htbRate ${r.est.rawRate} (annualized). Schwab reports HTB rates as negative numbers; the estimate uses the absolute value ${r.est.rate}%/yr. ${r.est.method === 'daily closes' ? 'Paid uses each day’s close.' : 'Paid uses current value × days.'}`
      : 'No Schwab borrow rate (Schwab not connected).';

  return (
    <section className="card pos-shorts">
      <div className="pos-shorts__head">
        <h2>Shorts · borrow cost</h2>
        <span className="small muted">Estimate from Schwab’s current HTB rate, not your statement.</span>
      </div>
      {!borrowOn ? <p className="small muted">Connect Schwab (My Bot → Stocks) to see borrow rates. Without it borrow shows —.</p> : null}
      <table className="pos-table pos-shorts__table">
        <thead>
          <tr>
            <th>Symbol</th>
            <th className="num">Shares</th>
            <th className="num">Entry</th>
            <th className="num">Price</th>
            <th className="num">Short P/L</th>
            <th className="num">Borrow rate</th>
            <th className="num">Borrow / day</th>
            <th className="num">Days</th>
            <th className="num">Paid (est.)</th>
            <th className="num">Net after borrow</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>
                <strong className="mono">{r.symbol}</strong> <span className="chip chip--short">Short</span>
                <div className="muted small">{r.source}</div>
              </td>
              <td className="num mono">−{r.shares.toLocaleString('en-US')}</td>
              <td className="num mono">{formatPrice(r.entry)}</td>
              <td className="num mono">{r.price != null ? formatPrice(r.price) : '…'}</td>
              <td className={`num mono ${tone(r.est.pnl)}`}>{money(r.est.pnl, { sign: true })}</td>
              <td className="num mono" title={rateTip(r)}>
                {!r.est.known ? '—' : r.est.etb ? 'ETB 0%' : `HTB ${r.est.rate}%*`}
              </td>
              <td className="num mono">{r.est.known ? `${money(r.est.daily)}/day` : '—'}</td>
              <td className="num mono">{r.est.days ?? '—'}</td>
              <td className="num mono neg">{r.est.known ? money(r.est.paid) : '—'}</td>
              <td className={`num mono ${tone(r.est.net)}`}>{r.est.known ? money(r.est.net, { sign: true }) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="pos-shorts__cards">
        {rows.map((r) => (
          <li key={r.key} className="pos-card">
            <div className="pos-card__top">
              <span>
                <strong className="mono">{r.symbol}</strong> <span className="chip chip--short">Short</span>
              </span>
              <span className={`mono ${tone(r.est.pnl)}`}>{money(r.est.pnl, { sign: true })}</span>
            </div>
            <div className="pos-card__mid mono small">
              <span className="muted">
                −{r.shares.toLocaleString('en-US')} @ {formatPrice(r.entry)}
              </span>
              <span>{r.price != null ? formatPrice(r.price) : '…'}</span>
            </div>
            <p className="pos-shorts__line small mono" title={rateTip(r)}>
              {r.est.known
                ? `${money(r.est.daily)}/day · paid ${money(r.est.paid)} over ${r.est.days ?? '—'} days · net ${money(r.est.net, { sign: true })}`
                : `borrow — · ${r.est.days ?? '—'} days held`}
              {r.est.known && !r.est.etb ? <span className="muted"> · HTB {r.est.rate}%*</span> : null}
            </p>
          </li>
        ))}
      </ul>
      <p className="small muted pos-shorts__foot">
        * Schwab’s htbRate is reported as a negative number; shown as its absolute value. Borrow/day = rate × shares × price ÷ 360. Paid applies today’s rate to each day held.
      </p>
    </section>
  );
}
