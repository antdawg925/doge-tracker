/**
 * Price-action coaching for Anthony's OWN DOGE buy orders at Kraken (pure; suggestions only:
 * the bot never edits or cancels his orders). Each message carries a stable key
 * `${txid}:${condition}` so the caller can rate-limit it (≈ one per order per condition per 4h).
 *
 * Conditions (4h candles, completed bars only):
 *  - approach   price within ~1.5% above a buy limit (with volume vs its 20-bar average)
 *  - too_high   likely too high: for a buy limit below price, price is falling into it on heavy
 *               red volume while the nearest swing-low support sits well below the order (may fill
 *               and keep dropping); for a buy above price (stop / breakout buy), price stalls or
 *               rejects just under it with upper wicks and fading volume
 *  - too_low    likely too low / missed: price came within ~1% and bounced, or ran > 3% above
 *               the order since it was placed without filling → retest / support level
 *  - under_entry a recent fill of his buy is now below its entry → distance to the stop
 */
const H4 = 4 * 3600000;
const fin = (v) => Number.isFinite(Number(v)) && v !== null && v !== '';
const p4 = (v) => `$${Number(v).toFixed(4)}`;
const pct = (v, d = 1) => `${v >= 0 ? '+' : ''}${Number(v).toFixed(d)}%`;
const q0 = (v) => Math.round(Number(v)).toLocaleString('en-US');

export function volumeContext(bars) {
  if (bars.length < 21) return null;
  const last = bars[bars.length - 1];
  const prev = bars.slice(-21, -1);
  const avg = prev.reduce((a, b) => a + (Number(b.volume) || 0), 0) / prev.length;
  if (!(avg > 0)) return null;
  const ratio = (Number(last.volume) || 0) / avg;
  const fading = bars.slice(-3).every((b) => (Number(b.volume) || 0) < avg * 0.8);
  return { ratio, avg, last: Number(last.volume) || 0, fading, red: last.close < last.open };
}

/** Swing highs / lows: a bar whose high (low) is the extreme of `k` bars on each side. */
export function swings(bars, k = 2, lookback = 90) {
  const b = bars.slice(-lookback);
  const highs = [];
  const lows = [];
  for (let i = k; i < b.length - k; i++) {
    const win = b.slice(i - k, i + k + 1);
    if (b[i].high >= Math.max(...win.map((x) => x.high))) highs.push(b[i].high);
    if (b[i].low <= Math.min(...win.map((x) => x.low))) lows.push(b[i].low);
  }
  return { highs, lows };
}

export function levelsAround(bars, price) {
  const { highs, lows } = swings(bars);
  const below = [...lows, ...highs].filter((v) => v < price).sort((a, b) => b - a);
  const above = [...highs, ...lows].filter((v) => v > price).sort((a, b) => a - b);
  return { support: below[0] ?? null, support2: below.find((v) => v < (below[0] ?? 0) * 0.99) ?? null, resistance: above[0] ?? null };
}

const volTxt = (v) => (v ? `vol ${v.ratio.toFixed(2)}× its 20-bar avg${v.fading ? ' (fading)' : ''}` : 'vol n/a');

/**
 * @param orders  [{ txid, price, vol, volExec, ordertype, firstSeen, minDistPct }]
 * @param fills   [{ txid, qty, price, at }] recent fills of his buys
 * @param market  { price, bars4h }
 * @returns { messages: [{ key, condition, txid, text }], minDist: { txid: pct } }
 */
export function coachBuyOrders({ orders = [], fills = [], market, stopPx = null, nowMs = Date.now() }) {
  const price = Number(market?.price);
  const bars = (market?.bars4h || []).filter((b) => b.t + H4 <= nowMs);
  const messages = [];
  const minDist = {};
  if (!(price > 0) || bars.length < 25) return { messages, minDist };
  const vol = volumeContext(bars);
  const lv = levelsAround(bars, price);
  const last3 = bars.slice(-3);
  const lvTxt = `support ${lv.support ? p4(lv.support) : '—'}, resistance ${lv.resistance ? p4(lv.resistance) : '—'}`;

  for (const o of orders) {
    const op = Number(o.price);
    if (!(op > 0)) continue;
    const remaining = Math.max(0, Number(o.vol) - Number(o.volExec || 0));
    const dist = (price / op - 1) * 100; // + = price above the order
    // closest approach since the order was first seen (4h lows; and the live price)
    const since = Date.parse(o.firstSeen || 0) || 0;
    let md = fin(o.minDistPct) ? Number(o.minDistPct) : dist;
    for (const b of bars) if (b.t + H4 > since) md = Math.min(md, (b.low / op - 1) * 100);
    md = Math.min(md, dist);
    minDist[o.txid] = md;
    const head = `Your DOGE buy ${q0(remaining)} @ ${p4(op)}: price ${p4(price)} (${pct(dist)} from it), ${volTxt(vol)}; ${lvTxt}.`;
    const isStopBuy = /stop|take-profit/i.test(o.ordertype || '') || op > price;

    if (!isStopBuy) {
      // ---- approaching (within 1.5% above)
      if (dist > 0 && dist <= 1.5) {
        messages.push({ key: `${o.txid}:approach`, condition: 'approach', txid: o.txid, text: `📍 ${head} Price is approaching your order${vol && vol.ratio > 1.3 && vol.red ? ' on heavy selling' : vol && vol.ratio < 0.8 ? ' on light volume' : ''}.` });
      }
      // ---- too high: falling into it on heavy red volume, support well below
      if (dist > 0 && dist <= 3 && vol && vol.red && vol.ratio >= 1.5 && lv.support && lv.support < op * 0.98) {
        const sup = [...swings(bars).lows].filter((v) => v < op).sort((a, b) => b - a)[0] ?? lv.support;
        messages.push({ key: `${o.txid}:too_high`, condition: 'too_high', txid: o.txid, text: `⚠️ ${head} Heavy red 4h volume into your order and the next swing-low support is ${p4(sup)} (${pct((sup / op - 1) * 100)} below it): it may fill and keep falling. Consider lowering toward ${p4(sup)}.` });
      }
      // ---- too low / missed: came close and bounced, or ran away > 3%
      const bounced = md <= 1 && dist >= 3;
      const ranAway = dist > 3 && md <= 1.5;
      if (bounced || ranAway) {
        const retest = lv.support && lv.support > op ? lv.support : null;
        messages.push({ key: `${o.txid}:too_low`, condition: 'too_low', txid: o.txid, text: `↗️ ${head} Price came within ${Math.max(0, md).toFixed(1)}% of your order and ran ${pct(dist)} without filling. ${retest ? `Nearest retest/support is ${p4(retest)} (${pct((retest / op - 1) * 100)} above your order): consider raising toward it if you still want in.` : 'No swing support between price and your order yet.'}` });
      }
    } else {
      // buy above price (stop / breakout buy): stalls or rejects just under the level
      const under = dist < 0 && dist >= -2;
      const wicks = last3.filter((b) => b.high >= op * 0.99 && b.close < op && b.high - Math.max(b.open, b.close) > Math.abs(b.close - b.open)).length;
      if (under && (wicks >= 1 || (vol && vol.fading))) {
        messages.push({ key: `${o.txid}:too_high`, condition: 'too_high', txid: o.txid, text: `⚠️ ${head} Price is stalling just under your buy level${wicks ? ` with ${wicks} upper-wick rejection${wicks > 1 ? 's' : ''} in the last 3 4h candles` : ''}${vol?.fading ? ' and volume fading' : ''}. It may be too high: consider lowering toward ${lv.resistance && lv.resistance < op ? p4(lv.resistance) : 'the last 4h high'}.` });
      }
      if (dist > 0 && dist <= 1.5) messages.push({ key: `${o.txid}:approach`, condition: 'approach', txid: o.txid, text: `📍 ${head} Price is just above your buy level.` });
    }
  }

  // ---- filled, then back under the entry
  for (const f of fills) {
    const fp = Number(f.price);
    if (!(fp > 0) || !(price < fp)) continue;
    const d = (price / fp - 1) * 100;
    const toStop = stopPx ? (price / Number(stopPx) - 1) * 100 : null;
    messages.push({
      key: `${f.txid}:under_entry`,
      condition: 'under_entry',
      txid: f.txid,
      text: `🔻 Your DOGE buy filled ${q0(f.qty)} @ ${p4(fp)} and price is back under it: ${p4(price)} (${pct(d)}). ${stopPx ? `Bottom stop ${p4(stopPx)} is ${toStop.toFixed(1)}% below the price.` : 'No bottom stop set.'} ${volTxt(vol)}; ${lvTxt}.`,
    });
  }
  return { messages, minDist };
}
