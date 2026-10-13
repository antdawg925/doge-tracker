// Dip-buy plan + Schwab LIMIT BUY payload (validation only, no network).
import assert from 'node:assert/strict';
import { buildDipPlan, buildLimitBuyOrder, dollarRisk, nextRatchetStop, sharesForAmount, shouldCancelPending, DIP_EXCLUDES } from '../shared/dipBuys.js';
import { buildLimitBuyOrder as schwabBuy, buildShortLimitOrder as schwabShort, buildStopOrder, borrowFromQuote, isNotShortableError } from '../shared/schwabLive.js';
import { buildShortPlan, buildShortLimitOrder, nextShortRatchetStop, sharesForRisk, shortDollarRisk, squeezeRisk, weinsteinStage, SHORT_RISK_USD } from '../shared/sellHighs.js';

const t0 = Date.UTC(2020, 0, 6);
const bars = [];
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.03;
const path = [];
for (let c = 0; c < 14; c += 1) {
  const lo = c % 3 === 0 ? 80 : 100;
  const hi = c % 4 === 0 ? 160 : 130;
  for (let i = 0; i < 13; i += 1) path.push(lo + (hi - lo) * Math.sin((Math.PI * i) / 12));
}
path.push(108, 110, 112);
path.forEach((p, i) => {
  const o = p * (1 + rnd());
  const cl = p * (1 + rnd());
  bars.push({ t: t0 + i * 7 * 86400000, open: o, close: cl, high: Math.max(o, cl) * 1.02, low: Math.min(o, cl) * 0.98 });
});

let n = 0;
const ok = (name, cond, extra = '') => {
  n += 1;
  if (!cond) {
    console.error(`FAIL ${name}`, extra);
    process.exit(1);
  }
};

ok('TSLA excluded', DIP_EXCLUDES.has('TSLA') && buildDipPlan('TSLA', bars, 200) === null);
const plan = buildDipPlan('NVDA', bars, 112, { stage: 2, dailyCloses: path });
ok('plan built', plan && plan.limit < 112 && plan.stop < plan.limit && plan.t1 > plan.limit, JSON.stringify(plan));
ok('RR > 0', plan.rr > 0);
ok('stage 6 rejected', buildDipPlan('NVDA', bars, 112, { stage: 6 }) === null);
ok('shares floor', sharesForAmount(1000, plan.limit) === Math.floor(1000 / plan.limit));
ok('dollar risk', Math.abs(dollarRisk(10, plan.limit, plan.stop) - (plan.limit - plan.stop) * 10) < 0.02);

const payload = buildLimitBuyOrder({ symbol: 'nvda', qty: 5, limitPrice: plan.limit });
ok('LIMIT BUY payload', payload.orderType === 'LIMIT' && payload.session === 'NORMAL' && payload.duration === 'GOOD_TILL_CANCEL');
ok('BUY instruction', payload.orderLegCollection[0].instruction === 'BUY' && payload.orderLegCollection[0].quantity === 5);
ok('same as schwabLive', JSON.stringify(payload) === JSON.stringify(schwabBuy({ symbol: 'NVDA', qty: 5, limitPrice: plan.limit })));
ok('rejects TSLA order', (() => { try { buildLimitBuyOrder({ symbol: 'TSLA', qty: 1, limitPrice: 100 }); return false; } catch { return true; } })());
ok('rejects fractional', (() => { try { buildLimitBuyOrder({ symbol: 'NVDA', qty: 1.5, limitPrice: 100 }); return false; } catch { return true; } })());

const ladder = [{ trigger: 120, stop: 110 }, { trigger: 140, stop: 130 }];
ok('ratchet up', nextRatchetStop(100, 121, ladder)?.stop === 110);
ok('never lower', nextRatchetStop(115, 121, ladder) === null);
ok('cancel after days', shouldCancelPending({ created_at: new Date(Date.now() - 11 * 86400000).toISOString(), stop: 90 }, { spot: 100 }).cancel);
ok('cancel under stop', shouldCancelPending({ created_at: new Date().toISOString(), stop: 100 }, { spot: 99 }).cancel);

// ---------------- Sell highs (shorts): payload validation only, no network, NO orders.
const sbars = [];
let s2 = 11;
const rnd2 = () => ((s2 = (s2 * 16807) % 2147483647) / 2147483647 - 0.5) * 0.02;
const spath = [];
for (let i = 0; i < 160; i += 1) spath.push(200 * Math.exp(-i / 140) * (1 + 0.12 * Math.sin(i / 4)));
spath.forEach((p, i) => {
  const o = p * (1 + rnd2());
  const cl = p * (1 + rnd2());
  sbars.push({ t: t0 + i * 7 * 86400000, open: o, close: cl, high: Math.max(o, cl) * 1.02, low: Math.min(o, cl) * 0.98 });
});
const sspot = sbars.at(-1).close;
const sdaily = [];
for (let i = 0; i < 250; i += 1) sdaily.push(sspot * 1.4 * Math.exp(-i / 300));
sdaily.push(...[0.97, 0.95, 0.94, 0.96, 0.98, 1.0].map((x) => sdaily.at(-1) * x));
ok('weinstein stage 4', weinsteinStage(sbars.map((b) => b.close)) === 4);
ok('TSLA short excluded', buildShortPlan('TSLA', sbars, sspot, { dailyCloses: sdaily }) === null);
const sp = buildShortPlan('XYZ', sbars, sspot, { dailyCloses: sdaily, siPct: 22, dtc: 6 });
ok('short plan built', sp && sp.side === 'short' && sp.limit > sspot && sp.stop > sp.limit && sp.t1 < sspot, JSON.stringify(sp));
ok('limit at/below resistance', sp.limit <= sp.resistance);
ok('stop = resistance + weekly ATR', Math.abs(sp.stop - (sp.resistance + sp.atrW)) < 0.011 && sp.stop <= sp.resistance + sp.atrW);
ok('short R:R', Math.abs(sp.rr - (sp.limit - sp.t1) / (sp.stop - sp.limit)) < 0.01);
ok('uptrend name rejected', buildShortPlan('NVDA', bars, 112, { dailyCloses: path.map((x, i) => x + i) }) === null);
ok('squeeze flagged', sp.squeeze.flag && squeezeRisk(5, 2).flag === false && squeezeRisk(30, 6).level === 'extreme');
ok('squeeze needs both', squeezeRisk(40, 1).flag === false && squeezeRisk(10, 9).flag === false);
ok('$100 default risk', SHORT_RISK_USD === 100);
const sh = sharesForRisk(100, sp.limit, sp.stop);
ok('risk sizing', sh === Math.floor(100 / (sp.stop - sp.limit)) && shortDollarRisk(sh, sp.limit, sp.stop) <= 100);
ok('risk sizing other $', sharesForRisk(250, 50, 52.5) === 100 && sharesForRisk(100, 50, 50) === 0);

const sx = buildShortLimitOrder({ symbol: 'xyz', qty: sh, limitPrice: sp.limit });
ok('SELL_SHORT payload', sx.orderType === 'LIMIT' && sx.session === 'NORMAL' && sx.duration === 'GOOD_TILL_CANCEL' && sx.orderStrategyType === 'SINGLE');
ok('SELL_SHORT leg', sx.orderLegCollection.length === 1 && sx.orderLegCollection[0].instruction === 'SELL_SHORT' && sx.orderLegCollection[0].quantity === sh && sx.orderLegCollection[0].instrument.symbol === 'XYZ' && sx.orderLegCollection[0].instrument.assetType === 'EQUITY');
ok('SELL_SHORT price string', sx.price === sp.limit.toFixed(2));
ok('short limit rounds down', buildShortLimitOrder({ symbol: 'XYZ', qty: 1, limitPrice: 10.019 }).price === '10.01');
ok('same as schwabLive', JSON.stringify(sx) === JSON.stringify(schwabShort({ symbol: 'XYZ', qty: sh, limitPrice: sp.limit })));
ok('short rejects TSLA', (() => { try { buildShortLimitOrder({ symbol: 'TSLA', qty: 1, limitPrice: 100 }); return false; } catch { return true; } })());
ok('short rejects fractional', (() => { try { buildShortLimitOrder({ symbol: 'XYZ', qty: 2.5, limitPrice: 100 }); return false; } catch { return true; } })());
const cover = buildStopOrder({ symbol: 'XYZ', side: 'short', qty: sh, stopPrice: sp.stop });
ok('BUY_TO_COVER stop', cover.orderType === 'STOP' && cover.orderLegCollection[0].instruction === 'BUY_TO_COVER' && cover.stopPrice === sp.stop.toFixed(2) && cover.duration === 'GOOD_TILL_CANCEL');

const dl = [{ trigger: 60, stop: 64 }, { trigger: 50, stop: 54 }];
ok('short ratchet down', nextShortRatchetStop(76, 59, dl)?.stop === 64);
ok('short ratchet deepest rung', nextShortRatchetStop(76, 49, dl)?.stop === 54);
ok('short ratchet never raises', nextShortRatchetStop(60, 49.5, [{ trigger: 50, stop: 62 }]) === null);
ok('short no move above rung', nextShortRatchetStop(76, 61, dl) === null);
ok('short cancel above stop', shouldCancelPending({ side: 'short', created_at: new Date().toISOString(), stop_price: 76 }, { spot: 77 }).cancel);
ok('short no cancel below stop', !shouldCancelPending({ side: 'short', created_at: new Date().toISOString(), stop_price: 76 }, { spot: 70 }).cancel);
ok('short cancel after 10 days', shouldCancelPending({ side: 'short', created_at: new Date(Date.now() - 11 * 86400000).toISOString(), stop_price: 76 }, { spot: 70 }).reason.includes('10 days'));
ok('long cancel reads stop_price', shouldCancelPending({ created_at: new Date().toISOString(), stop_price: 100 }, { spot: 99 }).cancel);

const b1 = borrowFromQuote({ reference: { isShortable: true, isHardToBorrow: true, htbRate: 12.5, htbQuantity: 4000 } });
ok('borrow HTB', b1.status === 'HTB' && b1.htbRate === 12.5 && b1.htbQuantity === 4000);
ok('borrow ETB', borrowFromQuote({ reference: { isShortable: true, isHardToBorrow: false } }).status === 'ETB');
ok('borrow not shortable', borrowFromQuote({ reference: { isShortable: false, isHardToBorrow: true } }).status === 'NOT_SHORTABLE');
ok('borrow absent stays null', (() => { const b = borrowFromQuote({ quote: { lastPrice: 1 } }); return b.status === null && b.htbRate === null && b.isShortable === null; })());
ok('not-shortable error text', isNotShortableError('Order rejected: security is not shortable') && isNotShortableError('No shares available to borrow') && !isNotShortableError('insufficient buying power'));

console.log(`check:dip-buys OK (${n} checks; NVDA limit ${plan.limit} stop ${plan.stop} t1 ${plan.t1} rr ${plan.rr}; short XYZ ${sp.limit}/${sp.stop}/${sp.t1} rr ${sp.rr})`);

// ---------------- stock_plans runner, side='short', DRY-RUN with a fake Supabase (no Schwab, no orders).
{
  const { runStockPlans } = await import('../api/_stockPlans.js');
  const fakeSb = (tables) => {
    const writes = [];
    const from = (t) => {
      const st = { filters: [], op: 'select', payload: null };
      const rows = () => (tables[t] || []).filter((r) => st.filters.every(([k, v, kind]) => (kind === 'in' ? v.includes(r[k]) : r[k] === v)));
      const api = {
        select() { return api; },
        eq(k, v) { st.filters.push([k, v, 'eq']); return api; },
        in(k, v) { st.filters.push([k, v, 'in']); return api; },
        maybeSingle() { return Promise.resolve({ data: rows()[0] ?? null, error: null }); },
        update(p) { st.op = 'update'; st.payload = p; return api; },
        insert(p) { writes.push({ t, op: 'insert', payload: p }); return Promise.resolve({ data: null, error: null }); },
        then(res, rej) {
          if (st.op === 'update') {
            for (const r of rows()) Object.assign(r, st.payload);
            writes.push({ t, op: 'update', payload: st.payload });
            return Promise.resolve({ data: null, error: null }).then(res, rej);
          }
          return Promise.resolve({ data: rows(), error: null }).then(res, rej);
        },
      };
      return api;
    };
    return { from, writes };
  };
  const plan = { id: 'p1', user_id: 'u1', symbol: 'XYZ', side: 'short', shares: 28, limit_price: 73.08, stop_price: 76.62, t1_price: 60.81, status: 'pending', dry_run: true, cancel_days: 10, created_at: new Date().toISOString(), ladder: [{ trigger: 60.81, stop: 63.98 }], data: {} };
  const sb = fakeSb({ stock_plans: [plan], broker_connections: [], profiles: [] });
  const out = await runStockPlans(sb, { profiles: [{ id: 'u1', telegram_chat_id: null, stocks_live: true }], markets: new Map([['XYZ', { price: 71 }]]), force: true });
  ok('runner short dry-run', out.dry === 1 && out.placed === 0, JSON.stringify(out));
  ok('runner logs SELL_SHORT payload', plan.data.lastDry?.action === 'place_limit_sell_short' && plan.data.lastDry.payload.orderLegCollection[0].instruction === 'SELL_SHORT');
  const al = sb.writes.find((w) => w.t === 'stock_alert_log');
  ok('Sell highs alert text', al && al.payload.title.startsWith('Sell highs · XYZ: DRY-RUN short') && /SELL SHORT 28 sh/.test(al.payload.message) && al.payload.symbol === 'XYZ', JSON.stringify(al?.payload));

  const plan2 = { ...plan, id: 'p2', data: {}, status: 'pending' };
  const sb2 = fakeSb({ stock_plans: [plan2], broker_connections: [], profiles: [] });
  const out2 = await runStockPlans(sb2, { profiles: [{ id: 'u1', telegram_chat_id: null, stocks_live: false }], markets: new Map([['XYZ', { price: 77.1 }]]), force: true });
  ok('runner short cancels above stop', out2.cancelled === 1 && plan2.status === 'cancelled' && plan2.last_error === 'price above stop before fill');

  const CLOSE = Date.UTC(2026, 9, 13, 20, 20); // Tue 4:20 PM ET = after-close pass
  const RTH = Date.UTC(2026, 9, 14, 14, 0); // Wed 10:00 AM ET
  const plan3 = { ...plan, id: 'p3', status: 'filled', filled_shares: 28, last_stop_price: 76.62, data: {} };
  const sb3 = fakeSb({ stock_plans: [plan3], broker_connections: [], profiles: [] });
  await runStockPlans(sb3, { profiles: [{ id: 'u1', telegram_chat_id: null, stocks_live: false }], markets: new Map([['XYZ', { price: 60, bars: [{ date: '2026-10-13', close: 60, high: 61, low: 59, open: 60 }] }]]), force: true, nowMs: CLOSE });
  ok('B9 manual refresh never ratchets', plan3.last_stop_price === 76.62);
  await runStockPlans(sb3, { profiles: [{ id: 'u1', telegram_chat_id: null, stocks_live: false }], markets: new Map([['XYZ', { price: 60, bars: [{ date: '2026-10-13', close: 60, high: 61, low: 59, open: 60 }] }]]), nowMs: CLOSE });
  ok('runner short ratchets down on close pass', plan3.last_stop_price === 63.98 && plan3.data.lastRatchet?.action === 'lower_stop');

  // ---- live paths with a FAKE broker (no network, no Schwab).
  const fakeBroker = (orders, holdings) => {
    const calls = [];
    return {
      calls,
      getOrder: async (id) => orders[id] ?? null,
      getPositions: async () => holdings,
      placeStop: async (a) => { calls.push(['placeStop', a]); return { orderId: 'S' + calls.length }; },
      modifyStop: async (id, a) => { calls.push(['modifyStop', id, a]); return { orderId: 'M' + calls.length }; },
      cancel: async (id) => { calls.push(['cancel', id]); if (orders[id]) orders[id].status = 'CANCELED'; return {}; },
      placeLimitBuy: async (a) => { calls.push(['placeLimitBuy', a]); return { orderId: 'B1' }; },
      placeShortSell: async (a) => { calls.push(['placeShortSell', a]); return { orderId: 'B1' }; },
    };
  };
  const conn = { user_id: 'u1', broker: 'schwab', status: 'connected', live_enabled: true, kill_switch: false, account_hash: 'h', data: {} };
  const prof = [{ id: 'u1', telegram_chat_id: null, stocks_live: true }];
  const long = { id: 'L', user_id: 'u1', symbol: 'ABC', side: 'long', shares: 100, limit_price: 50, stop_price: 45, t1_price: 60, cancel_days: 10, dry_run: false, created_at: new Date(RTH - 86400000).toISOString(), ladder: [], data: {} };
  const run = async (row, broker, { nowMs = RTH, price = 50, c = { ...conn, data: { ...conn.data } }, guards = [] } = {}) => {
    const sbx = fakeSb({ stock_plans: [row], broker_connections: [c], stock_guard: guards });
    const out = await runStockPlans(sbx, { profiles: prof, markets: new Map([['ABC', { price }]]), nowMs, _broker: broker });
    return { out, sbx };
  };
  // B3: price below stop but the order already FILLED → protect, don't cancel.
  { const row = { ...long, status: 'working', buy_order_id: 'O1' }; const br = fakeBroker({ O1: { status: 'FILLED', filledQuantity: 100, orderActivityCollection: [{ executionLegs: [{ quantity: 100, price: 49.5 }] }] } }, []);
    await run(row, br, { price: 44 });
    ok('B3 fill wins over cancel', row.status === 'filled' && row.filled_shares === 100 && br.calls.some((c) => c[0] === 'placeStop' && c[1].qty === 100) && !br.calls.some((c) => c[0] === 'cancel')); }
  // B4: cancel rule hits an open order → cancelled at Schwab first.
  { const row = { ...long, status: 'working', buy_order_id: 'O2' }; const br = fakeBroker({ O2: { status: 'WORKING', filledQuantity: 0 } }, []);
    await run(row, br, { price: 44 });
    ok('B4 cancels at Schwab before marking', row.status === 'cancelled' && br.calls[0]?.[0] === 'cancel'); }
  // B4: open order but Live off → NOT marked cancelled.
  { const row = { ...long, status: 'working', buy_order_id: 'O3' }; const br = fakeBroker({ O3: { status: 'WORKING', filledQuantity: 0 } }, []);
    await run(row, br, { price: 44, c: { ...conn, live_enabled: false } });
    ok('B4 live off keeps plan open + error', row.status === 'working' && /still open at Schwab/.test(row.last_error) && !br.calls.length); }
  // B5: partial fill → stop for the filled shares; plan keeps working.
  { const row = { ...long, status: 'working', buy_order_id: 'O4' }; const br = fakeBroker({ O4: { status: 'WORKING', filledQuantity: 40 } }, []);
    await run(row, br);
    ok('B5 partial fill protected', row.status === 'working' && row.filled_shares === 40 && row.stop_order_id && br.calls[0][0] === 'placeStop' && br.calls[0][1].qty === 40);
    br.calls.length = 0; (await br.getOrder('O4')).filledQuantity = 70;
    await run(row, br);
    ok('B5 stop grows with fills', row.filled_shares === 70 && br.calls[0]?.[0] === 'modifyStop' && br.calls[0][2].qty === 70); }
  // B1/B2: plan stop above the Schwab stop → modified in RTH; not outside RTH.
  { const row = { ...long, status: 'filled', filled_shares: 100, filled_price: 50, stop_order_id: 'S9', last_stop_price: 47, data: {} };
    const br = fakeBroker({ S9: { status: 'WORKING', orderType: 'STOP', stopPrice: 45, quantity: 100 } }, [{ symbol: 'ABC', longQty: 100, shortQty: 0 }]);
    await run(row, br, { nowMs: CLOSE + 3600000 });
    ok('B1 no Schwab change outside RTH', br.calls.length === 0);
    await run(row, br, { price: 52 });
    ok('B1/B2 Schwab stop raised in RTH', br.calls[0]?.[0] === 'modifyStop' && br.calls[0][2].stopPrice === 47 && row.data.schwabStop === 47);
    br.calls.length = 0; (await br.getOrder('S9')).stopPrice = 48;
    row.stop_order_id = 'S9';
    await run(row, br, { price: 52 });
    ok('never loosens a tighter Schwab stop', br.calls.length === 0); }
  // B8: sold 30% at Schwab → stop shrinks; position gone → no re-place.
  { const row = { ...long, status: 'filled', filled_shares: 100, filled_price: 50, stop_order_id: 'S8', last_stop_price: 45, data: {} };
    const br = fakeBroker({ S8: { status: 'WORKING', stopPrice: 45, quantity: 100 } }, [{ symbol: 'ABC', longQty: 70, shortQty: 0 }]);
    await run(row, br);
    ok('B8 stop resized to shares held', br.calls[0]?.[0] === 'modifyStop' && br.calls[0][2].qty === 70 && br.calls[0][2].stopPrice === 45);
    const row2 = { ...row, id: 'L2', stop_order_id: 'S7', data: {} }; const br2 = fakeBroker({ S7: { status: 'CANCELED', stopPrice: 45, quantity: 100 } }, []);
    await run(row2, br2);
    ok('B8 no re-place when not held', br2.calls.length === 0 && /Not found at Schwab/.test(row2.last_error)); }
  // B6: kill switch / daily cap / Stocks pause block new entries.
  { const row = { ...long, status: 'pending' }; const br = fakeBroker({}, []);
    await run(row, br, { c: { ...conn, data: { actions: { day: '2026-10-14', n: 20 } } } });
    ok('B6 daily cap blocks entry', row.status === 'pending' && !br.calls.length && /Daily cap/.test(row.last_error));
    const row2 = { ...long, id: 'L3', status: 'pending' };
    await run(row2, br, { guards: [{ user_id: 'u1', book: 'stocks', paused: true }] });
    ok('B6 Stocks pause blocks entry', row2.status === 'pending' && !br.calls.length && /paused/.test(row2.last_error));
    const row3 = { ...long, id: 'L4', status: 'pending' };
    const { sbx } = await run(row3, br, { c: { ...conn, data: {} } });
    ok('entry placed + action counted', row3.status === 'working' && br.calls[0][0] === 'placeLimitBuy' && sbx.writes.some((w) => w.t === 'broker_connections' && w.payload.data?.actions?.n === 1)); }
  // B10: paper plan simulates fill then stop.
  { const row = { ...long, id: 'P', dry_run: true, status: 'pending', created_at: '2026-10-12T15:00:00Z' };
    const bars = [{ date: '2026-10-12', open: 52, high: 53, low: 51, close: 52 }, { date: '2026-10-13', open: 51, high: 51, low: 49.8, close: 50 }];
    const sbx = fakeSb({ stock_plans: [row], broker_connections: [], stock_guard: [] });
    await runStockPlans(sbx, { profiles: prof, markets: new Map([['ABC', { price: 50, bars }]]), nowMs: RTH });
    ok('B10 paper fill simulated', row.status === 'filled' && row.filled_price === 50 && row.data.simulated);
    row.filled_at = '2026-10-13T15:00:00Z';
    bars.push({ date: '2026-10-14', open: 44, high: 46, low: 43, close: 44 });
    await runStockPlans(sbx, { profiles: prof, markets: new Map([['ABC', { price: 44, bars }]]), nowMs: RTH });
    ok('B10 paper stop simulated at gap open', row.status === 'stopped' && row.data.simExit.price === 44 && row.data.simExit.pnl === -600); }
  console.log(`check:dip-buys runner OK (${n} checks total; dry-run only)`);
}

// ---------------- setup preview chart lines (pure)
{
  const { setupLines } = await import('../src/lib/setupLines.js');
  const L = setupLines({ side: 'short', plan: { resistance: 73.4, resistances: [73.4, 88.6], supports: [60.8, 50] }, entry: 73.08, stop: 76.62, target: 60.8 });
  const by = (lab) => L.find((l) => l.label === lab);
  ok('preview: driver highlighted', by('R1 resistance')?.price === 73.4 && by('R1 resistance').width === 2);
  ok('preview: entry blue dashed', by('Short')?.color === '#3d9cf0' && by('Short').style === 'dashed');
  ok('preview: stop red, cover green', by('Stop')?.color === '#f07178' && by('Cover')?.color === '#3ecf8e');
  ok('preview: other levels muted, no dupes', by('R2')?.muted && by('S2')?.muted && !by('S1') && L.filter((l) => l.price === 73.4).length === 1);
  const LL = setupLines({ side: 'long', plan: { support: 97.9, supports: [97.9, 80], resistances: [133.9] }, entry: 98.35, stop: 90.15, target: 133.9 });
  ok('preview: long labels', LL.some((l) => l.label === 'S1 support') && LL.some((l) => l.label === 'Buy') && LL.some((l) => l.label === 'T1'));
  console.log(`check:dip-buys preview OK (${n} checks total)`);
}

// ---------------- short borrow-cost estimate (pure)
{
  const { borrowEstimate, dailyBorrow, daysHeld } = await import('../shared/borrowCost.js');
  const now = Date.UTC(2026, 9, 5, 20);
  ok('borrow: daily formula uses |htbRate|', Math.abs(dailyBorrow({ htbRate: -20.75, shares: 1000, price: 6 }) - (0.2075 * 6000) / 360) < 1e-9);
  ok('borrow: days held', daysHeld('2026-09-25', now) === 10 && daysHeld(null) === null);
  const e = borrowEstimate({ borrow: { htbRate: -20.75, isHardToBorrow: true }, shares: 1000, price: 6, entryPrice: 7, openedAt: '2026-09-25', nowMs: now });
  ok('borrow: paid = current × days', Math.abs(e.paid - e.daily * 10) < 1e-9 && e.rate === 20.75 && e.rawRate === -20.75);
  ok('borrow: net = pnl − paid', Math.abs(e.pnl - 1000) < 1e-9 && Math.abs(e.net - (1000 - e.paid)) < 1e-9);
  const etb = borrowEstimate({ borrow: { htbRate: 0, isHardToBorrow: false }, shares: 100, price: 50, entryPrice: 55, openedAt: '2026-09-01', nowMs: now });
  ok('borrow: ETB $0/day', etb.daily === 0 && etb.paid === 0 && etb.net === etb.pnl && etb.etb);
  const unk = borrowEstimate({ borrow: null, shares: 100, price: 50, entryPrice: 55, openedAt: '2026-09-01', nowMs: now });
  ok('borrow: unknown → no numbers', !unk.known && unk.daily === null && unk.net === null && unk.pnl === 500);
  const closes = Array.from({ length: 12 }, (_, i) => ({ t: Date.UTC(2026, 8, 24 + i, 20), close: 10 + i }));
  const dc = borrowEstimate({ borrow: { htbRate: -36, isHardToBorrow: true }, shares: 100, price: 21, entryPrice: 10, openedAt: '2026-09-25', closes, nowMs: now });
  ok('borrow: daily closes method', dc.method === 'daily closes' && dc.paid > 0 && dc.paid < dc.daily * 10);
  console.log(`check:dip-buys borrow OK (${n} checks total)`);
}

// ---------------- sell / cover target rule (pure)
{
  const { sellTarget } = await import('../shared/sellTarget.js');
  const lv = [{ price: 102, touches: 3 }, { price: 108, touches: 1 }, { price: 110, touches: 2 }, { price: 140, touches: 4 }];
  ok('target: skips <1 ATR and 1-touch levels', sellTarget({ entry: 100, levels: lv, atrW: 4 }).price === 110);
  ok('target: capped at 2.5 ATR', sellTarget({ entry: 100, levels: [{ price: 140, touches: 4 }], atrW: 4 }).price === 110 && sellTarget({ entry: 100, levels: [{ price: 140, touches: 4 }], atrW: 4 }).capped);
  ok('target: no level → 2.5 ATR', sellTarget({ entry: 100, levels: [], atrW: 2 }).price === 105);
  ok('cover target: short mirror', sellTarget({ side: 'short', entry: 100, levels: [{ price: 97, touches: 5 }, { price: 93, touches: 2 }], atrW: 4 }).price === 93);
  console.log(`check:dip-buys target OK (${n} checks total)`);
}

// ---------------- paper limit orders (pure)
{
  const { paperStep, paperScore } = await import('../shared/paperOrders.js');
  const T = Date.UTC(2026, 9, 13, 14);
  const H = 1800000;
  const idea = { status: 'pending', side: 'long', qty: 10, limit_price: 50, entry_price: 50, stop_price: 45, target_price: 60, placed_at: new Date(T).toISOString(), auto_exit: true };
  const bars = [{ t: T - H, open: 49, high: 49, low: 48, close: 49 }, { t: T, open: 52, high: 52, low: 51, close: 51 }, { t: T + H, open: 51, high: 51, low: 49.5, close: 50 }, { t: T + 2 * H, open: 50, high: 61, low: 50, close: 60 }];
  const s1 = paperStep(idea, bars, { nowMs: T + 3 * H });
  ok('paper: no fill from bars before the order', s1.fill?.t === T + H && s1.fill.price === 50);
  ok('paper: exits at target after fill', s1.exit?.reason === 'target' && s1.exit.price === 60 && s1.exit.pnl === 100);
  const sh = { ...idea, side: 'short', limit_price: 50, stop_price: 55, target_price: 40 };
  const s2 = paperStep(sh, [{ t: T, open: 51, high: 51, low: 50, close: 50 }, { t: T + H, open: 56, high: 57, low: 54, close: 56 }], { nowMs: T + 2 * H });
  ok('paper short: gap fill at open, stop at gap open', s2.fill.price === 51 && s2.exit.reason === 'stop' && s2.exit.price === 56 && s2.exit.pnl === -50);
  const sc = paperScore([{ status: 'closed', exit_reason: 'target', realized_pnl: 100 }, { status: 'closed', exit_reason: 'stop', realized_pnl: -50 }, { status: 'open' }]);
  ok('paper score', sc.targetHitRate === 0.5 && sc.avgWin === 100 && sc.avgLoss === -50 && sc.realized === 50);
  console.log(`check:dip-buys paper orders OK (${n} checks total)`);
}

// ---------------- Buy $ place-now + cancel-now (FAKE Schwab only)
{
  const { placeEntryNow, placeNowBlock, cancelEntryNow } = await import('../api/_planOrders.js');
  const NOW = Date.UTC(2026, 9, 13, 3);
  const conn = { user_id: 'u1', status: 'connected', account_hash: 'h', refresh_expires_at: new Date(NOW + 86400000).toISOString(), kill_switch: false, live_enabled: false, data: {} };
  ok('place-now: TSLA blocked', /TSLA/.test(placeNowBlock({ symbol: 'TSLA', conn, nowMs: NOW })));
  ok('place-now: kill switch blocked', /PAUSED/.test(placeNowBlock({ symbol: 'ABC', conn: { ...conn, kill_switch: true }, nowMs: NOW })));
  ok('place-now: not connected blocked', /not connected/.test(placeNowBlock({ symbol: 'ABC', conn: null, nowMs: NOW })));
  ok('place-now: cap blocked', /cap/.test(placeNowBlock({ symbol: 'ABC', conn: { ...conn, data: { actions: { day: '2026-10-12', n: 20 } } }, nowMs: NOW })));
  ok('place-now: Live toggles not required, after hours ok', placeNowBlock({ symbol: 'ABC', conn, nowMs: NOW }) === null);
  const writes = [];
  const sb = { from: (t) => ({ update: (p) => ({ eq: () => ({ eq: () => { writes.push([t, p]); return Promise.resolve({}); }, then: (r) => { writes.push([t, p]); return Promise.resolve({}).then(r); } }) }) }) };
  const calls = [];
  const orders = {};
  const fb = { placeLimitBuy: async (a) => { calls.push(a); orders.B7 = { status: 'WORKING', filledQuantity: 0 }; return { orderId: 'B7' }; }, getOrder: async (id) => orders[id], cancel: async (id) => { orders[id].status = 'CANCELED'; } };
  const r = await placeEntryNow(sb, { plan: { id: 'p', symbol: 'ABC', side: 'long', shares: 10, limit_price: 50, data: {} }, conn, nowMs: NOW, broker: fb });
  ok('place-now: GTC limit sent + order id saved', r.ok && r.orderId === 'B7' && calls[0].duration === 'GOOD_TILL_CANCEL' && writes.some(([t, p]) => t === 'stock_plans' && p.buy_order_id === 'B7' && p.status === 'working' && p.data.manualOrder));
  const c = await cancelEntryNow(sb, { plan: { id: 'p', buy_order_id: 'B7', data: {} }, conn, nowMs: NOW, broker: fb });
  ok('cancel-now: cancelled at Schwab then marked', c.ok && !c.pending && writes.some(([, p]) => p.status === 'cancelled'));
  console.log(`check:dip-buys place-now OK (${n} checks total)`);
}

// ---------------- tradeability (pure)
{
  const { tradeability } = await import('../shared/dipBuys.js');
  const mk = (px, vol) => Array.from({ length: 25 }, () => ({ close: px, volume: vol }));
  ok('liq: $2 stock with 15M sh ($30M) passes (no price floor)', tradeability(mk(2, 15e6)).ok);
  ok('liq: $500 stock with 50k sh fails share rule', !tradeability(mk(500, 5e4)).ok);
  ok('liq: $5 × 1.5M = $7.5M fails dollar rule', !tradeability(mk(5, 1.5e6)).ok);
  ok('liq: $10 × 1.5M = $15M passes', tradeability(mk(10, 1.5e6)).ok);
  ok('liq: avg uses last 20', Math.round(tradeability(mk(50, 2e6)).avgDollarVol) === 1e8);
  console.log(`check:dip-buys liquidity OK (${n} checks total)`);
}
