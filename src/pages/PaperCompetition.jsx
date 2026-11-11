import { useEffect, useMemo, useState } from 'react';
import {
  AGENTS, accountFor, agentKey, agentName, collectTrades, formatDatePT, formatTimePT, money, pnlClass,
  sessionOf, strategyBlurb, toNumber, todaySummary, topSkipReasons, tradeTarget, winRate,
} from '../lib/paperFeed.js';

/**
 * PUBLIC, read-only Paper Competition tab (El Patron vs Stock Bot, paper money only).
 * Reads only the sanitized feed from /api/paper/feed (static /paper/feed.json fallback).
 * Intentionally imports no auth, Supabase, broker, bot, order or Telegram code.
 */
async function loadFeed() {
  for (const url of ['/api/paper/feed', '/paper/feed.json']) {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      const type = r.headers.get('content-type') || '';
      if (r.ok && type.includes('json')) return await r.json();
    } catch {
      /* try next */
    }
  }
  throw new Error('feed unavailable');
}

function Scorecard({ data, agent }) {
  const acct = accountFor(data, agent.key);
  const trips = acct.completed_round_trips || [];
  const wr = winRate(trips);
  const unsettled = toNumber(acct.unsettled_cash) || 0;
  const blurb = strategyBlurb(data, agent.key);
  return (
    <article className="card pc-score">
      <h2>{agent.name}</h2>
      {blurb ? <p className="muted pc-strategy">{blurb}</p> : null}
      <div className="pc-trades-stat">
        <span className="pc-num pc-big">
          {trips.length}
          <span className="muted">/{tradeTarget(data, acct)}</span>
        </span>
        <span className="muted pc-label">trades today</span>
      </div>
      <div className="pc-stat-row">
        <div>
          <span className={`pc-num ${pnlClass(acct.realized_pnl)}`}>{money(acct.realized_pnl ?? 0)}</span>
          <span className="muted pc-label">net P&amp;L</span>
        </div>
        <div>
          <span className="pc-num" title={wr.title}>{wr.label}</span>
          <span className="muted pc-label">win rate</span>
        </div>
        <div>
          <span className="pc-num">{money(acct.settled_cash)}</span>
          <span className="muted pc-label">cash{unsettled ? ' (settled)' : ''}</span>
          {unsettled ? <span className="muted pc-label">plus {money(unsettled)} unsettled</span> : null}
        </div>
      </div>
    </article>
  );
}

function TradesTable({ trades }) {
  if (!trades.length) {
    return (
      <p className="pc-empty">
        <strong>No trades yet today.</strong> Both bots still have their starting cash and have not taken an entry.
      </p>
    );
  }
  const showSide = trades.some((t) => t.side);
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Time</th><th>Ticker</th><th>Bot</th>{showSide ? <th>Side</th> : null}<th>Setup / trigger</th>
            <th className="pc-r">Entry</th><th className="pc-r">Exit</th><th className="pc-r">P&amp;L</th><th>Lesson</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t, i) => (
            <tr key={`${t.agent}-${t.symbol}-${t.sort}-${i}`}>
              <td>{formatTimePT(t.time)}</td>
              <td className="pc-ticker">{t.symbol || '—'}</td>
              <td>{agentName(t.agent)}</td>
              {showSide ? (
                <td>{t.side ? <span className={`pc-side pc-side--${t.side}`}>{t.side === 'short' ? 'Short' : 'Long'}</span> : '—'}</td>
              ) : null}
              <td>{t.setup || '—'}</td>
              <td className="pc-r">{t.entry == null || t.entry === '' ? '—' : money(t.entry, { empty: String(t.entry) })}</td>
              <td className="pc-r">{t.exit === 'Open' ? 'Open' : t.exit == null || t.exit === '' ? '—' : money(t.exit, { empty: String(t.exit) })}</td>
              <td className={`pc-r ${t.open ? '' : pnlClass(t.pnl)}`}>{t.open || t.pnl == null ? '—' : money(t.pnl)}</td>
              <td>{t.lesson || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SkipList({ summary }) {
  if (!summary.total) return <p className="muted">No skip reasons yet.</p>;
  if (!summary.top.length) return <p className="muted">Checks ran, but no skip reasons were recorded.</p>;
  const max = summary.top[0].count || 1;
  return (
    <ol className="pc-skips">
      {summary.top.map((row, i) => (
        <li key={row.key}>
          <span className="pc-rank">{i + 1}</span>
          <span className="pc-reason">{row.label}</span>
          <span className="muted pc-count">
            {row.count.toLocaleString('en-US')} of {summary.total.toLocaleString('en-US')} checks
          </span>
          <div className="pc-bar" aria-hidden="true">
            <span style={{ width: `${Math.max(6, Math.round((row.count / max) * 100))}%` }} />
          </div>
        </li>
      ))}
    </ol>
  );
}

function RawDecisions({ data }) {
  const decisions = data.decisions || [];
  const snapshot = data.status?.snapshot_id || '';
  const latest = snapshot ? decisions.filter((d) => d.snapshot_id === snapshot) : decisions.slice(-40);
  const counts = new Map();
  for (const d of decisions) {
    const key = `${agentName(agentKey(d.agent))} · ${d.action || 'decision'}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const countLine = [...counts.entries()].map(([k, n]) => `${n} ${k}`).join(', ') || 'none';
  const showSide = latest.some((d) => d.side === 'long' || d.side === 'short');
  return (
    <>
      <p className="muted">
        {decisions.length} decisions today ({countLine}). Showing the latest check{snapshot ? ` (${snapshot})` : ''}.
      </p>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr><th>Time</th><th>Ticker</th><th>Bot</th>{showSide ? <th>Side</th> : null}<th>Action</th><th>Primary reason</th></tr>
          </thead>
          <tbody>
            {latest.length ? latest.map((d, i) => (
              <tr key={`${d.agent}-${d.symbol}-${i}`}>
                <td>{formatTimePT(d.decision_at || d.observed_at)}</td>
                <td className="pc-ticker">{d.symbol || '—'}</td>
                <td>{agentName(agentKey(d.agent))}</td>
                {showSide ? <td>{d.side === 'short' ? 'Short' : d.side === 'long' ? 'Long' : '—'}</td> : null}
                <td>{d.action || '—'}</td>
                <td>{d.reason || (Array.isArray(d.skip_reasons) ? d.skip_reasons[0] : d.skip_reason) || '—'}</td>
              </tr>
            )) : (
              <tr><td colSpan={showSide ? 6 : 5}>No decisions in the feed.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function ProbeDetail({ data }) {
  const probe = data.latest_probe || {};
  if (!probe.probe_id && !probe.observed_at) return <p className="muted">No market check is in the feed yet.</p>;
  const symbols = Array.isArray(probe.symbols) ? probe.symbols : [];
  const eligible = symbols.filter((s) => s && s.eligible_fresh);
  return (
    <>
      <p>
        {probe.probe_id || 'probe'} at {formatTimePT(probe.observed_at, { withDate: true })}. Passed: {probe.passed === true ? 'yes' : 'no'}.
        {' '}Eligible low-float names: {String(probe.eligible_fresh_count ?? eligible.length)} (need {String(probe.min_eligible_required ?? '—')}).
        {' '}Fail reasons: {(probe.fail_reasons || []).join(', ') || '—'}.
      </p>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Ticker</th><th>Eligible</th><th>Float shares</th><th>Reasons</th></tr></thead>
          <tbody>
            {symbols.length ? symbols.map((s, i) => {
              const fl = s.float && (s.float.shares ?? s.float.float_shares);
              return (
                <tr key={`${s.symbol}-${i}`}>
                  <td className="pc-ticker">{s.symbol || '—'}</td>
                  <td>{s.eligible_fresh ? 'yes' : 'no'}</td>
                  <td>{fl != null ? Number(fl).toLocaleString('en-US') : '—'}</td>
                  <td>{Array.isArray(s.reasons) ? s.reasons.join(', ') : '—'}</td>
                </tr>
              );
            }) : (
              <tr><td colSpan={4}>No symbols on this check.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Protocol({ data }) {
  const status = data.status || {};
  return (
    <ul className="pc-list">
      <li>Experiment {data.experiment_id || '—'}. Protocol {data.protocol_version || '—'}.</li>
      <li>Each bot starts with $15,000 cash, no leverage, a $1,500 all-in cap per entry, and a 1.5% cost on each side.</li>
      <li>This is a paper simulator using delayed public data. Fills are not broker executions. No real accounts.</li>
      <li>
        Claimed live: {data.claimed_live ? 'yes (unexpected)' : 'no'}. Official trading active:{' '}
        {status.official_trading_active === true || data.official_trading_active === true ? 'yes' : 'no'}.
      </li>
      <li>Stock Bot decisions come from its export; official fills come from the shared simulator.</li>
      <li>Feed generated {formatTimePT(data.generated_at_pt || data.written_at_pt, { withDate: true })}. {data.database || ''}</li>
    </ul>
  );
}

export default function PaperCompetition() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let alive = true;
    loadFeed().then((d) => alive && setData(d)).catch(() => alive && setError(true));
    return () => { alive = false; };
  }, []);

  const derived = useMemo(() => {
    if (!data) return null;
    const trades = collectTrades(data);
    return { trades, summary: todaySummary(data, trades), skips: topSkipReasons(data) };
  }, [data]);

  return (
    <main className="pc-page">
      <header className="pc-head">
        <p className="muted pc-kicker">
          <span className="mode-pill mode-pill--paper">PAPER</span> Paper money only · delayed public data · not real trades
        </p>
        <h1>El Patron vs Stock Bot</h1>
        <p className="muted">
          {error ? 'Feed unavailable' : data
            ? `${formatDatePT(sessionOf(data))} · updated ${formatTimePT(data.generated_at_pt || data.written_at_pt)}`
            : 'Loading…'}
        </p>
      </header>

      {error ? (
        <section className="card pc-today"><p>The daily feed has not been published yet, so there is nothing to show.</p></section>
      ) : !data ? (
        <section className="card pc-today"><p className="muted">Loading…</p></section>
      ) : (
        <>
          <section className="card pc-today" aria-label="Today in one line">
            <p className="pc-today-line">{derived.summary.line}</p>
            {derived.summary.sub ? <p className="muted">{derived.summary.sub}</p> : null}
          </section>

          <section className="pc-scoreboard" aria-label="Scoreboard">
            {AGENTS.map((a) => <Scorecard key={a.key} data={data} agent={a} />)}
          </section>

          <section className="card pc-panel" aria-labelledby="pc-trades">
            <h2 id="pc-trades">Trades today</h2>
            <TradesTable trades={derived.trades} />
          </section>

          <section className="card pc-panel" aria-labelledby="pc-skips">
            <h2 id="pc-skips">Top skip reasons</h2>
            <SkipList summary={derived.skips} />
          </section>

          <section className="pc-more" aria-label="More detail">
            <details className="card">
              <summary>Raw decisions</summary>
              <RawDecisions data={data} />
            </details>
            <details className="card">
              <summary>Latest market check</summary>
              <ProbeDetail data={data} />
            </details>
            <details className="card">
              <summary>Rules and protocol</summary>
              <Protocol data={data} />
            </details>
          </section>
        </>
      )}
    </main>
  );
}
