/**
 * TSB Profit lock + Pause guard (pure).
 *
 * RULE: the bot must never leave a user below their starting amount while unattended.
 *
 * !!! Every order path MUST go through this module: call preTradeCheck() before ANY
 * !!! fill or order (sell, stop exit, buy-back) and afterFill() right after each fill.
 * !!! Paper trading (shared/paper.js) does this today; the future live-order path must
 * !!! call the same two functions before placing a real order — never bypass them.
 *
 * Baseline ("amount put in") = shares × avg cost:
 *   paper book → paper shares (notional) × the plan's avg cost
 *   live book  → position shares × avg cost (future)
 * After a user unlocks ("Authorize next trade"), the baseline becomes the book value at
 * that moment, so the next lock fires if the book falls below where they re-authorized.
 *
 * Max loss ("willing to lose" line): per user, default $1. Lock line = baseline − max loss.
 * After a fill, book < lock line → LOCKED. A buy-back is also blocked when the current
 * book is already below the lock line.
 *
 * Book value = cash + holdings valued at a price (the fill price right after a fill).
 * Realized P&L is tracked with average-cost accounting across all fills, cumulatively.
 */

const EPS = 1e-6;
export const DEFAULT_MAX_LOSS_USD = 1;
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export const GUARD_DECISIONS = Object.freeze({
  locked: 'locked',
  blockedLocked: 'blocked_locked',
  blockedPaused: 'blocked_paused',
  blockedBelowBaseline: 'blocked_below_baseline',
});

/** Columns of a bot_guard row the engine owns (DB-only columns like user_id are ignored). */
export const GUARD_FIELDS = Object.freeze([
  'locked', 'locked_at', 'lock_reason', 'paused', 'paused_at', 'paused_by', 'unlocked_at', 'unlocked_by',
  'baseline_value', 'baseline_shares', 'baseline_avg_cost', 'baseline_source', 'baseline_set_at',
  'realized_pnl', 'max_loss_usd', 'data',
]);
export function pickGuard(g) {
  if (!g) return null;
  return GUARD_FIELDS.reduce((acc, k) => ((acc[k] = g[k] ?? null), acc), {});
}
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}
/** Key-order-insensitive equality (jsonb reorders keys; numeric columns may come back as strings). */
export function sameGuard(a, b) {
  const norm = (g) => {
    const x = pickGuard(g);
    if (!x) return x;
    for (const k of ['baseline_value', 'baseline_shares', 'baseline_avg_cost', 'realized_pnl', 'max_loss_usd']) {
      x[k] = x[k] == null ? null : Number(x[k]);
    }
    for (const k of ['locked_at', 'paused_at', 'unlocked_at', 'baseline_set_at']) {
      x[k] = x[k] == null ? null : new Date(x[k]).toISOString();
    }
    return x;
  };
  return stable(norm(a)) === stable(norm(b));
}

/** Max loss in $ (>= 0; default $1). */
export function maxLossOf(guard) {
  const m = Number(guard?.max_loss_usd);
  return Number.isFinite(m) && m >= 0 ? m : DEFAULT_MAX_LOSS_USD;
}
/** Lock line = baseline − max loss (null without a baseline). */
export function lockLine(guard) {
  const b = Number(guard?.baseline_value);
  return guard?.baseline_value != null && Number.isFinite(b) ? b - maxLossOf(guard) : null;
}
/** Validate a user-entered max loss. Returns a number or throws. */
export function parseMaxLoss(v) {
  const m = typeof v === 'string' ? Number(v.trim()) : Number(v);
  if (!Number.isFinite(m) || m < 0 || m > 1e9) throw new Error('Max loss must be a dollar amount of 0 or more.');
  return Math.round(m * 100) / 100;
}

export const bookValue = ({ cash, units, price }) => n(cash) + n(units) * n(price);

/** New guard (armed) from shares × avg cost. Keeps paused/locked flags from `prev` if given. */
export function initGuard({ shares, avgCost, nowIso, source = 'plan_cost', prev = null }) {
  const s = n(shares);
  const c = n(avgCost);
  return {
    locked: Boolean(prev?.locked),
    locked_at: prev?.locked_at ?? null,
    lock_reason: prev?.lock_reason ?? null,
    paused: Boolean(prev?.paused),
    paused_at: prev?.paused_at ?? null,
    paused_by: prev?.paused_by ?? null,
    unlocked_at: prev?.unlocked_at ?? null,
    unlocked_by: prev?.unlocked_by ?? null,
    baseline_value: s * c,
    baseline_shares: s,
    baseline_avg_cost: c,
    baseline_source: source,
    baseline_set_at: nowIso,
    realized_pnl: n(prev?.realized_pnl),
    max_loss_usd: maxLossOf(prev),
    data: { ...(prev?.data || {}), cost_units: s, cost_value: s * c },
  };
}

/**
 * Before any fill. kind: 'sell_slice' | 'buy_back' | 'exit_core'.
 * @returns {{ allowed: boolean, decision?: string, reason?: string }}
 */
export function preTradeCheck(guard, { kind, bookValueNow }) {
  if (!guard) return { allowed: true };
  if (guard.locked) {
    return { allowed: false, decision: GUARD_DECISIONS.blockedLocked, reason: `${label(kind)} skipped: TSB is locked` };
  }
  if (guard.paused) {
    return { allowed: false, decision: GUARD_DECISIONS.blockedPaused, reason: `${label(kind)} skipped: bot paused` };
  }
  const line = lockLine(guard);
  if (kind === 'buy_back' && line != null && n(bookValueNow) < line - EPS) {
    return {
      allowed: false,
      decision: GUARD_DECISIONS.blockedBelowBaseline,
      reason: `${label(kind)} skipped: book ${usd(bookValueNow)} is below starting ${usd(guard.baseline_value)} − max loss ${usd(maxLossOf(guard))}`,
    };
  }
  return { allowed: true };
}

/**
 * After a fill: update cumulative realized P&L and lock if the book is below baseline.
 * @param fill { kind, side: 'buy'|'sell', units, price }
 * @param bookValueAtFill cash + holdings valued at the fill price (after the fill)
 * @returns {{ guard, locked: boolean, reason: string|null }}
 */
export function afterFill(guard, { fill, bookValueAtFill, nowIso }) {
  if (!guard) return { guard, locked: false, reason: null };
  const g = { ...guard, data: { ...(guard.data || {}) } };
  const d = g.data;
  const units = n(fill.units);
  const price = n(fill.price);
  if (fill.side === 'sell') {
    const avg = n(d.cost_units) > 0 ? n(d.cost_value) / n(d.cost_units) : n(g.baseline_avg_cost);
    g.realized_pnl = n(g.realized_pnl) + units * (price - avg);
    d.cost_value = Math.max(0, n(d.cost_value) - units * avg);
    d.cost_units = Math.max(0, n(d.cost_units) - units);
  } else {
    d.cost_value = n(d.cost_value) + units * price;
    d.cost_units = n(d.cost_units) + units;
  }
  d.last_fill_book = bookValueAtFill;
  const line = lockLine(g);
  if (!g.locked && line != null && n(bookValueAtFill) < line - EPS) {
    g.locked = true;
    g.locked_at = nowIso;
    const loss = maxLossOf(g);
    g.lock_reason =
      `${fillLabel(fill)} filled at ${px(price)}; book ${usd(bookValueAtFill)} is below starting ${usd(g.baseline_value)}` +
      (loss > 0 ? ` − max loss ${usd(loss)}` : '');
    return { guard: g, locked: true, reason: g.lock_reason };
  }
  return { guard: g, locked: false, reason: null };
}

/** User re-authorizes: clear the lock and reset the baseline to the current book value. */
export function unlockGuard(guard, { bookValueNow, units, price, userId, nowIso }) {
  return {
    ...guard,
    locked: false,
    lock_reason: null,
    unlocked_at: nowIso,
    unlocked_by: userId,
    baseline_value: n(bookValueNow),
    baseline_shares: n(units),
    baseline_avg_cost: n(price),
    baseline_source: 'reauthorized',
    baseline_set_at: nowIso,
    data: { ...(guard.data || {}), cost_units: n(units), cost_value: n(units) * n(price), last_blocked: null },
  };
}

function label(kind) {
  return (
    {
      sell_slice: 'slice sell',
      buy_back: 'buy-back',
      exit_core: 'core stop exit',
      entry: 'new entry',
      reentry: 're-entry',
      loosen_stop: 'loosening the stop',
    }[kind] || 'trade'
  );
}

// ---------------------------------------------------------------------------------------
// Stock book (paper now, Schwab later). Every stock order action goes through orderCheck()
// first and every fill through afterBookFill(). Rule:
//   PROTECTIVE actions are ALWAYS allowed, even when locked or paused: placing the stop for
//   a position already held, tightening it (long up / short down), cancelling it because
//   the position is gone, and a stop FILL (that is the exit).
//   RISK-ADDING actions are blocked while locked or paused: a new entry, a re-entry, or
//   loosening a stop. (Unrealized drawdown alone doesn't block entries; the lock itself is
//   decided on fills by afterBookFill, like DOGE.)
// ---------------------------------------------------------------------------------------
export const PROTECTIVE_KINDS = Object.freeze(new Set(['place_stop', 'tighten_stop', 'cancel_stop', 'stop_fill']));
export const ENTRY_KINDS = Object.freeze(new Set(['entry', 'reentry', 'loosen_stop']));

/** @returns {{ allowed, protective?, decision?, reason?, note? }} */
export function orderCheck(guard, { kind, bookValueNow = null }) {
  if (PROTECTIVE_KINDS.has(kind)) {
    const note = guard?.locked ? 'protective: allowed while locked' : guard?.paused ? 'protective: allowed while paused' : null;
    return { allowed: true, protective: true, note };
  }
  if (!ENTRY_KINDS.has(kind)) throw new Error(`Unknown order action: ${kind}`);
  return preTradeCheck(guard, { kind, bookValueNow });
}

/**
 * After a stock-book fill. book = Σ entry basis + Σ paper P/L; baseline = Σ entry basis
 * (+ P/L at the last re-authorization). Locks when book < baseline − max loss.
 * @param fill { kind: 'stop_fill', symbol, side, units, price, pnl }
 */
export function afterBookFill(guard, { fill, bookValueAtFill, nowIso }) {
  if (!guard) return { guard, locked: false, reason: null };
  const g = { ...guard, data: { ...(guard.data || {}) } };
  g.realized_pnl = n(g.realized_pnl) + n(fill.pnl);
  g.data.last_fill_book = bookValueAtFill;
  const line = lockLine(g);
  if (!g.locked && line != null && n(bookValueAtFill) < line - EPS) {
    g.locked = true;
    g.locked_at = nowIso;
    const loss = maxLossOf(g);
    g.lock_reason =
      `${fill.symbol || 'Stock'} stop filled at ${px(fill.price)}; book ${usd(bookValueAtFill)} is below starting ${usd(g.baseline_value)}` +
      (loss > 0 ? ` − max loss ${usd(loss)}` : '');
    return { guard: g, locked: true, reason: g.lock_reason };
  }
  return { guard: g, locked: false, reason: null };
}
function fillLabel(fill) {
  return { sell_slice: 'Slice sell', buy_back: 'Buy-back', exit_core: 'Stop' }[fill.kind] || 'Trade';
}
function px(x) {
  return `$${n(x) < 1 ? n(x).toFixed(5) : n(x).toFixed(2)}`;
}
function usd(x) {
  return `$${n(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
