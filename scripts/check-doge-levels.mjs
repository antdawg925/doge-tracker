/**
 * Level map, level snap (default OFF), stop-coverage alerts, replace-failure alert, sell-now calc,
 * Sunday recap window. No network, no orders (Kraken is mocked).
 */
import assert from 'node:assert/strict'
import { DOGE_LEVELS, ladderInfo, ladderLine, levelSnapCandidate, sellNowCalc, coverageFlag } from '../shared/levels.js'
import { initLiveState, normalizeLiveConfig, stepDogeLive } from '../shared/dogeLive.js'
import { executeLive, URGENT_CODES } from '../api/_dogeLive.js'
import { recapWindow, weeklyRecapText } from '../api/_weeklyRecap.js'

let n = 0
const ok = async (name, fn) => {
  try {
    await fn()
    n++
  } catch (e) {
    console.error(`FAIL ${name}`)
    throw e
  }
}
const DAY = 86400000
const H4 = 4 * 3600000
const T0 = Date.UTC(2026, 9, 3, 12)
const daily = (now, base) => {
  const s = Math.floor(now / DAY) * DAY - 80 * DAY
  return Array.from({ length: 80 }, (_, i) => ({ t: s + i * DAY, open: base, high: base * 1.03, low: base * 0.97, close: base }))
}
const bars4 = (now, c) => {
  const e = Math.floor(now / H4) * H4
  return Array.from({ length: 40 }, (_, i) => ({ t: e - (40 - i) * H4, open: c, high: c, low: c, close: c }))
}
const mkt = (now, p) => ({ price: p, bid: p, ask: p, bars4h: bars4(now, p), daily: daily(now, 0.09), btcDaily: daily(now, 80000) })
const base = { bottomStop: 0.089, startValue: 19000, startDoge: 110000, startUsd: 9000 }
const book = { doge: 100000, usd: 0 }

await ok('ladder', () => {
  assert.deepEqual(DOGE_LEVELS.map((l) => l.price), [0.1, 0.14, 0.175, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.7])
  const L = ladderInfo(0.18)
  assert.equal(L.next.price, 0.2)
  assert.equal(L.below.price, 0.175)
  assert.ok(Math.abs(L.next.distPct - 11.11) < 0.01)
  assert.equal(ladderInfo(0.8).next, null)
  assert.equal(ladderInfo(0.05).below, null)
  assert.match(ladderLine(0.18), /next level \$0\.2000/)
})

await ok('snap candidate', () => {
  assert.equal(levelSnapCandidate({ bars4: [{ close: 0.21 }] }), null, 'needs 2 bars')
  const c = levelSnapCandidate({ bars4: [{ close: 0.21 }, { close: 0.205 }] })
  assert.equal(c.level, 0.2)
  assert.ok(Math.abs(c.px - 0.175 * 0.99) < 1e-12)
  assert.equal(levelSnapCandidate({ bars4: [{ close: 0.21 }, { close: 0.19 }] }).level, 0.175, 'one bar back under → lower reclaim')
  assert.equal(levelSnapCandidate({ bars4: [{ close: 0.12 }, { close: 0.12 }] }), null, 'only $0.10 reclaimed → nothing below it')
})

await ok('level snap default OFF: engine unchanged', () => {
  assert.equal(normalizeLiveConfig({}).levelSnap, false)
  const c = { ...base, trailEnabled: false }
  const a = stepDogeLive({ config: c, state: initLiveState(normalizeLiveConfig(c, T0), T0), market: mkt(T0, 0.21), book, nowMs: T0 })
  assert.equal(a.state.stopPx, 0.089)
  assert.equal(a.snapshot.bottom.snapPx, null)
})

await ok('level snap ON: raises only, capped, never lowers', () => {
  const c = { ...base, trailEnabled: false, levelSnap: true }
  const a = stepDogeLive({ config: c, state: initLiveState(normalizeLiveConfig(c, T0), T0), market: mkt(T0, 0.21), book, nowMs: T0 })
  assert.ok(a.state.stopPx > 0.089 && a.state.stopPx <= 0.089 * 1.15 + 1e-9, `capped raise ${a.state.stopPx}`)
  assert.match(a.state.stopReason, /Level snap/)
  const st = { ...a.state, stopPx: 0.19 }
  const b = stepDogeLive({ config: c, state: st, market: mkt(T0 + H4, 0.21), book, nowMs: T0 + H4 })
  assert.equal(b.state.stopPx, 0.19, 'snap 0.173 must not lower 0.19')
})

await ok('coverage flags', () => {
  assert.equal(coverageFlag({ status: 'active', doge: 1000, stopOrder: { qty: 1000 } }), null)
  assert.equal(coverageFlag({ status: 'active', doge: 1000, stopOrder: null }).code, 'stop_uncovered')
  assert.equal(coverageFlag({ status: 'active', doge: 1000, stopOrder: { qty: 600 }, zoneQty: 400 }).code, 'stop_short')
  assert.equal(coverageFlag({ status: 'active', doge: 1000, stopOrder: null, killSwitch: true }), null)
  assert.equal(coverageFlag({ status: 'stopped', doge: 1000, stopOrder: null }), null)
  for (const c of ['stop_uncovered', 'stop_short', 'stop_replace_failed']) assert.ok(URGENT_CODES.has(c), c)
})

await ok('amend fails + replace fails → loud error, no resting stop', async () => {
  const trader = {
    amend: async () => { throw new Error('EOrder:Amend not allowed') },
    cancel: async () => ({}),
    addStop: async () => { throw new Error('EService:Unavailable') },
  }
  const state = { orders: { stop: { price: 0.1, qty: 1000, id: 'OLD' }, zone: null } }
  const logs = []
  const it = { action: 'amend', role: 'stop', side: 'sell', ordertype: 'stop-loss', price: 0.11, qty: 1000, prev: { price: 0.1, qty: 1000, id: 'OLD' } }
  await executeLive({ trader, state, intents: [it], market: { price: 0.12, bid: 0.12 }, book: { doge: 1000 }, killSwitch: false, config: {}, logs, nowIso: 'X' })
  assert.equal(state.orders.stop, null)
  assert.equal(state.replaceFailed.at, 'X')
  assert.ok(logs.some((l) => l.status === 'error' && /REPLACE FAILED/.test(l.reason)))
})

await ok('sell-now calc', () => {
  const c = sellNowCalc({ doge: 100000, usd: 0, bid: 0.2, sellPct: 30, feePct: 0, slipPct: 0, stopPx: 0.15 })
  assert.equal(c.sellQty, 30000)
  assert.equal(c.cashNow, 6000)
  assert.equal(c.runnerAt[0].value, 70000 * 0.3)
  assert.equal(c.runnerAt[1].total, 6000 + 70000 * 0.4)
  assert.equal(c.stopValue, 6000 + 70000 * 0.15)
  assert.equal(sellNowCalc({ doge: 0, bid: 0.2 }), null)
})

await ok('Sunday recap window (PT, daytime only)', () => {
  assert.equal(recapWindow(Date.parse('2026-10-25T18:00:00Z')), true, 'Sun 11 AM PDT')
  assert.equal(recapWindow(Date.parse('2026-10-25T04:30:00Z')), false, 'Sat 9:30 PM PDT')
  assert.equal(recapWindow(Date.parse('2026-10-26T04:30:00Z')), false, 'Sun 9:30 PM PDT')
  assert.equal(recapWindow(Date.parse('2026-10-26T18:00:00Z')), false, 'Monday')
  const t = weeklyRecapText({ state: { stopPx: 0.1, stopHist: [], umax: 100000 }, snapshot: { price: 0.12, book: { doge: 100000, usd: 0 }, stop: { qty: 100000 }, bottom: { distPct: 16.7 } }, config: { startValue: 19000 }, nowMs: T0 })
  assert.match(t, /weekly recap/)
  assert.match(t, /next level \$0\.1400/)
  assert.match(t, /covers all DOGE/)
})

console.log(`check:doge-levels OK (${n} checks)`)
