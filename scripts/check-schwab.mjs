// Schwab LIVE stop rules + adapter, all against mocked HTTP / DB. No network, no real orders.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

process.env.SCHWAB_APP_KEY = 'test-app-key';
process.env.SCHWAB_APP_SECRET = 'test-app-secret';
process.env.SCHWAB_TOKEN_ENC_KEY = randomBytes(32).toString('base64');
delete process.env.TELEGRAM_BOT_TOKEN;

const L = await import('../shared/schwabLive.js');
const S = await import('../api/_schwab.js');
const { runLive } = await import('../api/_schwabLive.js');
const { liveOrderCheck } = await import('../shared/guard.js');

let passed = 0;
const ok = async (name, fn) => {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
};
const NOW = Date.parse('2026-10-05T20:20:00Z'); // Mon 4:20 pm ET (after-close pass)
const TODAY = '2026-10-05';
const conn = (o = {}) => ({ user_id: 'u1', status: 'connected', refresh_expires_at: new Date(NOW + 5 * 86400_000).toISOString(), access_expires_at: new Date(NOW + 20 * 60_000).toISOString(), account_hash: 'HASHABC', account_last4: '1234', live_enabled: true, kill_switch: false, data: {}, ...o });
const pos = (o = {}) => ({ id: 'p1', user_id: 'u1', symbol: 'SPY', side: 'long', shares: 5, entry_price: 762.63, live: true, ...o });
const held = (sym, longQty, shortQty = 0) => ({ symbol: sym, longQty, shortQty });
const snap = (stop, price = 760) => ({ stop, price });
const plan = (o = {}) => L.planLiveAction({ conn: conn(), position: pos(), snapshot: snap(748.944), liveOrder: null, holdings: [held('SPY', 5)], openOrders: [], price: 760, pass: 'close', today: TODAY, actionsToday: 0, guard: null, nowMs: NOW, ...o });
const working = (o = {}) => ({ order_id: '1001', status: 'working', stop_price: 748.95, qty: 5, last_modified_day: null, data: {}, ...o });

console.log('check:schwab');

await ok('tick rounding: $0.01 ≥ $1, $0.0001 < $1, protective direction (long up, short down)', () => {
  assert.equal(L.roundStop(748.944, 'long'), 748.95);
  assert.equal(L.roundStop(748.944, 'short'), 748.94);
  assert.equal(L.roundStop(21.506, 'short'), 21.5);
  assert.equal(L.roundStop(10, 'long'), 10);
  assert.equal(L.roundStop(0.12345, 'long'), 0.1235);
  assert.equal(L.roundStop(0.12345, 'short'), 0.1234);
  assert.equal(L.roundStop(0.99995, 'long'), 1);
  assert.equal(L.stopString(748.95), '748.95');
  assert.equal(L.stopString(0.1235), '0.1235');
  assert.equal(L.tickSize(1), 0.01);
  assert.equal(L.tickSize(0.5), 0.0001);
});

await ok('order JSON: STOP, GTC, NORMAL, SINGLE; SELL for long, BUY_TO_COVER for short; whole shares only', () => {
  assert.deepEqual(L.buildStopOrder({ symbol: 'spy', side: 'long', qty: 5, stopPrice: 748.95 }), {
    orderType: 'STOP', session: 'NORMAL', duration: 'GOOD_TILL_CANCEL', orderStrategyType: 'SINGLE', stopPrice: '748.95',
    orderLegCollection: [{ instruction: 'SELL', quantity: 5, instrument: { symbol: 'SPY', assetType: 'EQUITY' } }],
  });
  assert.equal(L.buildStopOrder({ symbol: 'PLUG', side: 'short', qty: 300, stopPrice: 2.1 }).orderLegCollection[0].instruction, 'BUY_TO_COVER');
  assert.throws(() => L.buildStopOrder({ symbol: 'SPY', side: 'long', qty: 2.5, stopPrice: 10 }));
  assert.throws(() => L.buildStopOrder({ symbol: 'SPY', side: 'long', qty: 0, stopPrice: 10 }));
});

await ok('shares to protect = min(app shares, Schwab shares on that side); none / wrong side → not found', () => {
  assert.deepEqual(L.sharesToProtect({ symbol: 'SPY', side: 'long', appShares: 5, holdings: [held('SPY', 3)] }), { qty: 3, held: 3, status: 'ok', message: null });
  assert.equal(L.sharesToProtect({ symbol: 'SPY', side: 'long', appShares: 5, holdings: [held('SPY', 10)] }).qty, 5);
  assert.equal(L.sharesToProtect({ symbol: 'SPY', side: 'long', appShares: 5, holdings: [held('SPY', 2.5)] }).qty, 2);
  assert.equal(L.sharesToProtect({ symbol: 'SPY', side: 'long', appShares: 5, holdings: [] }).status, 'not_found');
  assert.equal(L.sharesToProtect({ symbol: 'SPY', side: 'short', appShares: 5, holdings: [held('SPY', 5)] }).status, 'side_mismatch');
  const r = plan({ holdings: [held('QQQ', 5)] });
  assert.equal(r.action, 'none');
  assert.equal(r.flag.code, 'not_found');
  assert.match(r.flag.message, /Not found at Schwab/);
  const p = plan({ holdings: [held('SPY', 3)] });
  assert.equal(p.action, 'place');
  assert.equal(p.qty, 3, 'never more than held');
});

await ok('holdings parser: long/short quantities per symbol, options ignored', () => {
  const h = L.holdingsFromAccount({ securitiesAccount: { positions: [
    { longQuantity: 5, shortQuantity: 0, instrument: { symbol: 'SPY', assetType: 'COLLECTIVE_INVESTMENT' } },
    { longQuantity: 0, shortQuantity: 300, instrument: { symbol: 'PLUG', assetType: 'EQUITY' } },
    { longQuantity: 1, shortQuantity: 0, instrument: { symbol: 'SPY   261218C00700000', assetType: 'OPTION' } },
  ] } });
  assert.deepEqual(h, [held('SPY', 5), held('PLUG', 0, 300)]);
});

await ok('first placement: SELL STOP at the rounded stop, guard-gated, allowed in any pass', () => {
  const r = plan({ pass: 'manual' });
  assert.equal(r.action, 'place');
  assert.equal(r.stopPrice, 748.95);
  assert.equal(r.qty, 5);
  assert.equal(r.kind, 'place_stop');
  const locked = plan({ guard: { locked: true } });
  assert.equal(locked.action, 'place', 'protective stops allowed while locked');
  assert.match(locked.note, /locked/);
});

await ok('wrong-side refusal: stop at/through the price → "stop already crossed, review", nothing placed', () => {
  const r = plan({ snapshot: snap(761), price: 760 });
  assert.equal(r.action, 'none');
  assert.equal(r.flag.code, 'stop_crossed');
  assert.match(r.flag.message, /Stop already crossed, review/);
  const s = L.planLiveAction({ conn: conn(), position: pos({ symbol: 'PLUG', side: 'short', shares: 300 }), snapshot: snap(2.0), holdings: [held('PLUG', 0, 300)], openOrders: [], price: 2.05, pass: 'close', today: TODAY, nowMs: NOW });
  assert.equal(s.flag.code, 'stop_crossed', 'short buy-stop below the price');
  const m = plan({ liveOrder: working(), snapshot: snap(761), price: 760 });
  assert.equal(m.action, 'none');
  assert.equal(m.flag.code, 'stop_crossed', 'modify into a crossed stop refused too');
});

await ok('15% cap: a modify that moves the stop > 15% in one step is refused', () => {
  const cur = working({ stop_price: 600, qty: 5 });
  const r = plan({ liveOrder: cur, snapshot: snap(700), price: 760 });
  assert.equal(r.action, 'none');
  assert.equal(r.flag.code, 'jump_cap');
  const ok2 = plan({ liveOrder: working({ stop_price: 680 }), snapshot: snap(700), price: 760 });
  assert.equal(ok2.action, 'modify');
  assert.equal(ok2.stopPrice, 700);
});

await ok('stops only tighten; one modify per day from the after-close pass', () => {
  assert.equal(plan({ liveOrder: working({ stop_price: 750 }), snapshot: snap(748.944) }).action, 'none', 'never loosens');
  const intraday = plan({ liveOrder: working({ stop_price: 745 }), pass: 'intraday' });
  assert.equal(intraday.action, 'none');
  assert.equal(intraday.pending, 'after-close pass');
  const close = plan({ liveOrder: working({ stop_price: 745 }) });
  assert.equal(close.action, 'modify');
  assert.equal(close.kind, 'tighten_stop');
  assert.equal(close.stopPrice, 748.95);
  assert.equal(plan({ liveOrder: working({ stop_price: 745, last_modified_day: TODAY }) }).action, 'none', 'already modified today');
  assert.equal(plan({ liveOrder: working({ stop_price: 745, data: { allowModifyOnce: true } }), pass: 'manual' }).action, 'modify', 'adopted order: one immediate modify');
  const s = L.planLiveAction({ conn: conn(), position: pos({ symbol: 'PLUG', side: 'short', shares: 300 }), snapshot: snap(2.104, 1.9), liveOrder: working({ stop_price: 2.2, qty: 300 }), holdings: [held('PLUG', 0, 300)], openOrders: [], price: 1.9, pass: 'close', today: TODAY, nowMs: NOW });
  assert.equal(s.action, 'modify');
  assert.equal(s.stopPrice, 2.1, 'short buy-stop moves down only, rounded down');
});

await ok('quantity: reduced at once when you hold fewer shares (protective), never above held', () => {
  const r = plan({ liveOrder: working({ stop_price: 748.95, qty: 5 }), holdings: [held('SPY', 3)], pass: 'intraday' });
  assert.equal(r.action, 'modify');
  assert.equal(r.qty, 3);
  assert.equal(r.stopPrice, 748.95);
});

await ok('duplicate detection: your own stop for the symbol is shown, never duplicated; only plain STOPs adoptable', () => {
  const orders = [
    { orderId: 501, orderType: 'STOP', status: 'WORKING', stopPrice: 740, orderStrategyType: 'SINGLE', duration: 'GOOD_TILL_CANCEL', orderLegCollection: [{ instruction: 'SELL', quantity: 5, instrument: { symbol: 'SPY' } }] },
    { orderId: 502, orderType: 'STOP_LIMIT', status: 'WORKING', stopPrice: 739, orderStrategyType: 'SINGLE', orderLegCollection: [{ instruction: 'SELL', quantity: 5, instrument: { symbol: 'SPY' } }] },
    { orderId: 503, orderType: 'STOP', status: 'FILLED', stopPrice: 700, orderLegCollection: [{ instruction: 'SELL', quantity: 5, instrument: { symbol: 'SPY' } }] },
    { orderId: 504, orderType: 'STOP', status: 'WORKING', stopPrice: 700, orderLegCollection: [{ instruction: 'SELL', quantity: 5, instrument: { symbol: 'QQQ' } }] },
    { orderId: 505, orderType: 'LIMIT', status: 'WORKING', price: 800, orderStrategyType: 'OCO', orderLegCollection: [], childOrderStrategies: [
      { orderId: 506, orderType: 'STOP', status: 'WORKING', stopPrice: 735, orderStrategyType: 'SINGLE', orderLegCollection: [{ instruction: 'SELL', quantity: 5, instrument: { symbol: 'SPY' } }] },
    ] },
    { orderId: 507, orderType: 'STOP', status: 'WORKING', stopPrice: 780, orderLegCollection: [{ instruction: 'BUY_TO_COVER', quantity: 5, instrument: { symbol: 'SPY' } }] },
  ];
  const f = L.findOwnStops({ orders, symbol: 'SPY', side: 'long' });
  assert.deepEqual(f.map((x) => [x.orderId, x.manageable]), [['501', true], ['502', false], ['506', false]]);
  const r = plan({ openOrders: orders });
  assert.equal(r.action, 'none');
  assert.equal(r.flag.code, 'own_stop');
  assert.equal(r.foreign.length, 3);
  const managed = plan({ openOrders: orders, liveOrder: working({ order_id: '501', stop_price: 740 }) });
  assert.equal(managed.action, 'modify', 'adopted 501 is modified, not duplicated');
  assert.ok(!managed.foreign.some((x) => x.orderId === '501'));
});

await ok('kill switch: blocks every Schwab order action; live mode never sends entries', () => {
  const r = plan({ conn: conn({ kill_switch: true }) });
  assert.equal(r.action, 'none');
  assert.equal(r.flag.code, 'kill_switch');
  assert.equal(liveOrderCheck({ locked: true }, { kind: 'tighten_stop', killSwitch: true }).allowed, false);
  assert.equal(liveOrderCheck(null, { kind: 'cancel_stop', killSwitch: true }).allowed, false);
  assert.equal(liveOrderCheck(null, { kind: 'entry' }).allowed, false);
  assert.equal(liveOrderCheck({ paused: true }, { kind: 'place_stop' }).allowed, true, 'pause still allows protective stops');
});

await ok('expired token → watch-only (no orders), Live off / no account / position not Live → nothing', () => {
  const r = plan({ conn: conn({ refresh_expires_at: new Date(NOW - 1000).toISOString() }) });
  assert.equal(r.action, 'none');
  assert.equal(r.flag.code, 'expired');
  assert.equal(plan({ conn: conn({ status: 'expired' }) }).flag.code, 'watch_only');
  assert.deepEqual(plan({ conn: conn({ live_enabled: false }) }), { action: 'none', flag: null, foreign: [] });
  assert.equal(plan({ conn: conn({ account_hash: null }) }).flag.code, 'no_account');
  assert.equal(plan({ position: pos({ live: false }) }).action, 'none');
  assert.equal(plan({ liveOrder: { status: 'filled' } }).action, 'none');
});

await ok('daily cap: 20 order actions per user per day', () => {
  assert.equal(plan({ actionsToday: 20 }).flag.code, 'daily_cap');
  assert.equal(plan({ actionsToday: 19 }).action, 'place');
});

await ok('reminders: 48h and 12h before refresh expiry, once each; expired detected', () => {
  const at = (h) => new Date(NOW + h * 3600_000).toISOString();
  assert.deepEqual(L.remindersDue({ refreshExpiresAt: at(47), nowMs: NOW }).due, [48]);
  assert.deepEqual(L.remindersDue({ refreshExpiresAt: at(11), nowMs: NOW }).due, [12]);
  assert.deepEqual(L.remindersDue({ refreshExpiresAt: at(30), sent: { h48: true }, nowMs: NOW }).due, []);
  assert.deepEqual(L.remindersDue({ refreshExpiresAt: at(100), nowMs: NOW }).due, []);
  assert.equal(L.remindersDue({ refreshExpiresAt: at(-1), nowMs: NOW }).expired, true);
});

await ok('tokens: AES-GCM round trip bound to the user id; signed state rejects tampering / expiry', () => {
  const blob = S.encryptToken('secret-token', 'u1');
  assert.ok(blob.startsWith('v1:') && !blob.includes('secret-token'));
  assert.equal(S.decryptToken(blob, 'u1'), 'secret-token');
  assert.throws(() => S.decryptToken(blob, 'u2'), 'wrong user (AAD) fails');
  const st = S.signState({ u: 'u1', n: 'n', o: 'https://trade-smart-app.vercel.app', e: NOW + 60_000 });
  assert.equal(S.verifyState(st, { nowMs: NOW }).u, 'u1');
  assert.equal(S.verifyState(st, { nowMs: NOW + 120_000 }), null, 'expired');
  const [b, sig] = st.split('.');
  const forged = Buffer.from(JSON.stringify({ u: 'attacker', n: 'n', e: NOW + 60_000 })).toString('base64url');
  assert.equal(S.verifyState(`${forged}.${sig}`, { nowMs: NOW }), null, 'tampered payload');
  assert.equal(S.verifyState(`${b}.xx`, { nowMs: NOW }), null);
  assert.equal(S.verifyState('garbage', { nowMs: NOW }), null);
});

await ok('OAuth: authorize URL + token request (Basic key:secret, form body, refresh = issue + 7 days)', async () => {
  const u = new URL(S.authorizeUrl('STATE1'));
  assert.equal(u.origin + u.pathname, 'https://api.schwabapi.com/v1/oauth/authorize');
  assert.equal(u.searchParams.get('client_id'), 'test-app-key');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://trade-smart-app.vercel.app/api/schwab/callback');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('state'), 'STATE1');
  let seen;
  const tok = await S.tokenRequest({ grant_type: 'authorization_code', code: 'C0.abc@', redirect_uri: S.redirectUri() }, {
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return new Response(JSON.stringify({ access_token: 'AT', refresh_token: 'RT', expires_in: 1800 }), { status: 200 });
    },
  });
  assert.equal(seen.url, 'https://api.schwabapi.com/v1/oauth/token');
  assert.equal(seen.init.headers.Authorization, `Basic ${Buffer.from('test-app-key:test-app-secret').toString('base64')}`);
  assert.equal(seen.init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(new URLSearchParams(seen.init.body).get('code'), 'C0.abc@');
  const cols = S.tokenColumns(tok, 'u1', { nowMs: NOW });
  assert.equal(cols.refresh_expires_at, new Date(NOW + 7 * 86400_000).toISOString());
  assert.equal(cols.access_expires_at, new Date(NOW + 1800_000).toISOString());
  await assert.rejects(S.tokenRequest({ grant_type: 'refresh_token', refresh_token: 'x' }, { fetchImpl: async () => new Response('{"error":"invalid_client"}', { status: 400 }) }), /invalid_client/);
});

// ---- mocked Schwab HTTP
function mockSchwab({ positions = [held('SPY', 5)], orders = [], quotes = { SPY: 760 } } = {}) {
  const calls = [];
  let nextId = 9001;
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const m = init.method || 'GET';
    calls.push({ m, path: u.pathname, query: Object.fromEntries(u.searchParams), body: init.body && init.headers?.['Content-Type'] === 'application/json' ? JSON.parse(init.body) : init.body ?? null, auth: init.headers?.Authorization });
    if (u.pathname === '/v1/oauth/token') return new Response(JSON.stringify({ access_token: 'AT2', refresh_token: 'RT', expires_in: 1800 }), { status: 200 });
    if (u.pathname === '/marketdata/v1/quotes') return Response.json(Object.fromEntries(Object.entries(quotes).map(([k, v]) => [k, { quote: { lastPrice: v } }])));
    if (u.pathname.endsWith('/orders') && m === 'GET') return Response.json(orders);
    if (u.pathname.endsWith('/orders') && m === 'POST') return new Response(null, { status: 201, headers: { Location: `https://api.schwabapi.com${u.pathname}/${nextId++}` } });
    if (/\/orders\/\d+$/.test(u.pathname) && m === 'PUT') return new Response(null, { status: 201, headers: { Location: `https://api.schwabapi.com${u.pathname.replace(/\d+$/, String(nextId++))}` } });
    if (/\/orders\/\d+$/.test(u.pathname) && m === 'DELETE') return new Response(null, { status: 200 });
    if (/\/orders\/\d+$/.test(u.pathname)) return Response.json(orders.find((o) => String(o.orderId) === u.pathname.split('/').pop()) || {}, { status: 200 });
    if (/\/accounts\/[^/]+$/.test(u.pathname)) return Response.json({ securitiesAccount: { positions: positions.map((h) => ({ longQuantity: h.longQty, shortQuantity: h.shortQty, instrument: { symbol: h.symbol, assetType: 'EQUITY' } })) } });
    return new Response('not found', { status: 404 });
  };
  return { calls, fetchImpl };
}

await ok('adapter: POST/PUT/DELETE paths + body, order id from Location, positions + quotes parsed, logs redact the account', async () => {
  const mock = mockSchwab();
  const logs = [];
  const call = S.schwabHttp({ token: 'AT', fetchImpl: mock.fetchImpl, log: (r) => logs.push(r) });
  const b = S.createSchwabBroker({ call, accountHash: 'HASHABC', nowMs: NOW });
  assert.deepEqual(await b.getPositions(), [held('SPY', 5)]);
  const placed = await b.placeStop({ symbol: 'SPY', positionSide: 'long', qty: 5, stopPrice: 748.95 });
  assert.equal(placed.orderId, '9001');
  const post = mock.calls.find((c) => c.m === 'POST');
  assert.equal(post.path, '/trader/v1/accounts/HASHABC/orders');
  assert.equal(post.body.orderType, 'STOP');
  assert.equal(post.body.stopPrice, '748.95');
  assert.equal(post.auth, 'Bearer AT');
  const rep = await b.modifyStop('9001', { symbol: 'SPY', positionSide: 'long', qty: 5, stopPrice: 750.1 });
  assert.equal(rep.orderId, '9002', 'replace returns the new order id');
  assert.equal(mock.calls.find((c) => c.m === 'PUT').path, '/trader/v1/accounts/HASHABC/orders/9001');
  await b.cancel('9002');
  assert.equal(mock.calls.find((c) => c.m === 'DELETE').path, '/trader/v1/accounts/HASHABC/orders/9002');
  assert.equal((await b.getQuotes(['SPY'])).get('SPY'), 760);
  await b.getOrders();
  const g = mock.calls.find((c) => c.m === 'GET' && c.path.endsWith('/orders'));
  assert.match(g.query.fromEnteredTime, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.ok(logs.length >= 6);
  assert.ok(logs.every((l) => !JSON.stringify(l).includes('HASHABC') && !JSON.stringify(l).includes('AT')), 'no account hash / token in logs');
  assert.equal(S.orderIdFromLocation('https://api.schwabapi.com/trader/v1/accounts/ABC/orders/123456'), '123456');
});

// ---- mocked Supabase (records writes)
function mockSb(tables) {
  const writes = [];
  const from = (t) => {
    const st = { t, filters: [], op: 'select', payload: null };
    const rows = () => (tables[t] || []).filter((r) => st.filters.every(([k, v, kind]) => (kind === 'in' ? v.includes(r[k]) : r[k] === v)));
    const api = {
      select() { return api; },
      eq(k, v) { st.filters.push([k, v, 'eq']); return api; },
      in(k, v) { st.filters.push([k, v, 'in']); return api; },
      maybeSingle() { return Promise.resolve({ data: rows()[0] ?? null, error: null }); },
      insert(p) { writes.push({ t, op: 'insert', p }); return Promise.resolve({ error: null }); },
      upsert(p) { writes.push({ t, op: 'upsert', p }); return Promise.resolve({ error: null }); },
      update(p) { st.op = 'update'; st.payload = p; writes.push({ t, op: 'update', p, st }); return api; },
      then(res, rej) { return Promise.resolve({ data: rows(), error: null }).then(res, rej); },
    };
    return api;
  };
  return { from, writes };
}

const connRow = () => ({ ...conn(), broker: 'schwab', enc_access: S.encryptToken('AT', 'u1'), enc_refresh: S.encryptToken('RT', 'u1') });

await ok('runner: Live position → one real-shaped SELL STOP placed via mocked Schwab, LIVE events logged, no secrets', async () => {
  const sb = mockSb({ broker_connections: [connRow()], stock_live_orders: [] });
  const mock = mockSchwab();
  const r = await runLive(sb, { positions: [pos()], snapshots: new Map([['p1', snap(748.944)]]), guardFor: () => null, pass: 'manual', nowMs: NOW, runId: 'r1', fetchImpl: mock.fetchImpl });
  assert.equal(r.actions, 1);
  assert.equal(mock.calls.filter((c) => c.m === 'POST').length, 1);
  const up = sb.writes.find((w) => w.t === 'stock_live_orders').p[0];
  assert.equal(up.status, 'working');
  assert.equal(up.order_id, '9001');
  assert.equal(up.stop_price, 748.95);
  assert.equal(up.qty, 5);
  const ev = sb.writes.find((w) => w.t === 'stock_paper_events').p;
  assert.ok(ev.some((e) => e.kind === 'live_placed' && /LIVE placed Schwab STOP SELL 5 SPY @ \$748\.95/.test(e.reason)));
  assert.ok(ev.filter((e) => e.kind === 'live_request').length >= 4, 'every request logged');
  const dump = JSON.stringify(sb.writes.filter((w) => w.t !== 'broker_connections'));
  assert.ok(!dump.includes('HASHABC') && !dump.includes('"AT"') && !dump.includes('Bearer'), 'no hash / token in logs');
  const counter = sb.writes.find((w) => w.t === 'broker_connections' && w.op === 'update');
  assert.deepEqual(counter.p.data.actions, { day: TODAY, n: 1 });
});

await ok('runner: own stop at Schwab → not duplicated; not held → nothing; kill switch / expired → no HTTP at all', async () => {
  const own = [{ orderId: 501, orderType: 'STOP', status: 'WORKING', stopPrice: 740, orderStrategyType: 'SINGLE', orderLegCollection: [{ instruction: 'SELL', quantity: 5, instrument: { symbol: 'SPY' } }] }];
  let sb = mockSb({ broker_connections: [connRow()], stock_live_orders: [] });
  let mock = mockSchwab({ orders: own });
  await runLive(sb, { positions: [pos()], snapshots: new Map([['p1', snap(748.944)]]), guardFor: () => null, pass: 'manual', nowMs: NOW, runId: 'r', fetchImpl: mock.fetchImpl });
  assert.equal(mock.calls.filter((c) => c.m !== 'GET').length, 0);
  assert.equal(sb.writes.find((w) => w.t === 'stock_live_orders').p[0].flag.code, 'own_stop');
  assert.equal(sb.writes.find((w) => w.t === 'stock_live_orders').p[0].foreign_stops[0].orderId, '501');

  sb = mockSb({ broker_connections: [connRow()], stock_live_orders: [] });
  mock = mockSchwab({ positions: [] });
  await runLive(sb, { positions: [pos()], snapshots: new Map([['p1', snap(748.944)]]), guardFor: () => null, pass: 'manual', nowMs: NOW, runId: 'r', fetchImpl: mock.fetchImpl });
  assert.equal(mock.calls.filter((c) => c.m !== 'GET').length, 0);
  assert.equal(sb.writes.find((w) => w.t === 'stock_live_orders').p[0].flag.code, 'not_found');

  for (const c of [{ kill_switch: true }, { refresh_expires_at: new Date(NOW - 1).toISOString() }]) {
    sb = mockSb({ broker_connections: [{ ...connRow(), ...c }], stock_live_orders: [] });
    mock = mockSchwab();
    await runLive(sb, { positions: [pos()], snapshots: new Map([['p1', snap(748.944)]]), guardFor: () => null, pass: 'close', nowMs: NOW, runId: 'r', fetchImpl: mock.fetchImpl });
    assert.equal(mock.calls.length, 0, 'no Schwab calls');
  }
});

await ok('runner: managed order filled at Schwab → recorded once, no new order', async () => {
  const filled = [{ orderId: 1001, orderType: 'STOP', status: 'FILLED', stopPrice: 748.95, filledQuantity: 5, orderLegCollection: [{ instruction: 'SELL', quantity: 5, instrument: { symbol: 'SPY' } }], orderActivityCollection: [{ executionLegs: [{ quantity: 5, price: 748.1 }] }] }];
  const sb = mockSb({ broker_connections: [connRow()], stock_live_orders: [{ position_id: 'p1', user_id: 'u1', symbol: 'SPY', position_side: 'long', instruction: 'SELL', ...working(), foreign_stops: [] }] });
  const mock = mockSchwab({ orders: filled, positions: [] });
  await runLive(sb, { positions: [pos()], snapshots: new Map([['p1', snap(750)]]), guardFor: () => null, pass: 'close', nowMs: NOW, runId: 'r', fetchImpl: mock.fetchImpl });
  const row = sb.writes.find((w) => w.t === 'stock_live_orders').p[0];
  assert.equal(row.status, 'filled');
  assert.equal(row.fill_price, 748.1);
  assert.equal(mock.calls.filter((c) => c.m !== 'GET').length, 0);
});

await ok('token refresh: expired access token refreshed server-side; refused refresh → connection expired', async () => {
  const sb = mockSb({ broker_connections: [] });
  const c = { ...connRow(), access_expires_at: new Date(NOW - 1000).toISOString() };
  const mock = mockSchwab();
  assert.equal(await S.accessTokenFor(sb, c, { nowMs: NOW, fetchImpl: mock.fetchImpl }), 'AT2');
  const up = sb.writes.find((w) => w.t === 'broker_connections').p;
  assert.ok(up.enc_access.startsWith('v1:'));
  assert.equal(up.refresh_expires_at, c.refresh_expires_at, 'refresh expiry stays issue + 7 days');
  const bad = { ...connRow(), access_expires_at: new Date(NOW - 1000).toISOString() };
  await assert.rejects(S.accessTokenFor(sb, bad, { nowMs: NOW, fetchImpl: async () => new Response('{"error":"invalid_client"}', { status: 400 }) }));
  assert.equal(bad.status, 'expired');
  await assert.rejects(S.accessTokenFor(sb, { ...connRow(), refresh_expires_at: new Date(NOW - 1).toISOString() }, { nowMs: NOW }), /reconnect/);
});

console.log(`check:schwab OK (${passed} checks; no network, no real orders)`);
