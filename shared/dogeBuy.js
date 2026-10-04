/**
 * Telegram "buy $X DOGE" (pure parts): Level-2 read, post-only limit sizing, re-peg decisions,
 * and the post-fill stop suggestion. I/O lives in api/_dogeBuy.js.
 */
import { KRAKEN_XDGUSD, floorTo, roundTo } from './dogeLive.js';
import { swings } from './buyCoach.js';

export const BUY_RULES = Object.freeze({ confirmMs: 2 * 60000, repegAfterMs: 3 * 60000, maxRepegs: 3, suggestTtlMs: 30 * 60000, wideSpreadPct: 0.3, wallPct: 0.3, wallX: 4, bandPct: 0.5 });

/** "buy $1000 doge", "/buy 1000", "buy 1k" → USD amount (null if none). */
export function parseBuy(text) {
  const t = String(text || '').trim().replace(/^\/(\w+)@\w+/, '/$1');
  const m = t.match(/^\/?buy\s+\$?\s*([\d,]*\.?\d+)\s*(k)?\b\s*(usd|dollars?|\$|doge|of doge|worth of doge)?\b/i);
  if (!m) return /^\/?buy\b/i.test(t) ? { usd: null } : null;
  const usd = Number(m[1].replace(/,/g, '')) * (m[2] ? 1000 : 1);
  return { usd: Number.isFinite(usd) && usd > 0 ? usd : null };
}

/** Kraken Depth result (one pair) → book stats. */
export function analyzeDepth(depth, { rules = KRAKEN_XDGUSD, bandPct = BUY_RULES.bandPct, wallPct = BUY_RULES.wallPct, wallX = BUY_RULES.wallX } = {}) {
  const lv = (rows) => (rows || []).map((r) => ({ price: Number(r[0]), qty: Number(r[1]) })).filter((r) => r.price > 0 && r.qty > 0);
  const bids = lv(depth?.bids).sort((a, b) => b.price - a.price);
  const asks = lv(depth?.asks).sort((a, b) => a.price - b.price);
  if (!bids.length || !asks.length) return null;
  const bid = bids[0].price;
  const ask = asks[0].price;
  const mid = (bid + ask) / 2;
  const spreadPct = ((ask - bid) / mid) * 100;
  const bidSize = bids.filter((b) => b.price >= mid * (1 - bandPct / 100)).reduce((a, b) => a + b.qty, 0);
  const askSize = asks.filter((a) => a.price <= mid * (1 + bandPct / 100)).reduce((a, b) => a + b.qty, 0);
  const med = (arr) => {
    const s = arr.map((x) => x.qty).sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : 0;
  };
  const askMed = med(asks.slice(0, 30));
  const bidMed = med(bids.slice(0, 30));
  const askWall = asks.filter((a) => a.price <= ask * (1 + wallPct / 100) && a.qty >= askMed * wallX).sort((a, b) => b.qty - a.qty)[0] || null;
  const bidWalls = bids.filter((b) => b.price >= bid * 0.97 && b.qty >= bidMed * wallX).sort((a, b) => b.qty - a.qty);
  const tick = 1 / 10 ** rules.priceDecimals;
  return { bid, ask, mid, spreadPct, bidSize, askSize, askWall, bidWall: bidWalls[0] || null, tick, bids, asks };
}

/** Post-only buy price: bid + 1 tick if still below the ask, else the bid. */
export function postOnlyPrice(book, rules = KRAKEN_XDGUSD) {
  const up = roundTo(book.bid + book.tick, rules.priceDecimals);
  return up < book.ask - 1e-12 ? up : roundTo(book.bid, rules.priceDecimals);
}

/** The buy plan for $usd (or why not). */
export function planBuy({ usd, book, usdAvailable = null, rules = KRAKEN_XDGUSD, feePct = 0.4 }) {
  if (!book) return { ok: false, error: 'Order book unavailable' };
  const price = postOnlyPrice(book, rules);
  const qty = floorTo(usd / price, rules.volumeDecimals);
  const notes = [];
  if (book.spreadPct >= BUY_RULES.wideSpreadPct) notes.push(`Spread is wide: ${book.spreadPct.toFixed(2)}%`);
  if (book.askWall) notes.push(`Ask wall ${Math.round(book.askWall.qty).toLocaleString('en-US')} DOGE at $${book.askWall.price.toFixed(5)} (${(((book.askWall.price / book.ask) - 1) * 100).toFixed(2)}% above the ask)`);
  if (qty < rules.orderMin) return { ok: false, error: `$${usd} buys ${qty.toFixed(2)} DOGE, under Kraken's ${rules.orderMin} DOGE minimum`, price, qty };
  const cost = qty * price * (1 + feePct / 100);
  if (usdAvailable != null && cost > usdAvailable + 1e-9) return { ok: false, error: `Not enough USD: need ~$${cost.toFixed(2)} incl. fee, available $${usdAvailable.toFixed(2)}`, price, qty, notes };
  return { ok: true, price, qty, cost, notes };
}

export function buyPlanText(plan, book, { usd, dry }) {
  const q = Math.round(plan.qty).toLocaleString('en-US');
  return [
    `${dry ? '(dry-run) ' : ''}Buy $${usd.toLocaleString('en-US')} of DOGE: post-only limit ${q} DOGE @ $${plan.price.toFixed(7)}`,
    `Book: bid $${book.bid.toFixed(7)} / ask $${book.ask.toFixed(7)}, spread ${book.spreadPct.toFixed(2)}%; within ±0.5%: bids ${Math.round(book.bidSize).toLocaleString('en-US')} / asks ${Math.round(book.askSize).toLocaleString('en-US')} DOGE`,
    ...plan.notes.map((n) => `⚠️ ${n}`),
    `Unfilled after 3 min → re-peg to the best bid (up to 3×), then it rests. Fills are covered by your bottom stop at once.`,
    dry ? 'Dry-run: reply "yes" to see what would happen (nothing is placed).' : 'Reply "yes" within 2 min to place it, or /cancel.',
  ].join('\n');
}

/** Re-peg decision for a resting bot buy. */
export function repegDecision({ req, book, nowMs, rules = KRAKEN_XDGUSD }) {
  if (!book) return { action: 'none' };
  const last = Date.parse(req.last_peg_at || req.placed_at || 0);
  if (req.repegs >= BUY_RULES.maxRepegs) return { action: 'rest' };
  if (nowMs - last < BUY_RULES.repegAfterMs) return { action: 'wait' };
  const px = postOnlyPrice(book, rules);
  if (Math.abs(px - Number(req.price)) < 1e-12) return { action: 'wait', price: px, same: true };
  return { action: 'repeg', price: px };
}

/** Wilder ATR on hourly bars (completed). */
function atrOf(bars, n = 14) {
  let a = null;
  bars.forEach((b, i) => {
    const pc = i ? bars[i - 1].close : null;
    const tr = pc == null ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
    a = a == null ? tr : a + (tr - a) / n;
  });
  return a;
}

/**
 * Post-fill stop suggestion: under the nearest 4h swing low, ≥ 1.5× hourly ATR under the fill,
 * and under the biggest bid wall within 3% — minus a small buffer (¼ hourly ATR).
 */
export function suggestStop({ fill, qty, bars4h, bars1h, book, currentStop = null, rules = KRAKEN_XDGUSD }) {
  const atr1h = bars1h?.length > 15 ? atrOf(bars1h.slice(-100), 14) : null;
  if (!(fill > 0) || !atr1h) return null;
  const lows = swings(bars4h || [], 2, 90).lows.filter((v) => v < fill).sort((a, b) => b - a);
  const swing = lows[0] ?? null;
  const wall = book?.bidWall && book.bidWall.price < fill ? book.bidWall : null;
  const atrLvl = fill - 1.5 * atr1h;
  const cands = [atrLvl, swing, wall?.price].filter((v) => v != null && v > 0);
  const raw = Math.min(...cands) - 0.25 * atr1h;
  const price = floorTo(raw, 4);
  const why = [
    swing ? `below the 4h swing low $${swing.toFixed(4)}` : null,
    `${(((fill - price) / atr1h)).toFixed(1)}× hourly ATR ($${atr1h.toFixed(5)}) under your fill`,
    wall ? `under a bid wall of ${(wall.qty / 1e6 >= 1 ? `${(wall.qty / 1e6).toFixed(1)}M` : Math.round(wall.qty).toLocaleString('en-US'))} DOGE at $${wall.price.toFixed(4)}` : null,
  ].filter(Boolean);
  const riskUsd = (fill - price) * qty;
  const riskPct = ((fill - price) / fill) * 100;
  const keep = currentStop != null && price <= currentStop + 1e-12;
  return { price, swing, wall, atr1h, riskUsd, riskPct, keep, why };
}

export function suggestText(s, { fill, currentStop }) {
  const base = `Suggested stop $${s.price.toFixed(4)}: ${s.why.join(', ')}. Risk from your fill $${fill.toFixed(4)}: $${s.riskUsd.toFixed(2)} (${s.riskPct.toFixed(1)}%).`;
  if (s.keep) return `${base}\nYour current stop $${Number(currentStop).toFixed(4)} is already tighter, so it stays (the stop never lowers).`;
  return `${base}\nReply 'yes' to set it or /stop 0.0xx for your own.`;
}
