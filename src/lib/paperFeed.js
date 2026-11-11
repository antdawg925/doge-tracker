/**
 * Pure helpers for the public Paper Competition tab (paper money only).
 * Ported from the standalone paper-daytrade-competition dashboard. No network, broker, bot or auth code.
 */
export const TARGET_TRADES = 10;
export const LOW_FLOAT_MAX = 20_000_000;
export const AGENTS = [
  { key: 'el_patron', name: 'El Patron' },
  { key: 'stock_bot', name: 'Stock Bot' },
];

const SKIP_LABELS = {
  last_bar_low_not_near_vwap: 'Price wasn’t close enough to VWAP',
  setup_not_confirmed_on_last_complete_bar: 'Setup wasn’t confirmed on the last complete bar',
  volume_too_low: 'Volume was too low',
  float_outstanding_only_not_float: 'Official float wasn’t available',
  spread_too_wide: 'Spread was too wide',
  float_too_large: 'Float was above the 20 million share limit',
  stale: 'Data was stale or the market check hadn’t passed',
  last_bar_low_pierced_vwap_too_far: 'Price dropped too far below VWAP',
  last_bar_did_not_close_above_vwap: 'The last bar didn’t close above VWAP',
  spread_unknown: 'Spread couldn’t be measured',
  float_unknown: 'Float was unknown',
  no_completed_reclaim_before_last_bar: 'VWAP reclaim wasn’t complete',
  never_closed_below_vwap: 'Price never closed below VWAP',
  premarket_no_volume: 'No premarket volume',
  premarket_no_bars: 'No premarket bars',
  rvol_unavailable: 'Relative volume wasn’t available',
  past_entry_cutoff: 'Past the entry cutoff time',
};

export function toNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function money(value, { empty = '—' } = {}) {
  const n = toNumber(value);
  if (n == null) return empty;
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export function agentKey(value) {
  return String(value || '').toLowerCase().replace(/-/g, '_');
}

export function agentName(key) {
  if (key === 'el_patron') return 'El Patron';
  if (key === 'stock_bot') return 'Stock Bot';
  return key || '—';
}

export function accountFor(data, key) {
  const accounts = data.accounts || {};
  if (accounts[key]) return accounts[key];
  for (const [k, acct] of Object.entries(accounts)) {
    if (agentKey(k) === key || agentKey(acct && acct.competitor) === key) return acct;
  }
  return {};
}

function rowsForAgent(rows, key) {
  return (rows || []).filter((row) => agentKey(row.agent || row.competitor) === key);
}

function parseTime(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatTimePT(value, { withDate = false } = {}) {
  const d = parseTime(value);
  if (!d) return value ? String(value) : '—';
  const opts = { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' };
  if (withDate) {
    opts.month = 'short';
    opts.day = 'numeric';
  }
  return `${new Intl.DateTimeFormat('en-US', opts).format(d)} PT`;
}

export function formatDatePT(value) {
  const fmt = { timeZone: 'America/Los_Angeles', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' };
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Intl.DateTimeFormat('en-US', fmt).format(new Date(`${value}T12:00:00-08:00`));
  }
  const d = parseTime(value);
  if (!d) return value || '—';
  return new Intl.DateTimeFormat('en-US', fmt).format(d);
}

export function friendlySetup(value) {
  const raw = String(value || '').trim();
  if (!raw) return '—';
  if (raw === 'premarket_high_breakout') return 'Break above premarket high';
  if (raw === 'vwap_reclaim_pullback') return 'VWAP reclaim pullback';
  if (raw === 'failed_premarket_high_break') return 'Failed premarket-high break (short)';
  if (raw === 'vwap_rejection') return 'VWAP rejection (short)';
  return raw.replace(/_/g, ' ');
}

function mostCommon(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  let best = '';
  let n = 0;
  for (const [k, c] of counts) if (c > n) { best = k; n = c; }
  return best;
}

export function strategyBlurb(data, key) {
  const top = mostCommon(rowsForAgent(data.candidates, key).map((c) => c.setup).filter(Boolean));
  if (top === 'premarket_high_breakout') return 'Looks for a break above the premarket high';
  if (top === 'vwap_reclaim_pullback') return 'Looks for a pullback after reclaiming VWAP';
  return top ? friendlySetup(top) : '';
}

export function tradeTarget(data, acct) {
  const fromDecisions = (data.decisions || []).map((d) => toNumber(d.round_trip_target)).find((n) => n != null);
  if (fromDecisions != null) return fromDecisions;
  const fromAcct = toNumber(acct.round_trip_target);
  return fromAcct != null ? fromAcct : TARGET_TRADES;
}

export function positionList(acct) {
  const positions = (acct && acct.positions) || {};
  if (Array.isArray(positions)) return positions;
  return Object.entries(positions).map(([symbol, pos]) => ({ symbol, ...pos }));
}

export function winRate(trips) {
  if (!trips.length) return { label: '—', title: 'No completed trades yet' };
  const wins = trips.filter((t) => (toNumber(t.net_pnl) || 0) > 0).length;
  return { label: `${Math.round((wins / trips.length) * 100)}%`, title: `${wins} of ${trips.length} completed trades were profitable` };
}

function floatShares(record) {
  const fl = record && record.float;
  if (typeof fl === 'number') return fl;
  if (!fl || typeof fl !== 'object') return null;
  return toNumber(fl.float_shares ?? fl.shares);
}

function lowFloatSymbols(data) {
  const found = new Map();
  for (const row of [...(data.candidates || []), ...(data.decisions || [])]) {
    const shares = floatShares(row);
    const status = row.float && typeof row.float === 'object' ? String(row.float.status || '') : '';
    if (!row.symbol || status !== 'AVAILABLE' || shares == null) continue;
    if (shares <= LOW_FLOAT_MAX) found.set(row.symbol, shares);
  }
  return [...found.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
}

/** Long/short direction for a trade-like record; null when the feed doesn't say. */
export function directionOf(rec) {
  if (!rec) return null;
  for (const k of ['direction', 'position_side', 'side']) {
    const v = String(rec[k] || '').toLowerCase();
    if (v === 'long' || v === 'short') return v;
    if (v === 'sell_short' || v === 'buy_to_cover') return 'short';
  }
  return null;
}

export function collectTrades(data) {
  const rows = [];
  const seen = new Set();
  for (const { key } of AGENTS) {
    const acct = accountFor(data, key);
    for (const trip of acct.completed_round_trips || []) {
      seen.add(`${key}|${trip.symbol}|${trip.entry_time || ''}`);
      rows.push({
        sort: trip.exit_time || trip.entry_time || '',
        time: trip.exit_time || trip.entry_time,
        symbol: trip.symbol,
        agent: key,
        side: directionOf(trip),
        setup: friendlySetup(trip.setup_label || trip.setup || trip.setup_class),
        entry: trip.entry_price,
        exit: trip.exit_price,
        pnl: trip.net_pnl,
        lesson: trip.lesson || trip.lesson_text || '',
        open: false,
      });
    }
    for (const pos of positionList(acct)) {
      seen.add(`${key}|${pos.symbol}|${pos.entry_time || ''}`);
      rows.push({
        sort: pos.entry_time || '',
        time: pos.entry_time,
        symbol: pos.symbol,
        agent: key,
        side: directionOf(pos),
        setup: friendlySetup(pos.setup_label || pos.setup),
        entry: pos.entry_price,
        exit: 'Open',
        pnl: null,
        lesson: pos.lesson || '',
        open: true,
      });
    }
  }
  for (const fill of data.fills || []) {
    if (fill.rejected) continue;
    const key = agentKey(fill.agent || fill.competitor);
    const stamp = fill.fill_bar_start || fill.observed_at || '';
    if (seen.has(`${key}|${fill.symbol}|${stamp}`)) continue;
    const act = String(fill.side || '').toLowerCase();
    const opening = act === 'buy' || act === 'sell_short';
    const closing = act === 'sell' || act === 'buy_to_cover';
    rows.push({
      sort: stamp,
      time: stamp,
      symbol: fill.symbol,
      agent: key,
      side: directionOf(fill),
      setup: friendlySetup(fill.setup_label || fill.setup || fill.reason || ''),
      entry: opening ? fill.price || fill.fill_price : '—',
      exit: closing ? fill.price || fill.fill_price : '—',
      pnl: fill.net_pnl ?? null,
      lesson: fill.lesson || '',
      open: false,
    });
  }
  rows.sort((a, b) => String(a.sort).localeCompare(String(b.sort)));
  return rows;
}

function groupSkipReason(reason) {
  const r = String(reason || '').trim();
  if (!r) return null;
  if (r.startsWith('float_above_max') || r === 'float_above_20m') return 'float_too_large';
  if (r.startsWith('spread_proxy_too_wide')) return 'spread_too_wide';
  if (r.startsWith('rvol_below_min')) return 'volume_too_low';
  if (
    r === 'stale_data' || r.startsWith('stale_detail') || r === 'source_freshness_not_qualified'
    || r === 'stale_or_not_fresh_or_probe_not_passed' || r === 'symbol_stale_1m_bar'
  ) return 'stale';
  if (r === 'spread_proxy_unknown') return 'spread_unknown';
  return r;
}

function skipTokens(row) {
  const tokens = [];
  if (Array.isArray(row.skip_reasons)) {
    for (const item of row.skip_reasons) {
      if (typeof item === 'string') tokens.push(item);
      else if (item && typeof item === 'object') tokens.push(item.reason || item.code || JSON.stringify(item));
    }
  }
  const single = row.skip_reason || (typeof row.reason === 'string' && !tokens.length ? row.reason : '');
  if (single) for (const part of String(single).split(',')) if (part.trim()) tokens.push(part.trim());
  return tokens;
}

export function topSkipReasons(data) {
  const reviews = [...(data.decisions || [])];
  // El Patron logs candidates but not per-candidate decisions.
  for (const c of data.candidates || []) if (agentKey(c.agent) === 'el_patron') reviews.push(c);
  const counts = new Map();
  for (const row of reviews) {
    for (const key of new Set(skipTokens(row).map(groupSkipReason).filter(Boolean))) counts.set(key, (counts.get(key) || 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return {
    total: reviews.length,
    top: ranked.slice(0, 5).map(([key, count]) => ({ key, count, label: SKIP_LABELS[key] || key.replace(/_/g, ' ') })),
  };
}

export function todaySummary(data, trades) {
  const low = lowFloatSymbols(data);
  const fills = (data.fills || []).filter((f) => !f.rejected);
  const noTrades = trades.length === 0 && fills.length === 0;
  const probe = data.latest_probe || {};
  const probeFailed = probe.passed === false;
  const failReasons = Array.isArray(probe.fail_reasons) ? probe.fail_reasons : [];
  const noEligible = probeFailed && (toNumber(probe.eligible_fresh_count) === 0 || failReasons.includes('insufficient_eligible_low_float_fresh_bars'));

  let line;
  if (noTrades && low.length === 1) {
    line = `No trades yet — only 1 stock (${low[0][0]}) had a verified low float, and no entry triggered.`;
  } else if (noTrades && low.length === 0) {
    line = noEligible
      ? 'No trades yet — the latest market check found no eligible low-float stocks, and neither bot took an entry.'
      : 'No trades yet — no stocks had a verified low float, and neither bot took an entry.';
  } else if (noTrades) {
    line = `No trades yet — ${low.length} stocks had a verified low float (${low.map(([s]) => s).join(', ')}), and no entry triggered.`;
  } else {
    line = AGENTS.map(({ key, name }) => {
      const acct = accountFor(data, key);
      const open = positionList(acct).length;
      const bits = [`${name} ${(acct.completed_round_trips || []).length} completed`];
      if (open) bits.push(`${open} still open`);
      bits.push(`P&L ${money(acct.realized_pnl)}`);
      return bits.join(', ');
    }).join('. ') + '.';
  }

  let sub = '';
  if (probe.observed_at) {
    const at = formatTimePT(probe.observed_at);
    if (probeFailed && noEligible && low.length > 0) sub = `Latest check at ${at} found no eligible low-float names.`;
    else if (probeFailed) sub = `Latest check at ${at} did not pass.`;
    else if (probe.passed === true) sub = `Latest check at ${at} passed. This is paper trading only.`;
  }
  return { line, sub };
}

export function pnlClass(value) {
  const n = toNumber(value);
  if (n == null || n === 0) return 'pc-flat';
  return n > 0 ? 'pc-up' : 'pc-down';
}

export function sessionOf(data) {
  return (data.decisions && data.decisions[0] && data.decisions[0].session_date)
    || (data.latest_probe && data.latest_probe.session_date)
    || (data.generated_at_pt || '').slice(0, 10);
}
