/**
 * Paper broker adapter: simulated stop orders held in memory (the runner loads / saves
 * them as stock_paper_orders rows). Implements the interface in ./index.js.
 * Fill realism: a triggered stop fills at the price the check saw, not at the stop level,
 * so a gap through the stop (e.g. at the open) fills worse than the stop.
 */
const clone = (o) => (o ? { ...o, data: { ...(o.data || {}) } } : o);

export function createPaperBroker({ orders = [], nowIso = new Date().toISOString() } = {}) {
  const book = new Map(orders.map((o) => [o.position_id, clone(o)]));
  const touched = new Set();
  const must = (id) => {
    const o = book.get(id);
    if (!o) throw new Error(`no paper order for position ${id}`);
    return o;
  };
  const save = (o) => {
    o.updated_at = nowIso;
    book.set(o.position_id, o);
    touched.add(o.position_id);
    return clone(o);
  };

  return {
    kind: 'paper',
    get: (id) => clone(book.get(id)),
    /** Internal: write a row the accounting layer changed (priors, last price, blocked). */
    put: (o) => save(clone(o)),
    orders: () => [...book.values()].map(clone),
    touched: () => [...touched].map((id) => clone(book.get(id))),

    async placeStop({ positionId, userId, symbol, positionSide, qty, stopPrice, entryPrice, anchor, data = {} }) {
      const prev = book.get(positionId);
      return save({
        ...(prev || {}),
        position_id: positionId,
        user_id: userId ?? prev?.user_id,
        symbol,
        position_side: positionSide,
        order_side: positionSide === 'long' ? 'sell' : 'buy',
        qty,
        entry_price: entryPrice,
        stop_price: stopPrice,
        status: 'working',
        anchor,
        broker: 'paper',
        broker_order_id: `paper-${positionId.slice(0, 8)}-${Date.parse(nowIso)}`,
        placed_at: nowIso,
        modified_at: null,
        filled_at: null,
        fill_price: null,
        realized_pnl: null,
        data: { ...(prev?.data || {}), ...data, gap: false, exit_note: null, blocked_reason: null },
      });
    },

    async modifyStop(positionId, { stopPrice }) {
      const o = must(positionId);
      if (o.status !== 'working') throw new Error('only a working order can be modified');
      return save({ ...o, stop_price: stopPrice, modified_at: nowIso });
    },

    async cancel(positionId, { reason = 'cancelled' } = {}) {
      const o = must(positionId);
      return save({ ...o, status: 'closed', data: { ...o.data, exit_note: reason } });
    },

    async getPositions() {
      return [...book.values()]
        .filter((o) => o.status === 'working')
        .map((o) => ({ positionId: o.position_id, symbol: o.symbol, side: o.position_side, qty: Number(o.qty), entryPrice: Number(o.entry_price), status: o.status, stopPrice: o.stop_price }));
    },

    async syncFills(positionId, { price, at = nowIso, open = null, firstCheckToday = false }) {
      const o = book.get(positionId);
      if (!o || o.status !== 'working' || !Number.isFinite(price)) return null;
      const long = o.position_side === 'long';
      const hit = long ? price <= o.stop_price : price >= o.stop_price;
      if (!hit) return null;
      const openBeyond = Number.isFinite(open) && (long ? open <= o.stop_price : open >= o.stop_price);
      const gap = Boolean(firstCheckToday && openBeyond);
      const qty = Number(o.qty);
      const entry = Number(o.entry_price);
      const pnl = (long ? price - entry : entry - price) * qty;
      save({ ...o, status: 'filled', filled_at: at, fill_price: price, realized_pnl: pnl, last_price: price, last_price_at: at, data: { ...o.data, gap } });
      return { positionId, symbol: o.symbol, side: o.order_side, units: qty, price, stopPrice: o.stop_price, pnl, gap, at };
    },
  };
}
