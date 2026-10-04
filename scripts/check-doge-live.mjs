/**
 * DOGE live plan checks (no network, no orders): Round 4 math vs the backtest
 * (/workspace/doge-backtest/today_plan.txt), ratchet, caps, crossed stops, kill switch, zone
 * arming without overselling, pot breakout + pot stop, lock exit → plan ends, Kraken rounding,
 * and the live executor against a mocked Kraken.
 */
import assert from 'node:assert/strict'
import {
  dryExecute, initLiveState, lockFor, lockStopPrice, normalizeLiveConfig, potMult, priceStr, stepDogeLive, volStr,
} from '../shared/dogeLive.js'
import { createKrakenTrader, krakenTradeCredsFor, bookFromBalance, splitOpenOrders } from '../api/_krakenTrade.js'
import { executeLive, dogeTelegramLines } from '../api/_dogeLive.js'
import { coachBuyOrders } from '../shared/buyCoach.js'
import { parseCommand, parsePrice, statusText, handleUpdate, HELP } from '../api/telegram.js'
import { cryptoUncovered, krakenAlt, remindFor, stockReminderWindow } from '../api/_stopReminders.js'

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
  const pa = normalizeLiveConfig({}).trailAtr
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

// ------------------------------------------------------------------ bottom stop (dry)
const REAL = { doge: 1032.30068854, usd: 0 }
const bcfg = { bottomStop: 0.089, startValue: 19000, startDoge: 110000, startUsd: 9000 }
const cfg = bcfg
/** 4h bars at `close` but with a chosen highest close since the start */
function step(state, p, now, { book = REAL, config = {}, market = {}, kill = false } = {}) {
  const c = { ...bcfg, ...config }
  const m = { ...mkt(now, p), ...market }
  const r = stepDogeLive({ config: c, state, mode: 'dry', market: m, book, nowMs: now, killSwitch: kill })
  r.rows = dryExecute(r.state, r.intents, { config: r.config, market: m, nowIso: new Date(now).toISOString(), virtualBook: !book })
  return r
}
ok('bottom stop $0.089 on the real Kraken book: would place stop-loss 0.089 for all 1,032.3 DOGE', () => {
  const c0 = normalizeLiveConfig(bcfg, T0)
  const r = step(initLiveState(c0, T0), 0.0929, T0)
  assert.equal(r.intents.length, 1)
  const it = r.intents[0]
  assert.deepEqual([it.action, it.role, it.ordertype, it.side], ['place', 'stop', 'stop-loss', 'sell'])
  assert.equal(it.price, 0.089)
  assert.equal(volStr(it.qty), '1032.30068854')
  assert.equal(r.rows[0].status, 'would_place')
  assert.equal(r.snapshot.bookSource, 'kraken')
  // idempotent: same inputs → nothing new
  const r2 = step(r.state, 0.0929, T0 + 300000)
  assert.equal(r2.intents.length, 0)
  const lines = dogeTelegramLines({ logs: r.rows.map((x) => ({ mode: 'dry', ...x })), events: r.events, state: r.state, snapshot: r.snapshot, mode: 'dry' })
  assert.ok(lines.some((l) => l === 'Would place stop-loss $0.0890 for 1,032 DOGE'), lines.join(' | '))
})
ok('trail raises the stop (hc − 3×ATR), never lowers it; < 0.5% skipped; > 15% capped; raise at/above bid skipped', () => {
  const c0 = normalizeLiveConfig(bcfg, T0)
  let r = step(initLiveState(c0, T0), 0.0929, T0)
  const atr = r.snapshot.signal.atr
  // price runs to 0.13: trail = 0.13 − 3×ATR
  r = step(r.state, 0.13, T0 + 2 * H4)
  const trail = 0.13 - 3 * atr
  near(r.snapshot.bottom.trail, trail, 1e-9, 'trail')
  const want = Math.min(trail, 0.089 * 1.15)
  near(r.state.stopPx, want, 1e-7, 'raised (capped at +15%)')
  assert.ok(r.events.some((e) => e.type === 'raise' && e.from === 0.089))
  const am = r.intents.find((i) => i.role === 'stop')
  assert.equal(am.action, 'amend')
  // price dips: stop unchanged
  const before = r.state.stopPx
  r = step(r.state, 0.11, T0 + 3 * H4, { market: { bars4h: bars4(T0 + 3 * H4, 0.11) } })
  assert.equal(r.state.stopPx, before)
  // trail anchor stays at the 0.13 high; keeps ratcheting toward it
  for (let i = 4; i < 10; i++) r = step(r.state, 0.13, T0 + i * H4)
  near(r.state.stopPx, Math.ceil(trail * 1e7) / 1e7, 1e-7, 'reaches the trail')
  const n = r.state.stopHist.length
  r = step(r.state, 0.13, T0 + 11 * H4)
  assert.equal(r.state.stopHist.length, n, 'no churn once there')
  // a trail above the bid (sharp drop) → raise skipped, stop kept
  const st = structuredClone(r.state)
  st.hc = 0.2
  const r3 = step(st, 0.12, T0 + 12 * H4, { market: { bars4h: bars4(T0 + 12 * H4, 0.12) } })
  assert.ok(r3.snapshot.flags.some((f) => f.code === 'raise_crossed'))
  assert.equal(r3.state.stopPx, r.state.stopPx)
})
ok('lock price raises the stop for all DOGE: HWM $39,830, 199,149 DOGE + $0 → $0.1686 (via +15% steps)', () => {
  const book = { doge: 199149, usd: 0 }
  const c0 = normalizeLiveConfig({ ...bcfg, trailEnabled: false }, T0)
  let st = initLiveState(c0, T0)
  st.hwm = 39830
  let r
  for (let i = 0; i < 8; i++) {
    r = step(st, 0.2, T0 + i * 600000, { book, config: { trailEnabled: false } })
    st = r.state
  }
  near(r.state.lock, 33581, 1, 'lock')
  near(r.snapshot.bottom.lockPx, 0.1686, 0.0001, 'lock price')
  near(r.state.stopPx, 0.1686, 0.0001, 'stop reached the lock price')
  near(r.snapshot.stop.qty, 199149, 1e-6, 'covers all DOGE')
})
ok('DOGE sold → stop resizes, price never drops; his buy fills → stop grows at once', () => {
  const c0 = normalizeLiveConfig(bcfg, T0)
  let r = step(initLiveState(c0, T0), 0.0929, T0)
  r = step(r.state, 0.0929, T0 + 300000, { book: { doge: 600, usd: 40 } })
  const it = r.intents[0]
  assert.deepEqual([it.action, it.qty, it.price], ['amend', 600, 0.089])
  r = step(r.state, 0.0929, T0 + 600000, { book: { doge: 10600, usd: 0 } })
  assert.deepEqual([r.intents[0].action, r.intents[0].qty, r.intents[0].price], ['amend', 10600, 0.089])
})
ok('stop at/above the market at placement: not placed, nothing sold, loud flag', () => {
  const c0 = normalizeLiveConfig(bcfg, T0)
  const r = step(initLiveState(c0, T0), 0.0885, T0)
  assert.equal(r.intents.length, 0)
  const f = r.snapshot.flags.find((x) => x.code === 'stop_crossed')
  assert.ok(f && /NOT placed/.test(f.message))
})
ok('dry stop fill → stopped, waits (no re-entry), alerts', () => {
  const c0 = normalizeLiveConfig(bcfg, T0)
  let r = step(initLiveState(c0, T0), 0.0929, T0)
  r = step(r.state, 0.088, T0 + H4)
  assert.equal(r.state.status, 'stopped')
  assert.ok(r.events.some((e) => e.type === 'fill'))
  const r2 = step(r.state, 0.095, T0 + 2 * H4)
  assert.equal(r2.intents.length, 0)
})
ok('Sell 30% now: stop shrinks first, then one IOC sell limit; stop + sell ≤ DOGE', () => {
  const c0 = normalizeLiveConfig(bcfg, T0)
  let r = step(initLiveState(c0, T0), 0.0929, T0, { book: { doge: 10000, usd: 0 } })
  r.state.pendingSell = { pct: 30 }
  r = step(r.state, 0.0929, T0 + 300000, { book: { doge: 10000, usd: 0 } })
  assert.deepEqual(r.intents.map((i) => `${i.action}:${i.role}`), ['amend:stop', 'place:sell'])
  const [s, sell] = r.intents
  assert.equal(sell.qty, 3000)
  assert.equal(sell.tif, 'IOC')
  near(sell.price, 0.0929 * 0.995, 1e-7, 'bid − 0.5%')
  assert.equal(s.qty, 7000)
  assert.equal(s.price, 0.089, 'price unchanged')
  assert.equal(r.state.pendingSell, null)
})
ok('kill switch: cancels the stop, places nothing', () => {
  const c0 = normalizeLiveConfig(bcfg, T0)
  let r = step(initLiveState(c0, T0), 0.0929, T0)
  r = step(r.state, 0.0929, T0 + 300000, { kill: true })
  assert.deepEqual(r.intents.map((i) => i.action), ['cancel'])
})
ok('zones + pot are OFF by default (toggles kept)', () => {
  const daily = dailyBars(T0, { base: 0.09, lastClose: 0.1 })
  const c0 = normalizeLiveConfig(bcfg, T0)
  assert.equal(c0.zonesEnabled, false)
  assert.equal(c0.potEnabled, false)
  const r = step(initLiveState(c0, T0), 0.199, T0, { book: { doge: 100000, usd: 9000 }, market: { daily } })
  assert.ok(!r.intents.some((i) => i.role === 'zone' || i.role === 'pot'))
  const on = { ...bcfg, potEnabled: true, zonesEnabled: true }
  const r2 = step(initLiveState(normalizeLiveConfig(on, T0), T0), 0.1, T0, { book: { doge: 100000, usd: 9000 }, config: on, market: { daily } })
  assert.ok(r2.intents.some((i) => i.role === 'pot'))
})
ok('daily cap never blocks protective stop moves', () => {
  const c0 = normalizeLiveConfig({ ...bcfg, dailyActionCap: 1 }, T0)
  let r = step(initLiveState(c0, T0), 0.0929, T0, { config: { dailyActionCap: 1 } })
  for (let i = 1; i < 6; i++) r = step(r.state, 0.0929, T0 + i * 60000, { config: { dailyActionCap: 1 }, book: { doge: 1000 + i * 100, usd: 0 } })
  assert.equal(r.intents[0].action, 'amend')
  assert.ok(!r.intents[0].skip)
})

// ------------------------------------------------------------------ his buy orders: coaching
function coachBars(now, closes, vols) {
  const end = Math.floor(now / H4) * H4
  return closes.map((c, i) => ({ t: end - (closes.length - i) * H4, open: c * 1.002, high: c * 1.006, low: c * 0.994, close: c, volume: vols?.[i] ?? 1000 }))
}
ok('buy coach: approach / missed (too low) / falling in on heavy volume (too high) / under entry', () => {
  const closes = Array.from({ length: 40 }, (_, i) => 0.095 - 0.0001 * Math.sin(i))
  let m = { price: 0.0912, bars4h: coachBars(T0, closes) }
  let c = coachBuyOrders({ orders: [{ txid: 'O1', price: 0.09, vol: 5000, volExec: 0, firstSeen: new Date(T0).toISOString() }], market: m, nowMs: T0 })
  assert.ok(c.messages.some((x) => x.condition === 'approach' && /\+1\.3%/.test(x.text) && /vol .*avg/.test(x.text)), JSON.stringify(c.messages))
  // came within 0.5% then ran +4% without filling
  c = coachBuyOrders({ orders: [{ txid: 'O1', price: 0.09, vol: 5000, volExec: 0, minDistPct: 0.5, firstSeen: new Date(T0 - 10 * H4).toISOString() }], market: { price: 0.0936, bars4h: coachBars(T0, closes) }, nowMs: T0 })
  assert.ok(c.messages.some((x) => x.condition === 'too_low'))
  // heavy red volume into the order, swing support well below
  const cl2 = [...Array.from({ length: 30 }, (_, i) => 0.09 + 0.004 * Math.sin(i / 2)), 0.087, 0.086, 0.088, 0.093, 0.095, 0.096, 0.094, 0.093, 0.092, 0.0915]
  const vols = cl2.map((_, i) => (i === cl2.length - 1 ? 4000 : 1000))
  const bars = coachBars(T0, cl2, vols)
  bars[bars.length - 1] = { ...bars[bars.length - 1], open: 0.093, close: 0.0915 }
  c = coachBuyOrders({ orders: [{ txid: 'O2', price: 0.0905, vol: 5000, volExec: 0, firstSeen: new Date(T0).toISOString() }], market: { price: 0.0915, bars4h: bars }, nowMs: T0 })
  assert.ok(c.messages.some((x) => x.condition === 'too_high' && /Consider lowering/.test(x.text)), JSON.stringify(c.messages.map((x) => x.condition)))
  c = coachBuyOrders({ orders: [], fills: [{ txid: 'F1', qty: 5000, price: 0.093, at: new Date(T0).toISOString() }], market: m, stopPx: 0.089, nowMs: T0 })
  assert.ok(c.messages.some((x) => x.condition === 'under_entry' && /Bottom stop \$0\.0890 is 2\.5% below/.test(x.text)), JSON.stringify(c.messages))
})

// ------------------------------------------------------------------ missing-stop reminders
ok('missing-stop reminders: Kraken assets, coverage, $50 floor, TSLA off by default, session windows', () => {
  assert.equal(krakenAlt('XXDG'), 'XDG')
  assert.equal(krakenAlt('XXBT'), 'XBT')
  assert.equal(krakenAlt('SOL'), 'SOL')
  assert.equal(krakenAlt('DOT.S'), null)
  const u = cryptoUncovered({
    balances: { XXDG: '1032.3', XXBT: '0.0001', ZUSD: '20', SOL: '2' },
    prices: { XDG: 0.093, XBT: 84000, SOL: 150 },
    openOrders: { A: { descr: { pair: 'SOLUSD', type: 'sell', ordertype: 'stop-loss' }, vol: '2', vol_exec: '0' } },
  })
  assert.deepEqual(u.map((x) => x.name), ['DOGE'])
  near(u[0].value, 96, 0.1, 'DOGE value')
  assert.equal(remindFor(new Map(), 'TSLA'), false)
  assert.equal(remindFor(new Map([['TSLA', true]]), 'TSLA'), true)
  assert.equal(remindFor(new Map(), 'SPY'), true)
  assert.equal(stockReminderWindow(Date.UTC(2026, 9, 5, 14, 0)), 'session') // Mon 10:00 ET
  assert.equal(stockReminderWindow(Date.UTC(2026, 9, 5, 13, 16)), 'preopen') // 9:16 ET
  assert.equal(stockReminderWindow(Date.UTC(2026, 9, 5, 21, 0)), null) // 17:00 ET
  assert.equal(stockReminderWindow(Date.UTC(2026, 9, 3, 15, 0)), null) // Saturday
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

await okA('live executor: Sell now = IOC sell limit with fciq, fill recorded; refused under kill switch', async () => {
  const k = mockKraken()
  const trader = createKrakenTrader({ creds: { key: 'K', secret: Buffer.from('s').toString('base64') }, fetchImpl: k.fetchImpl })
  const c0 = normalizeLiveConfig(bcfg, T0)
  const state = initLiveState(c0, T0)
  state.ordersMode = 'live'
  state.pendingSell = { pct: 30 }
  const logs = []
  const it = { action: 'place', role: 'sell', side: 'sell', ordertype: 'limit', tif: 'IOC', price: 0.0924, qty: 300 }
  await executeLive({ trader, state, intents: [it], market: { price: 0.0929, bid: 0.0929 }, book: { doge: 1000, usd: 0 }, config: c0, logs, nowIso: 'x' })
  const add = k.calls.find((c) => c.ep === 'AddOrder').body
  assert.deepEqual([add.type, add.ordertype, add.timeinforce, add.oflags, add.price], ['sell', 'limit', 'IOC', 'fciq', '0.0924000'])
  assert.ok(logs.some((l) => l.status === 'filled'))
  assert.equal(state.pendingSell, null)
  const logs2 = []
  await executeLive({ trader, state, intents: [it], market: { price: 0.0929, bid: 0.0929 }, book: { doge: 1000, usd: 0 }, killSwitch: true, config: c0, logs: logs2, nowIso: 'x' })
  assert.equal(logs2[0].status, 'refused')
})

await okA('telegram: parse commands, ignore unknown chats silently, dedupe update_id, help/status/stop usage', async () => {
  assert.deepEqual(parseCommand('/stop .092'), { cmd: 'stop', arg: '.092' })
  assert.deepEqual(parseCommand('stop 0.092'), { cmd: 'stop', arg: '0.092' })
  assert.deepEqual(parseCommand('/stop@TradeSmartAlerts_bot 0.092'), { cmd: 'stop', arg: '0.092' })
  assert.deepEqual(parseCommand('/pause yes'), { cmd: 'pause', arg: 'yes' })
  assert.equal(parseCommand('hello'), null)
  assert.equal(parsePrice('.092'), 0.092)
  assert.equal(parsePrice('$0.0925'), 0.0925)
  assert.equal(parsePrice('abc'), null)
  const seen = new Set()
  const sent = []
  const mk = (table) => {
    const q = { _t: table, _f: {}, select: () => q, eq: (k, v) => ((q._f[k] = v), q), maybeSingle: async () => {
      if (table === 'profiles') return { data: q._f.telegram_chat_id === '8500354525' ? { id: 'U1', role: 'owner', bot_access: true, telegram_chat_id: '8500354525' } : null }
      return { data: null }
    }, insert: async (row) => {
      if (seen.has(row.update_id)) return { error: { message: 'dup' } }
      seen.add(row.update_id)
      return { error: null }
    } }
    return q
  }
  const sb = { from: mk }
  const send = async (chat, text) => sent.push({ chat, text })
  let r = await handleUpdate(sb, { update_id: 1, message: { chat: { id: 999 }, text: '/status' } }, { send })
  assert.equal(r.ignored, 'unknown chat')
  assert.equal(sent.length, 0, 'silent for strangers')
  r = await handleUpdate(sb, { update_id: 2, message: { chat: { id: 8500354525 }, text: '/help' } }, { send })
  assert.equal(r.reply, HELP)
  r = await handleUpdate(sb, { update_id: 2, message: { chat: { id: 8500354525 }, text: '/help' } }, { send })
  assert.equal(r.ignored, 'duplicate')
  r = await handleUpdate(sb, { update_id: 3, message: { chat: { id: 8500354525 }, text: '/pause' } }, { send })
  assert.ok(/pause yes/.test(r.reply) && /protective stop/.test(r.reply), 'pause asks to confirm and warns')
  r = await handleUpdate(sb, { update_id: 4, message: { chat: { id: 8500354525 }, text: '/stop abc' } }, { send })
  assert.ok(/Usage/.test(r.reply))
  const txt = statusText({ plan: { snapshot: { mode: 'dry', stop: { qty: 1032.3 }, lockActivatesAt: 28500, userBuys: [] }, state: { stopPx: 0.089, stopSetAt: '2026-10-04T01:10:01Z', stopReason: 'Bottom stop (your choice)' }, status: 'active' }, price: 0.0928 })
  assert.ok(txt.includes('Bottom stop $0.0890 (4.3% below price)') && txt.includes('Covers 1,032 DOGE') && txt.includes('dry-run'), txt)
})

console.log(`check:doge-live OK (${n} checks; bottom stop $0.089 × 1,032.3 DOGE; HWM 39,830→lock 33,581, 199,149 DOGE/$0 → stop $0.1686)`)
