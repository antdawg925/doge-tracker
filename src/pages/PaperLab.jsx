import { useEffect, useMemo, useState } from 'react';
import { authedFetch } from '../lib/api.js';

/**
 * Stock Bot PAPER LAB (bot tier / owner only, read-only). Paper money only: many strategies, one
 * $10k paper account each, long + short. Data: GET /api/bot/paper-lab/view (Supabase, server-read).
 */
const usd = (n) => (n == null || Number.isNaN(+n) ? '—' : `${+n < 0 ? '-' : ''}$${Math.abs(+n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const pct = (n) => (n == null ? '—' : `${Math.round(n * 100)}%`);
const cls = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : 'muted');
const timePT = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' PT' : '—');
const px = (n) => (n == null ? '—' : (+n >= 10 ? (+n).toFixed(2) : (+n).toFixed(4)));

function stats(rows) {
  const n = rows.length;
  const pnl = rows.reduce((a, r) => a + (+r.pnl || 0), 0);
  return { n, win: n ? rows.filter((r) => +r.pnl > 0).length / n : null, pnl, avgR: n ? rows.reduce((a, r) => a + (+r.r || 0), 0) / n : null };
}

function StatCells({ s }) {
  return (
    <>
      <td>{s.n}</td>
      <td>{pct(s.win)}</td>
      <td className={cls(s.pnl)}>{usd(s.pnl)}</td>
      <td className={cls(s.avgR)}>{s.avgR == null ? '—' : s.avgR.toFixed(2)}</td>
    </>
  );
}

export default function PaperLab() {
  const [mode, setMode] = useState('prospective');
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [sort, setSort] = useState('pnl');

  useEffect(() => {
    let alive = true;
    const load = () => authedFetch(`/api/bot/paper-lab/view?mode=${mode}`)
      .then((d) => { if (alive) { setData(d); setErr(''); } })
      .catch((e) => alive && setErr(e.message));
    load();
    const id = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(id); };
  }, [mode]);

  const trades = data?.trades || [];
  const closed = useMemo(() => trades.filter((t) => t.status === 'closed'), [trades]);
  const open = useMemo(() => trades.filter((t) => t.status === 'open'), [trades]);

  const board = useMemo(() => {
    const ids = [...new Set([...trades.map((t) => t.strategy_id), ...Object.keys(data?.status?.accounts || {})])];
    const rows = ids.map((id) => {
      const c = closed.filter((t) => t.strategy_id === id);
      return {
        id, all: stats(c), long: stats(c.filter((t) => t.side === 'long')), short: stats(c.filter((t) => t.side === 'short')),
        open: open.filter((t) => t.strategy_id === id).length, equity: data?.status?.accounts?.[id]?.equity,
      };
    });
    const key = { pnl: (r) => r.all.pnl, win: (r) => r.all.win ?? -1, r: (r) => r.all.avgR ?? -99, n: (r) => r.all.n }[sort];
    return rows.sort((a, b) => key(b) - key(a));
  }, [trades, closed, open, data, sort]);

  const byRegime = useMemo(() => {
    const g = {};
    for (const t of closed) (g[t.regime || 'unknown'] ||= []).push(t);
    return Object.entries(g).map(([k, rows]) => ({ k, s: stats(rows), L: stats(rows.filter((t) => t.side === 'long')), S: stats(rows.filter((t) => t.side === 'short')) }));
  }, [closed]);

  const reg = data?.status?.regime;
  const tot = stats(closed);
  const Th = ({ k, children }) => (
    <th><button type="button" className="btn btn--ghost plab-sort" aria-pressed={sort === k} onClick={() => setSort(k)}>{children}</button></th>
  );

  return (
    <div className="pc-page plab">
      <header className="pc-head">
        <div className="pc-kicker">
          <span className="mode-pill mode-pill--paper">PAPER</span>
          <span className="muted">Stock Bot lab · $10k paper account per strategy · updated {timePT(data?.status?.ticked_at)}</span>
        </div>
        <h1>Paper Lab</h1>
        <div className="plab-bar">
          {reg ? (
            <span className={`plab-regime plab-regime--${reg.label}`}>
              {String(reg.label).toUpperCase()} · SPY {reg.spy} ({(reg.spy_vs_sma50 * 100).toFixed(1)}% vs 50d) · 20d {(reg.ret20 * 100).toFixed(1)}% · VIX {reg.vix}
            </span>
          ) : null}
          <span className="plab-modes">
            <button type="button" className="btn btn--ghost" aria-pressed={mode === 'prospective'} onClick={() => setMode('prospective')}>Live paper</button>
            <button type="button" className="btn btn--ghost" aria-pressed={mode === 'retrospective_replay'} onClick={() => setMode('retrospective_replay')}>Replay</button>
          </span>
        </div>
        <p className="muted plab-sum">
          {tot.n} closed · {open.length} open · win {pct(tot.win)} · <span className={cls(tot.pnl)}>{usd(tot.pnl)}</span> · avg R {tot.avgR == null ? '—' : tot.avgR.toFixed(2)}
          {mode === 'retrospective_replay' ? ' · replay of earlier bars, not live decisions' : ''}
        </p>
      </header>
      {err ? <p className="neg">{err}</p> : null}

      <section className="card pc-panel mode-card--paper">
        <h2>Leaderboard</h2>
        <div className="plab-scroll">
          <table className="plab-table">
            <thead>
              <tr><th>Strategy</th><Th k="n">Trades</Th><Th k="win">Win</Th><Th k="pnl">P&amp;L</Th><Th k="r">Avg R</Th><th>Open</th><th>Long n · P&amp;L</th><th>Short n · P&amp;L</th></tr>
            </thead>
            <tbody>
              {board.map((r) => (
                <tr key={r.id} className="mode-row--paper">
                  <td>{r.id}</td>
                  <StatCells s={r.all} />
                  <td>{r.open}</td>
                  <td>{r.long.n} · <span className={cls(r.long.pnl)}>{usd(r.long.pnl)}</span></td>
                  <td>{r.short.n} · <span className={cls(r.short.pnl)}>{usd(r.short.pnl)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card pc-panel mode-card--paper">
        <h2>By regime</h2>
        <div className="plab-scroll">
          <table className="plab-table">
            <thead><tr><th>Regime</th><th>Trades</th><th>Win</th><th>P&amp;L</th><th>Avg R</th><th>Long P&amp;L</th><th>Short P&amp;L</th></tr></thead>
            <tbody>
              {byRegime.map((g) => (
                <tr key={g.k} className="mode-row--paper">
                  <td>{g.k}</td><StatCells s={g.s} />
                  <td className={cls(g.L.pnl)}>{usd(g.L.pnl)}</td><td className={cls(g.S.pnl)}>{usd(g.S.pnl)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card pc-panel mode-card--paper">
        <h2>Open ({open.length})</h2>
        <div className="plab-scroll">
          <table className="plab-table">
            <thead><tr><th>Strategy</th><th>Sym</th><th>Side</th><th>Entry</th><th>Stop</th><th>Target</th><th>Since</th></tr></thead>
            <tbody>
              {open.slice(0, 200).map((t) => (
                <tr key={t.id} className="mode-row--paper">
                  <td>{t.strategy_id}</td><td>{t.symbol}</td><td className={t.side === 'short' ? 'neg' : 'pos'}>{t.side}</td>
                  <td>{px(t.entry)}</td><td>{px(t.stop)}</td><td>{px(t.target)}</td><td>{timePT(t.entry_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card pc-panel mode-card--paper">
        <h2>Closed (latest 100 of {closed.length})</h2>
        <div className="plab-scroll">
          <table className="plab-table">
            <thead><tr><th>Strategy</th><th>Sym</th><th>Side</th><th>Entry</th><th>Exit</th><th>P&amp;L</th><th>R</th><th>Why</th><th>Closed</th></tr></thead>
            <tbody>
              {[...closed].sort((a, b) => String(b.exit_at).localeCompare(String(a.exit_at))).slice(0, 100).map((t) => (
                <tr key={t.id} className="mode-row--paper">
                  <td>{t.strategy_id}</td><td>{t.symbol}</td><td className={t.side === 'short' ? 'neg' : 'pos'}>{t.side}</td>
                  <td>{px(t.entry)}</td><td>{px(t.exit)}</td><td className={cls(+t.pnl)}>{usd(t.pnl)}</td>
                  <td className={cls(+t.r)}>{t.r == null ? '—' : (+t.r).toFixed(2)}</td><td>{t.exit_reason}</td><td>{timePT(t.exit_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
