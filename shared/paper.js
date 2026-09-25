/**
 * Watch-only paper trading (pure). Simulates the plan on a notional position:
 *   core  (corePct %)  — held until price touches the effective stop, then exits
 *                        entirely and stays in cash ('core stopped out').
 *   slice (slicePct %) — sells at sellLevel, buys back at buyBackLevel with the
 *                        slice cash; one sell per cycle (sell → buy back → sell …).
 * Slice fills assume the level price; a stop fills at the price the 5-min check saw
 * (at/below the stop). Every fill passes the TSB guard
 * (shared/guard.js) when one is supplied. Nothing here places an order.
 */
import { afterFill, preTradeCheck } from './guard.js';

export const PAPER_DEFAULT_UNITS = 10000;

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Fresh paper book at `price`. `units` = notional DOGE, split by the plan's core/slice %. */
export function initPaper({ symbol = 'DOGE', plan, price, units, unitsSource, nowIso }) {
  const total = n(units) > 0 ? n(units) : PAPER_DEFAULT_UNITS;
  const corePct = n(plan?.corePct);
  const slicePct = n(plan?.slicePct);
  const sum = corePct + slicePct;
  const core = sum > 0 ? (total * corePct) / sum : total;
  const slice = total - core;
  return {
    symbol,
    started_at: nowIso,
    start_price: price,
    core_units: core,
    slice_units: slice,
    cash: 0,
    last_action_at: null,
    data: {
      notional_units: total,
      units_source: unitsSource || 'default',
      slice_cash: 0,
      core_cash: 0,
      core_stopped: false,
      core_stopped_at: null,
      slice_sold: false,
      cycles: 0,
    },
  };
}

/**
 * One check at `price`. Returns { paper, trades, events, blocked, guard, lockedNow } —
 * `paper` / `guard` are new objects. events ⊆ ['sell_slice', 'buy_back', 'exit_core'].
 *
 * When `guard` is given (TSB Profit lock, shared/guard.js), EVERY fill goes through
 * preTradeCheck() first and afterFill() right after; a blocked fill is skipped and
 * reported in `blocked`. Once a fill locks the guard, later fills in the run are blocked.
 *
 * Fill prices: slice sell / buy-back at their level (resting limit-style orders); the
 * core stop at the run price — the bot sees price every 5 min and would sell at market
 * when a check finds price at/below the stop, so a gap through the stop fills lower.
 */
export function stepPaper(paper, { plan, price, effectiveStop, nowIso, guard = null }) {
  const p = { ...paper, data: { ...(paper.data || {}) } };
  const d = p.data;
  const trades = [];
  const events = [];
  const blocked = [];
  let g = guard;
  let lockedNow = null;
  if (!Number.isFinite(price) || price <= 0) return { paper: p, trades, events, blocked, guard: g, lockedNow };

  const units = () => n(p.core_units) + n(p.slice_units);
  const cash = () => n(d.slice_cash) + n(d.core_cash);
  const book = (at) => cash() + units() * at;

  /** Guarded fill: check → apply → record → lock check. */
  const fill = (kind, side, fillPrice, apply) => {
    if (g) {
      const chk = preTradeCheck(g, { kind, bookValueNow: book(price) });
      if (!chk.allowed) {
        blocked.push({ kind, decision: chk.decision, reason: chk.reason });
        return false;
      }
    }
    const u = apply();
    trades.push({ side, units: u, price: fillPrice, reason: `${KIND_COPY[kind]} at ${fillPrice} (price ${price})` });
    events.push(kind);
    if (g) {
      const r = afterFill(g, { fill: { kind, side, units: u, price: fillPrice }, bookValueAtFill: book(fillPrice), nowIso });
      g = r.guard;
      if (r.locked) lockedNow = r.reason;
    }
    return true;
  };

  const sell = n(plan?.sellLevel);
  const buy = n(plan?.buyBackLevel);
  const levelsOk = sell > 0 && buy > 0 && sell > buy;

  // Slice: sell into strength (once per cycle).
  if (levelsOk && !d.slice_sold && p.slice_units > 0 && price >= sell) {
    fill('sell_slice', 'sell', sell, () => {
      const u = p.slice_units;
      d.slice_cash = n(d.slice_cash) + u * sell;
      p.slice_units = 0;
      d.slice_sold = true;
      return u;
    });
  } else if (levelsOk && d.slice_sold && n(d.slice_cash) > 0 && price <= buy) {
    // Slice: buy back lower with the slice cash.
    fill('buy_back', 'buy', buy, () => {
      const u = n(d.slice_cash) / buy;
      p.slice_units = n(p.slice_units) + u;
      d.slice_cash = 0;
      d.slice_sold = false;
      d.cycles = n(d.cycles) + 1;
      return u;
    });
  }

  // Core: exit entirely at the effective stop, then stay in cash.
  if (!d.core_stopped && p.core_units > 0 && Number.isFinite(effectiveStop) && effectiveStop > 0 && price <= effectiveStop) {
    const at = price; // ≤ effectiveStop here
    fill('exit_core', 'sell', at, () => {
      const u = p.core_units;
      d.core_cash = n(d.core_cash) + u * at;
      p.core_units = 0;
      d.core_stopped = true;
      d.core_stopped_at = nowIso;
      return u;
    });
  }

  p.cash = cash();
  if (trades.length) p.last_action_at = nowIso;
  return { paper: p, trades, events, blocked, guard: g, lockedNow };
}

const KIND_COPY = { sell_slice: 'slice sell', buy_back: 'slice buy-back', exit_core: 'core stop' };

/** Current book value of a paper row at `price` (cash + holdings). */
export function paperBookValue(paper, price) {
  if (!paper || !Number.isFinite(price)) return null;
  return n(paper.cash) + (n(paper.core_units) + n(paper.slice_units)) * price;
}

/** Paper value vs buy-and-hold of the same notional since started_at. */
export function paperValues(paper, price) {
  if (!paper || !Number.isFinite(price)) return null;
  const units = n(paper.core_units) + n(paper.slice_units);
  const paperValue = units * price + n(paper.cash);
  const holdUnits = n(paper.data?.notional_units) || units;
  const holdValue = holdUnits * price;
  const startValue = holdUnits * n(paper.start_price);
  return {
    paperValue,
    holdValue,
    startValue,
    diff: paperValue - holdValue,
    diffPct: holdValue > 0 ? ((paperValue - holdValue) / holdValue) * 100 : null,
  };
}
