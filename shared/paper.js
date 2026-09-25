/**
 * Watch-only paper trading (pure). Simulates the plan on a notional position:
 *   core  (corePct %)  — held until price touches the effective stop, then exits
 *                        entirely and stays in cash ('core stopped out').
 *   slice (slicePct %) — sells at sellLevel, buys back at buyBackLevel with the
 *                        slice cash; one sell per cycle (sell → buy back → sell …).
 * Fills assume the level price (sell / buy-back / stop), checked at each 5-min run.
 * Nothing here places an order.
 */

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
 * One check at `price`. Returns { paper, trades, events } — `paper` is a new object.
 * events ⊆ ['exit_core', 'sell_slice', 'buy_back'].
 */
export function stepPaper(paper, { plan, price, effectiveStop, nowIso }) {
  const p = { ...paper, data: { ...(paper.data || {}) } };
  const d = p.data;
  const trades = [];
  const events = [];
  if (!Number.isFinite(price) || price <= 0) return { paper: p, trades, events };

  const sell = n(plan?.sellLevel);
  const buy = n(plan?.buyBackLevel);
  const levelsOk = sell > 0 && buy > 0 && sell > buy;

  // Slice: sell into strength (once per cycle).
  if (levelsOk && !d.slice_sold && p.slice_units > 0 && price >= sell) {
    const units = p.slice_units;
    d.slice_cash = n(d.slice_cash) + units * sell;
    p.slice_units = 0;
    d.slice_sold = true;
    trades.push({ side: 'sell', units, price: sell, reason: `slice sell at ${sell} (price ${price})` });
    events.push('sell_slice');
  } else if (levelsOk && d.slice_sold && n(d.slice_cash) > 0 && price <= buy) {
    // Slice: buy back lower with the slice cash.
    const units = n(d.slice_cash) / buy;
    p.slice_units = n(p.slice_units) + units;
    d.slice_cash = 0;
    d.slice_sold = false;
    d.cycles = n(d.cycles) + 1;
    trades.push({ side: 'buy', units, price: buy, reason: `slice buy-back at ${buy} (price ${price})` });
    events.push('buy_back');
  }

  // Core: exit entirely at the effective stop, then stay in cash.
  if (!d.core_stopped && p.core_units > 0 && Number.isFinite(effectiveStop) && effectiveStop > 0 && price <= effectiveStop) {
    const units = p.core_units;
    d.core_cash = n(d.core_cash) + units * effectiveStop;
    p.core_units = 0;
    d.core_stopped = true;
    d.core_stopped_at = nowIso;
    trades.push({ side: 'sell', units, price: effectiveStop, reason: `core stop at ${effectiveStop} (price ${price})` });
    events.push('exit_core');
  }

  p.cash = n(d.slice_cash) + n(d.core_cash);
  if (trades.length) p.last_action_at = nowIso;
  return { paper: p, trades, events };
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
