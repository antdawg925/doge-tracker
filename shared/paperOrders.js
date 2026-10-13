/**
 * Paper limit orders (pure). Bars: intraday OHLC { t (ms, bar start), open, high, low, close },
 * regular hours only. Only bars that START at/after the order time count (no look-back).
 *   fill:  long low <= limit (gap open below → open), short high >= limit (gap open above → open)
 *   exit:  from the bar AFTER the fill: stop first if a bar touches both (conservative), else target.
 */
export const PAPER_EXCLUDES = Object.freeze(new Set(['TSLA']));
const fin = (x) => Number.isFinite(x);

export function paperStep(idea, bars, { nowMs = Date.now() } = {}) {
  const short = idea.side === 'short';
  const out = { fill: null, exit: null };
  const list = (bars || []).filter((b) => fin(b?.t) && fin(b.low) && fin(b.high) && b.t <= nowMs).sort((a, b) => a.t - b.t);
  let entry = Number(idea.entry_price);
  let fillT = idea.filled_at ? Date.parse(idea.filled_at) : null;
  if (idea.status === 'pending') {
    const lim = Number(idea.limit_price || idea.entry_price);
    const from = Date.parse(idea.placed_at || idea.created_at || 0);
    const b = list.find((x) => x.t >= from && (short ? x.high >= lim : x.low <= lim));
    if (!b) return out;
    const gap = fin(b.open) && (short ? b.open > lim : b.open < lim);
    entry = gap ? b.open : lim;
    fillT = b.t;
    out.fill = { price: entry, t: b.t };
  } else if (idea.status !== 'open') {
    return out;
  }
  if (!idea.auto_exit && idea.status === 'open') return out;
  const stop = Number(idea.stop_price);
  const tgt = Number(idea.target_price);
  for (const b of list) {
    if (!(b.t > fillT)) continue;
    const hitStop = stop > 0 && (short ? b.high >= stop : b.low <= stop);
    const hitTgt = tgt > 0 && (short ? b.low <= tgt : b.high >= tgt);
    if (hitStop) {
      const gap = fin(b.open) && (short ? b.open > stop : b.open < stop);
      out.exit = { reason: 'stop', price: gap ? b.open : stop, t: b.t };
      break;
    }
    if (hitTgt) {
      const gap = fin(b.open) && (short ? b.open < tgt : b.open > tgt);
      out.exit = { reason: 'target', price: gap ? b.open : tgt, t: b.t };
      break;
    }
  }
  if (out.exit) out.exit.pnl = (out.exit.price - entry) * Number(idea.qty) * (short ? -1 : 1);
  return out;
}

/** Scorecard for closed paper ideas. */
export function paperScore(ideas) {
  const closed = (ideas || []).filter((i) => i.status === 'closed');
  const pnlOf = (i) => (fin(Number(i.realized_pnl)) && i.realized_pnl != null ? Number(i.realized_pnl) : (Number(i.exit_price) - Number(i.entry_price)) * Number(i.qty) * (i.side === 'short' ? -1 : 1));
  const rows = closed.map((i) => ({ ...i, pnl: pnlOf(i) })).filter((i) => fin(i.pnl));
  const auto = rows.filter((i) => i.exit_reason === 'target' || i.exit_reason === 'stop');
  const wins = rows.filter((i) => i.pnl > 0);
  const losses = rows.filter((i) => i.pnl < 0);
  const avg = (a) => (a.length ? a.reduce((s, i) => s + i.pnl, 0) / a.length : null);
  return {
    closed: rows.length,
    targetHits: auto.filter((i) => i.exit_reason === 'target').length,
    targetHitRate: auto.length ? auto.filter((i) => i.exit_reason === 'target').length / auto.length : null,
    autoClosed: auto.length,
    avgWin: avg(wins),
    avgLoss: avg(losses),
    realized: rows.reduce((s, i) => s + i.pnl, 0),
  };
}
