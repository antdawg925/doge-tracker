/**
 * DOGE live plan checks (no network, no orders): Round 4 math vs the backtest
 * (/workspace/doge-backtest/today_plan.txt), ratchet, caps, crossed stops, kill switch, zone
 * arming without overselling, pot breakout + pot stop, lock exit → plan ends, Kraken rounding,
 * and the live executor against a mocked Kraken.
 */
import assert from 'node:assert/strict'
import {
  dailySignal, dryExecute, initLiveState, lockFor, lockStopPrice, normalizeLiveConfig, potMult, priceStr, stepDogeLive, volStr,
} from '../shared/dogeLive.js'
import { createKrakenTrader, krakenTradeCredsFor, bookFromBalance, splitOpenOrders } from '../api/_krakenTrade.js'
import { executeLive } from '../api/_dogeLive.js'

let n = 0
const ok = (name, fn) => {
  fn()
  n++
}
const okA = async (name, fn) => {
  await fn()
  n++
}
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`)

const DAY = 86400000
const H4 = 4 * 3600000
const T0 = Date.UTC(2026, 9, 3, 12)
/** daily bars: flat-ish around `base`, completed before `now`; last close optional */
function dailyBars(now, { base = 0.09, lastClose = null, days = 80, drift = 0 } = {}) {
  const start = Math.floor(now / DAY) * DAY - days * DAY
  const out = []
  for (let i = 0; i < days; i++) {
    const c = base * (1 + drift * i) * (1 + 0.01 * Math.sin(i))
    out.push({ t: start + i * DAY, open: c, high: c * 1.03, low: c * 0.97, close: c })
  }
  if (lastClose != null) out[out.length - 1] = { ...out[out.length - 1], close: lastClose, high: lastClose * 1.01 }
  out.push({ t: start + days * DAY, open: 1, high: 1, low: 1, close: 1 }) // in-progress day (ignored)
  return out
}
function bars4(now, close, count = 40) {
  const end = Math.floor(now / H4) * H4
  const out = []
  for (let i = count; i >= 1; i--) out.push({ t: end - i * H4, open: close, high: close, low: close, close })
  out.push({ t: end, open: close, high: close, low: close, close: 999 }) // in progress (ignored)
  return out
}
const btc = (now) => dailyBars(now, { base: 80000, drift: 0.002 })
const mkt = (now, p, extra = {}) => ({ price: p, bid: p, ask: p, bars4h: bars4(now, p), daily: dailyBars(now), btcDaily: btc(now), ...extra })

// ------------------------------------------------------------------ lock math (backtest)
ok('lock levels', () => {
  const c = normalizeLiveConfig({ startValue: 19000 })
  assert.equal(lockFor(c, 28499), null)
  near(lockFor(c, 28500), 19000 + 0.7 * 9500, 1e-6, '28.5k activates')
  near(lockFor(c, 30000), 26700, 1e-6, 'HWM 30k')
  near(lockFor(c, 40000), 33700, 1e-6, 'HWM 40k')
  near(lockFor(c, 39830), 33581, 1, 'HWM 39,830 (zone-1 account)')
  near(lockFor(c, 50000), 40700, 1e-6, 'HWM 50k')
  near(lockFor(c, 70000), 54700, 1e-6, 'HWM 70k')
})
ok('lock stop price', () => {
  near(lockStopPrice({ lock: 33581, usd: 0, doge: 199149 }), 0.1686, 0.0001, 'all DOGE, $0 cash')
  near(lockStopPrice({ lock: 33700, usd: 0, doge: 199150 }), 0.1692, 0.0001, 'HWM 40k')
  near(lockStopPrice({ lock: 33581, usd: 23790, doge: 79660 }), 0.1229, 0.0001, 'after zone 1')
  near(lockStopPrice({ lock: 39082, usd: 35686, doge: 39830 }), 0.0853, 0.0001, 'after zone 2a')
  near(lockStopPrice({ lock: 41832, usd: 35686, doge: 39830 }), 0.1543, 0.0001, 'zone 2b before')
  assert.equal(lockStopPrice({ lock: 41832, usd: 43616, doge: 19915 }), null, 'cash covers the lock')
})
ok('pot ATR multiplier schedule', () => {
  const pa = normalizeLiveConfig({}).potAtr
  assert.equal(potMult(0.1, pa), 3)
  assert.equal(potMult(0.2, pa), 2)
  assert.equal(potMult(0.49, pa), 2)
  assert.equal(potMult(0.5, pa), 1.5)
})
ok('Kraken rounding + minimums', () => {
  assert.equal(priceStr(0.16862345678), '0.1686235')
  assert.equal(volStr(199149.123456789), '199149.12345678')
  assert.equal(volStr(0.1 + 0.2), '0.30000000')
})

// ------------------------------------------------------------------ walk today's plan (dry)
const cfg = { startValue: 19000, startDoge: 199149, startUsd: 0, potUsd: 0, feePct: 0.45, zones: [{ price: 0.2, keepPct: 40 }, { price: 0.3, keepPct: 20 }, { price: 0.4, keepPct: 10 }] }
function run(state, p, now, extra = {}) {
  const r = stepDogeLive({ config: { ...cfg, ...(extra.config || {}) }, state, mode: 'dry', market: mkt(now, p, extra.market), nowMs: now, killSwitch: extra.kill, guard: extra.guard })
  dryExecute(r.state, r.intents, { config: r.config, market: mkt(now, p), nowIso: new Date(now).toISOString() })
  return r
}
ok('backtest path: 0.12 no lock, 0.15 lock 26,611 stop 0.1336, 0.1999 lock ~33.58k stop ~0.1686', () => {
  const c0 = normalizeLiveConfig(cfg, T0)
  let st = initLiveState(c0, T0)
  let r = run(st, 0.12, T0)
  assert.equal(r.snapshot.lockActive, false)
  assert.equal(r.intents.length, 0)
  near(r.snapshot.account, 23898, 1, 'account at 0.12')
  r = run(r.state, 0.15, T0 + H4)
  near(r.snapshot.lock, 26611, 1, 'lock at 0.15')
  assert.equal(r.intents.length, 1)
  assert.equal(r.intents[0].action, 'place')
  assert.equal(r.intents[0].ordertype, 'stop-loss')
  near(r.intents[0].price, 0.1336, 0.0001, 'stop at 0.15')
  near(r.intents[0].qty, 199149, 0.01, 'all DOGE')
  // 0.15 → 0.1899: lock rises; zone not armed yet (<0.19)
  const prevStop = r.state.orders.stop.price
  r = run(r.state, 0.1899, T0 + 2 * H4)
  assert.ok(!r.intents.some((i) => i.role === 'zone'))
  const s = r.intents.find((i) => i.role === 'stop')
  assert.equal(s.action, 'amend')
  near(s.price, prevStop * 1.15, 1e-6, 'raise capped at +15%/step')
  assert.ok(r.snapshot.flags.some((f) => f.code === 'step_capped'))
})
ok('HWM $39,830 with 199,149 DOGE + $0 → lock $33,581, stop $0.1686 (zones far away)', () => {
  const c0 = normalizeLiveConfig({ ...cfg, zones: [{ price: 5, keepPct: 40 }] }, T0)
  let st = initLiveState(c0, T0)
  st.hwm = 39830
  st.lockActive = true
  st.lock = 33581
  const r = stepDogeLive({ config: c0, state: st, mode: 'dry', market: mkt(T0, 0.2), nowMs: T0 })
  near(r.snapshot.lock, 33581, 1, 'lock')
  near(r.intents[0].price, 0.1686, 0.0001, 'stop price')
})

ok('ratchet: price dips → stop unchanged; tiny raise skipped; never lowered for same qty', () => {
  const c0 = normalizeLiveConfig(cfg, T0)
  let r = run(initLiveState(c0, T0), 0.15, T0)
  const placed = r.state.orders.stop.price
  r = run(r.state, 0.14, T0 + H4)
  assert.equal(r.intents.length, 0)
  assert.equal(r.state.orders.stop.price, placed)
  r = run(r.state, 0.1501, T0 + 2 * H4) // lock +0.7×19.9 → stop +0.00007 (<0.5%)
  assert.equal(r.intents.length, 0, 'sub-0.5% raise skipped')
})

ok('stop at/above the market is refused and flagged', () => {
  const c0 = normalizeLiveConfig(cfg, T0)
  const st = initLiveState(c0, T0)
  st.hwm = 39830
  st.lockActive = true
  st.lock = 33581
  // market crashed below the lock stop before any stop rested
  const r = stepDogeLive({ config: c0, state: st, mode: 'dry', market: mkt(T0, 0.15), nowMs: T0 })
  assert.equal(r.intents.length, 0)
  assert.ok(r.snapshot.flags.some((f) => f.code === 'stop_crossed'))
})

ok('zone arms near its price: stop shrinks first, stop + limit ≤ DOGE; fills → stop re-priced ($0.1229-ish)', () => {
  const c0 = normalizeLiveConfig(cfg, T0)
  let r = run(initLiveState(c0, T0), 0.15, T0)
  for (let i = 1; i <= 3; i++) r = run(r.state, 0.15 + i * 0.01, T0 + i * H4) // walk up so 15% caps don't bind
  r = run(r.state, 0.195, T0 + 6 * H4)
  const order = r.intents.map((i) => `${i.action}:${i.role}`)
  assert.deepEqual(order.slice(0, 2), ['amend:stop', 'place:zone'], `order ${order}`)
  const z = r.intents.find((i) => i.role === 'zone')
  const s = r.intents.find((i) => i.role === 'stop')
  near(z.qty, 199149 * 0.6, 1, 'zone sells down to 40% of max')
  assert.ok(z.qty + s.qty <= 199149 + 1e-6, 'never oversell')
  near(z.price, 0.2, 1e-9, 'limit at the zone')
  // price reaches 0.20 → dry fill
  r = run(r.state, 0.2, T0 + 7 * H4)
  assert.ok(r.state.zonesDone[0])
  near(r.state.virtual.doge, 79660, 1, 'kept 40%')
  near(r.state.virtual.usd, 119490 * 0.2 * (1 - 0.0045), 1, 'cash after zone 1')
  const r2 = run(r.state, 0.2, T0 + 8 * H4)
  const st2 = r2.state.orders.stop
  near(st2.qty, 79660, 1, 'stop now covers the remaining DOGE')
  near(st2.price, (r2.state.lock - r2.state.virtual.usd) / 79660, 1e-6, 'lock formula on new cash')
  assert.ok(st2.price < 0.14, `re-priced lower after the sale (${st2.price})`)
})

ok('lock stop hit (dry) → plan ENDS, zone cancelled, no re-entry', () => {
  const c0 = normalizeLiveConfig(cfg, T0)
  let r = run(initLiveState(c0, T0), 0.15, T0)
  r = run(r.state, 0.13, T0 + H4) // below 0.1336
  assert.equal(r.state.status, 'ended')
  near(r.state.virtual.doge, 0, 1e-6, 'all sold')
  const r2 = run(r.state, 0.2, T0 + 2 * H4)
  assert.equal(r2.intents.length, 0)
  assert.ok(r2.snapshot.flags.some((f) => f.code === 'ended'))
})

ok('kill switch: cancels resting bot orders, places nothing', () => {
  const c0 = normalizeLiveConfig(cfg, T0)
  let r = run(initLiveState(c0, T0), 0.15, T0)
  r = stepDogeLive({ config: c0, state: r.state, mode: 'dry', market: mkt(T0 + H4, 0.16), nowMs: T0 + H4, killSwitch: true })
  assert.deepEqual(r.intents.map((i) => i.action), ['cancel'])
})

ok('daily action cap (cancels still pass)', () => {
  const c0 = normalizeLiveConfig({ ...cfg, dailyActionCap: 1 }, T0)
  let r = run(initLiveState(c0, T0), 0.15, T0, { config: { dailyActionCap: 1 } })
  for (let i = 1; i <= 3; i++) r = run(r.state, 0.15 + i * 0.01, T0 + i * 600000, { config: { dailyActionCap: 1 } })
  assert.ok(r.snapshot.flags.some((f) => f.code === 'daily_cap'))
})

ok('pot: breakout (close > 20d high, > SMA50, BTC > SMA50) → one IOC buy; pot stop on pot DOGE only, 4h-high − 3×ATR, ratchets', () => {
  const c0 = normalizeLiveConfig({ startValue: 19000, startDoge: 110000, startUsd: 9000, potUsd: 9000 }, T0)
  const daily = dailyBars(T0, { base: 0.09, lastClose: 0.1 })
  const sig = dailySignal({ daily, btcDaily: btc(T0), config: c0, nowMs: T0 })
  assert.ok(sig.breakout, 'fixture is a breakout')
  let st = initLiveState(c0, T0)
  let r = stepDogeLive({ config: c0, state: st, mode: 'dry', market: { ...mkt(T0, 0.1), daily }, nowMs: T0 })
  const pot = r.intents.find((i) => i.role === 'pot')
  assert.equal(pot.side, 'buy')
  assert.equal(pot.tif, 'IOC')
  assert.ok(pot.price > 0.1 && pot.price <= 0.1 * 1.005 + 1e-7, 'marketable limit, not a market order')
  near(pot.qty * pot.price * 1.004, 9000, 1, 'spends the pot incl. fee')
  dryExecute(r.state, r.intents, { config: r.config, market: mkt(T0, 0.1), nowIso: new Date(T0).toISOString() })
  assert.equal(r.state.pot.status, 'held')
  // same day: no second buy
  const again = stepDogeLive({ config: c0, state: r.state, mode: 'dry', market: { ...mkt(T0 + 600000, 0.1), daily }, nowMs: T0 + 600000 })
  assert.ok(!again.intents.some((i) => i.role === 'pot'))
  // next 4h bar closes higher → pot stop = hc − 3×ATR on pot qty only
  const later = T0 + 2 * H4
  const r2 = stepDogeLive({ config: c0, state: again.state, mode: 'dry', market: { ...mkt(later, 0.105), daily }, nowMs: later })
  const s = r2.intents.find((i) => i.role === 'stop')
  near(s.qty, r.state.pot.qty, 1e-6, 'pot DOGE only')
  near(s.price, 0.105 - 3 * sig.atr, 1e-6, 'hc − 3×ATR')
  assert.equal(s.kind, 'pot')
})

ok('pot buy blocked while paused (stops still allowed)', () => {
  const c0 = normalizeLiveConfig({ startValue: 19000, startDoge: 110000, startUsd: 9000, potUsd: 9000 }, T0)
  const daily = dailyBars(T0, { base: 0.09, lastClose: 0.1 })
  const r = stepDogeLive({ config: c0, state: initLiveState(c0, T0), mode: 'dry', market: { ...mkt(T0, 0.1), daily }, nowMs: T0, guard: { paused: true } })
  assert.ok(!r.intents.some((i) => i.role === 'pot'))
  assert.ok(r.snapshot.flags.some((f) => f.code === 'pot_paused'))
})

ok('trade creds: owner + env only; read-only key never used', () => {
  assert.equal(krakenTradeCredsFor({ role: 'member' }, { KRAKEN_TRADE_KEY: 'k', KRAKEN_TRADE_SECRET: 's' }), null)
  assert.equal(krakenTradeCredsFor({ role: 'owner' }, { KRAKEN_API_KEY: 'k', KRAKEN_API_SECRET: 's' }), null)
  assert.deepEqual(krakenTradeCredsFor({ role: 'owner' }, { KRAKEN_TRADE_KEY: 'k', KRAKEN_TRADE_SECRET: 's' }), { key: 'k', secret: 's' })
})
ok('balances + open order split', () => {
  const b = bookFromBalance({ XXDG: { balance: '1000.5', hold_trade: '200' }, ZUSD: { balance: '50', hold_trade: '0' }, 'XDG.F': { balance: '999' } })
  assert.equal(b.doge, 1000.5)
  assert.equal(b.usd, 50)
  assert.equal(b.dogeHold, 200)
  const sp = splitOpenOrders({ open: { A: { cl_ord_id: 'tsbs1', descr: { pair: 'XDGUSD', type: 'sell', ordertype: 'stop-loss', price: '0.1' }, vol: '10', vol_exec: '0' }, B: { descr: { pair: 'XDGUSD', type: 'sell', ordertype: 'limit', price: '0.3' }, vol: '5', vol_exec: '0' }, C: { descr: { pair: 'XBTUSD' } } } })
  assert.equal(sp.mine.length, 1)
  assert.equal(sp.others.length, 1)
})

// ------------------------------------------------------------------ live executor (mock Kraken)
function mockKraken() {
  const calls = []
  let n = 0
  const fetchImpl = async (url, init) => {
    const ep = url.split('/').pop()
    const body = JSON.parse(init.body)
    calls.push({ ep, body, headers: init.headers })
    const res = (result) => ({ ok: true, status: 200, json: async () => ({ error: [], result }) })
    if (ep === 'AddOrder') return res({ txid: [`OTX${++n}`], descr: { order: 'x' } })
    if (ep === 'AmendOrder') return res({ amend_id: 'A1' })
    if (ep === 'CancelOrder') return res({ count: 1 })
    if (ep === 'QueryOrders') return res({ [body.txid]: { status: 'closed', vol_exec: '89000', price: '0.1003' } })
    if (ep === 'OpenOrders') return res({ open: {} })
    return res({})
  }
  return { calls, fetchImpl }
}
await okA('live executor: places stop with fciq + cl_ord_id, refuses stop ≥ bid and oversell, never logs secrets', async () => {
  const k = mockKraken()
  const logEntries = []
  const trader = createKrakenTrader({ creds: { key: 'KEY123', secret: Buffer.from('s3cret').toString('base64') }, fetchImpl: k.fetchImpl, log: (e) => logEntries.push(e) })
  const c0 = normalizeLiveConfig(cfg, T0)
  const state = initLiveState(c0, T0)
  state.ordersMode = 'live'
  const logs = []
  const intents = [
    { action: 'place', role: 'stop', kind: 'lock', side: 'sell', ordertype: 'stop-loss', price: 0.2, qty: 100, usd: 0 }, // ≥ bid → refused
    { action: 'place', role: 'zone', side: 'sell', ordertype: 'limit', price: 0.3, qty: 900, index: 0 },
    { action: 'place', role: 'stop', kind: 'lock', side: 'sell', ordertype: 'stop-loss', price: 0.15, qty: 200, usd: 0 }, // 900+200 > 1000 → refused
    { action: 'place', role: 'stop', kind: 'lock', side: 'sell', ordertype: 'stop-loss', price: 0.15, qty: 100, usd: 0 },
  ]
  await executeLive({ trader, state, intents, market: { price: 0.18, bid: 0.18, ask: 0.18 }, book: { doge: 1000, usd: 0 }, killSwitch: false, config: c0, logs, nowIso: new Date(T0).toISOString() })
  assert.deepEqual(logs.map((l) => l.status), ['refused', 'placed', 'refused', 'placed'])
  const adds = k.calls.filter((c) => c.ep === 'AddOrder')
  assert.equal(adds.length, 2)
  const stop = adds[1].body
  assert.equal(stop.ordertype, 'stop-loss')
  assert.equal(stop.type, 'sell')
  assert.equal(stop.oflags, 'fciq')
  assert.equal(stop.trigger, 'last')
  assert.equal(stop.price, '0.1500000')
  assert.equal(stop.volume, '100.00000000')
  assert.ok(stop.cl_ord_id.startsWith('tsbs') && stop.cl_ord_id.length <= 18)
  assert.ok(!JSON.stringify(logEntries).includes('KEY123') && !JSON.stringify(logEntries).includes('s3cret'))
  assert.equal(state.orders.stop.id, 'OTX2')
  assert.ok(k.calls.every((c) => ['AddOrder', 'AmendOrder', 'CancelOrder', 'QueryOrders', 'OpenOrders', 'BalanceEx', 'Balance'].includes(c.ep)))
})
await okA('live executor: amend keeps txid; kill switch only lets cancels through; pot IOC fill recorded', async () => {
  const k = mockKraken()
  const trader = createKrakenTrader({ creds: { key: 'K', secret: Buffer.from('s').toString('base64') }, fetchImpl: k.fetchImpl })
  const c0 = normalizeLiveConfig({ startValue: 19000, startDoge: 110000, startUsd: 9000, potUsd: 9000 }, T0)
  const state = initLiveState(c0, T0)
  state.ordersMode = 'live'
  state.orders.stop = { kind: 'lock', side: 'sell', ordertype: 'stop-loss', price: 0.13, qty: 100, id: 'OLD1', clOrdId: 'tsbsX' }
  const logs = []
  await executeLive({ trader, state, intents: [{ action: 'amend', role: 'stop', kind: 'lock', side: 'sell', ordertype: 'stop-loss', price: 0.14, qty: 100, prev: { price: 0.13, qty: 100, id: 'OLD1' } }], market: { price: 0.18, bid: 0.18 }, book: { doge: 1000, usd: 0 }, config: c0, logs, nowIso: 'x' })
  const am = k.calls.find((c) => c.ep === 'AmendOrder').body
  assert.equal(am.txid, 'OLD1')
  assert.equal(am.trigger_price, '0.1400000')
  assert.equal(am.order_qty, undefined, 'qty unchanged → not sent')
  assert.equal(state.orders.stop.id, 'OLD1')
  const logs2 = []
  await executeLive({ trader, state, intents: [{ action: 'place', role: 'zone', side: 'sell', ordertype: 'limit', price: 0.2, qty: 10 }, { action: 'cancel', role: 'stop', prev: { id: 'OLD1', price: 0.14, qty: 100 } }], market: { price: 0.18, bid: 0.18 }, book: { doge: 1000, usd: 0 }, killSwitch: true, config: c0, logs: logs2, nowIso: 'x' })
  assert.deepEqual(logs2.map((l) => l.status), ['refused', 'cancelled'])
  const logs3 = []
  await executeLive({ trader, state, intents: [{ action: 'place', role: 'pot', side: 'buy', ordertype: 'limit', tif: 'IOC', price: 0.1005, qty: 89000 }], market: { price: 0.1, bid: 0.1, ask: 0.1 }, book: { doge: 110000, usd: 9000 }, config: c0, logs: logs3, nowIso: 'x' })
  assert.equal(state.pot.status, 'held')
  assert.equal(state.pot.qty, 89000)
  assert.equal(k.calls.filter((c) => c.ep === 'AddOrder').at(-1).body.timeinforce, 'IOC')
})

console.log(`check:doge-live OK (${n} checks; backtest: HWM 39,830→lock 33,581, 199,149 DOGE/$0 → stop $0.1686)`)
