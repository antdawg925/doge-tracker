/**
 * Short borrow-cost ESTIMATE from Schwab's quote reference.htbRate (annualized %, Schwab reports HTB
 * rates as negative numbers — we use the absolute value). Not a statement figure: Schwab charges on
 * its own daily rate/price; this applies today's rate to each day held.
 *   daily = |htbRate| / 100 × (shares × price) / 360
 * ETB (isHardToBorrow false or htbRate 0) → $0/day.
 */
const DAY = 86400000;
const fin = (x) => Number.isFinite(x);

/** Calendar days held (US Eastern dates) from an open date ('YYYY-MM-DD', ISO or ms) to now. */
const etDate = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
export function daysHeld(openedAt, nowMs = Date.now()) {
  if (openedAt == null || openedAt === '') return null;
  const raw = String(openedAt);
  let open;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) open = raw;
  else {
    const t = typeof openedAt === 'number' ? openedAt : Date.parse(raw);
    if (!fin(t)) return null;
    open = etDate(t);
  }
  const d = Math.round((Date.parse(`${etDate(nowMs)}T00:00:00Z`) - Date.parse(`${open}T00:00:00Z`)) / DAY);
  return fin(d) ? Math.max(0, d) : null;
}

export function dailyBorrow({ htbRate, shares, price }) {
  if (!fin(Number(htbRate)) || !(shares > 0) || !(price > 0)) return null;
  return (Math.abs(Number(htbRate)) / 100) * (shares * price) / 360;
}

/**
 * @param borrow { htbRate, isHardToBorrow, status } from borrowFromQuote (null → unknown)
 * @param closes [{ t, close }] daily closes since open (optional) — each day's value; weekends use the prior close
 */
export function borrowEstimate({ borrow, shares, price, entryPrice, openedAt, closes = null, nowMs = Date.now() }) {
  const days = daysHeld(openedAt, nowMs);
  const pnl = entryPrice > 0 && price > 0 && shares > 0 ? (entryPrice - price) * shares : null;
  const known = borrow && (fin(Number(borrow.htbRate)) || borrow.isHardToBorrow === false);
  if (!known) return { known: false, days, pnl, daily: null, paid: null, net: null, rate: null, rawRate: null, method: null };
  const etb = borrow.isHardToBorrow === false && !(Math.abs(Number(borrow.htbRate) || 0) > 0);
  const rawRate = fin(Number(borrow.htbRate)) ? Number(borrow.htbRate) : 0;
  const rate = etb ? 0 : Math.abs(rawRate);
  const daily = rate === 0 ? 0 : dailyBorrow({ htbRate: rate, shares, price });
  let paid = null;
  let method = 'current';
  if (days != null) {
    if (rate === 0) paid = 0;
    else if (closes?.length) {
      const start = nowMs - days * DAY;
      const sorted = closes.filter((c) => fin(c?.t) && c.close > 0).sort((a, b) => a.t - b.t);
      let i = 0;
      let last = sorted.find((c) => c.t <= start)?.close ?? sorted[0]?.close ?? price;
      let sum = 0;
      for (let d = 0; d < days; d += 1) {
        const dayEnd = start + (d + 1) * DAY;
        while (i < sorted.length && sorted[i].t < dayEnd) last = sorted[i++].close;
        sum += (rate / 100) * (shares * last) / 360;
      }
      paid = sum;
      method = 'daily closes';
    } else paid = (daily ?? 0) * days;
  }
  const net = pnl != null && paid != null ? pnl - paid : null;
  return { known: true, etb: rate === 0, days, pnl, daily, paid, net, rate, rawRate, method };
}
