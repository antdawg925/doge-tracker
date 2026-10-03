/**
 * DOGE live plan runner (server). Called from /api/bot/run every 5 min (after the watch-only
 * DOGE bot) and from the /api/bot/doge-live/* routes.
 *
 * DRY-RUN unless ALL of: a trade key in env (KRAKEN_TRADE_KEY/SECRET, owner only), the plan's
 * Live switch on. Dry-run keeps a virtual book (start DOGE + start USD + simulated fills) and
 * logs every order it would place / amend / cancel; it never calls a Kraken trading endpoint.
 *
 * LIVE: reconcile (BalanceEx, OpenOrders, QueryOrders for fills) → shared/dogeLive.js step →
 * execute intents in safe order (shrink/cancel before grow/place) with re-checks right before
 * each call (stop below the bid, sell quantities ≤ DOGE available to the bot, kill switch),
 * idempotent client order ids (timeouts are resolved by looking the cl_ord_id up), and every
 * request summarized into doge_live_log (no secrets). Errors never crash the cron.
 */
import { applyFill, commitIntent, dryExecute, initLiveState, KRAKEN_XDGUSD, normalizeLiveConfig, stepDogeLive, fmtPx, fmtQty } from '../shared/dogeLive.js'
import { normalizeKrakenOhlc, pickKrakenPairRows } from '../shared/kraken.js'
import { dogeFromKrakenBalance } from '../shared/botEngine.js'
import { liveOrderCheck } from '../shared/guard.js'
import { bookFromBalance, createKrakenTrader, krakenTradeCredsFor, newClOrdId, splitOpenOrders, tradeKeyConfigured } from './_krakenTrade.js'
import { fetchKrakenAccount, krakenCredsFor } from './_kraken.js'
import { sendTelegram } from './_telegram.js'

const BASE = 'https://api.kraken.com'
const LEASE_MS = 120000
const ALERT_CODES = new Set(['stop_crossed', 'dry_fill', 'ended', 'kill_switch', 'step_capped', 'daily_cap', 'below_min', 'pot_paused', 'pot_no_cash', 'order_gone', 'others_hold'])
const clip = (s, n = 400) => (s == null ? null : String(s).slice(0, n))

async function pub(fetchImpl, path) {
  const r = await fetchImpl(`${BASE}/0/public/${path}`, { signal: AbortSignal.timeout(10000) })
  if (!r.ok) throw new Error(`Kraken HTTP ${r.status}`)
  const j = await r.json()
  if (j.error?.length) throw new Error(`Kraken: ${j.error.join(', ')}`)
  return j.result
}

/** Everything the plan needs from Kraken public data, in one go. */
export async function fetchLiveMarket(fetchImpl = fetch) {
  const ohlc = (pair, i) => pub(fetchImpl, `OHLC?pair=${pair}&interval=${i}`).then((r) => normalizeKrakenOhlc(pickKrakenPairRows(r)))
  const [bars4h, daily, btcDaily, tick, pairs] = await Promise.all([
    ohlc('XDGUSD', 240),
    ohlc('XDGUSD', 1440),
    ohlc('XBTUSD', 1440),
    pub(fetchImpl, 'Ticker?pair=XDGUSD'),
    pub(fetchImpl, 'AssetPairs?pair=XDGUSD').catch(() => null),
  ])
  const t = Object.values(tick || {})[0] || {}
  const price = Number(t.c?.[0])
  if (!Number.isFinite(price) || bars4h.length < 20 || daily.length < 60) throw new Error('Kraken market data incomplete')
  const ap = pairs ? Object.values(pairs)[0] : null
  const rules = ap
    ? {
        ...KRAKEN_XDGUSD,
        priceDecimals: Number(ap.pair_decimals) || KRAKEN_XDGUSD.priceDecimals,
        volumeDecimals: Number(ap.lot_decimals) || KRAKEN_XDGUSD.volumeDecimals,
        orderMin: Number(ap.ordermin) || KRAKEN_XDGUSD.orderMin,
        costMin: Number(ap.costmin) || KRAKEN_XDGUSD.costMin,
        status: ap.status,
      }
    : { ...KRAKEN_XDGUSD }
  return { price, bid: Number(t.b?.[0]) || price, ask: Number(t.a?.[0]) || price, bars4h, daily, btcDaily, rules }
}

/**
 * @param opts.userIds   limit to these users (route actions)
 * @param opts.fetchImpl injectable (tests mock Kraken)
 * @param opts.env       injectable env (tests)
 */
export async function runDogeLive(sb, { source = 'cron', userIds = null, nowMs = Date.now(), fetchImpl = fetch, env = process.env, market: marketIn = null } = {}) {
  let q = sb.from('doge_live_plans').select('*')
  if (userIds?.length) q = q.in('user_id', userIds)
  const { data: plans, error } = await q
  if (error) throw new Error(`doge_live_plans: ${error.message}`)
  if (!plans?.length) return { plans: 0 }
  const ids = plans.map((p) => p.user_id)
  const [{ data: profiles }, { data: guards }] = await Promise.all([
    sb.from('profiles').select('id, role, bot_access, telegram_chat_id').in('id', ids),
    sb.from('bot_guard').select('user_id, paused, locked').in('user_id', ids).eq('symbol', 'DOGE'),
  ])
  const profBy = new Map((profiles || []).map((p) => [p.id, p]))
  const guardBy = new Map((guards || []).map((g) => [g.user_id, g]))
  let market = marketIn
  let marketError = null
  if (!market) {
    try {
      market = await fetchLiveMarket(fetchImpl)
    } catch (e) {
      marketError = String(e?.message || e)
    }
  }
  const out = []
  for (const row of plans) {
    const profile = profBy.get(row.user_id)
    if (!profile || !(profile.bot_access || profile.role === 'owner')) continue
    try {
      out.push(await runPlan(sb, { row, profile, guard: guardBy.get(row.user_id) || null, market, marketError, nowMs, fetchImpl, env, source }))
    } catch (e) {
      const msg = clip(e?.message || e, 300)
      await sb.from('doge_live_plans').update({ last_error: msg, lease_until: null }).eq('user_id', row.user_id)
      out.push({ userId: row.user_id, error: msg })
    }
  }
  return { plans: out.length, price: market?.price ?? null, marketError, results: out }
}

async function runPlan(sb, { row, profile, guard, market, marketError, nowMs, fetchImpl, env, source }) {
  const userId = row.user_id
  const nowIso = new Date(nowMs).toISOString()
  // lease: one run per plan at a time (cron + a button click can overlap)
  const lease = await sb
    .from('doge_live_plans')
    .update({ lease_until: new Date(nowMs + LEASE_MS).toISOString() })
    .eq('user_id', userId)
    .or(`lease_until.is.null,lease_until.lt.${nowIso}`)
    .select('user_id')
  if (lease.error) throw new Error(`lease: ${lease.error.message}`)
  if (!lease.data?.length) return { userId, skipped: 'busy' }

  const logs = []
  const reqs = []
  const config = normalizeLiveConfig(row.config, nowMs)
  let state = row.state ? structuredClone(row.state) : initLiveState(config, nowMs)
  const creds = krakenTradeCredsFor(profile, env)
  const mode = creds && row.live_enabled ? 'live' : 'dry'
  const killSwitch = Boolean(row.kill_switch)
  const extraFlags = []
  if (row.live_enabled && !creds) extraFlags.push({ code: 'no_trade_key', message: 'Live is on, but no Kraken trade key is configured: staying in dry-run' })

  if (!market) {
    await sb.from('doge_live_plans').update({ last_error: clip(`Market data unavailable: ${marketError}`), lease_until: null, last_run_at: nowIso }).eq('user_id', userId)
    return { userId, error: 'market' }
  }
  const rules = market.rules || KRAKEN_XDGUSD

  let trader = null
  if (creds) trader = createKrakenTrader({ creds, fetchImpl, rules, log: (e) => reqs.push({ at: new Date().toISOString(), ...e }) })

  // Leaving live (switch off) with real orders still resting → cancel them before going dry.
  if (mode === 'dry' && state.ordersMode === 'live' && trader && (state.orders.stop || state.orders.zone)) {
    for (const role of ['zone', 'stop']) {
      const o = state.orders[role]
      if (!o?.id) continue
      try {
        await trader.cancel({ txid: o.id })
        logs.push({ mode: 'live', role, action: 'cancel', status: 'cancelled', price: o.price, qty: o.qty, txid: o.id, cl_ord_id: o.clOrdId, reason: 'Live switched off' })
      } catch (e) {
        logs.push({ mode: 'live', role, action: 'cancel', status: 'error', price: o.price, qty: o.qty, txid: o.id, reason: clip(e.message) })
      }
    }
  }

  // ---------------- book + reconcile
  let book = null
  let othersHold = 0
  if (mode === 'live') {
    const bal = bookFromBalance(await trader.balanceEx())
    const open = splitOpenOrders(await trader.openOrders())
    for (const role of ['stop', 'zone']) {
      const o = state.ordersMode === 'live' ? state.orders[role] : null
      if (!o?.id) continue
      if (open.mine.some((x) => x.txid === o.id)) continue
      const r = (await trader.queryOrders([o.id]))?.[o.id]
      const exec = Number(r?.vol_exec || 0)
      const full = r?.status === 'closed'
      if (exec > 0) {
        const fill = { role, kind: o.kind, side: 'sell', qty: exec, price: Number(r.price) || o.price, full }
        applyFill(state, fill, { config, dry: false, nowIso })
        logs.push({ mode, role, action: 'fill', status: full ? 'filled' : 'partial', side: 'sell', ordertype: o.ordertype, price: fill.price, qty: exec, txid: o.id, cl_ord_id: o.clOrdId, reason: o.kind ? `${o.kind} stop` : 'zone sale' })
      }
      if (!exec) extraFlags.push({ code: 'order_gone', message: `Bot ${role} order ${o.id} is no longer open at Kraken (${r?.status || 'unknown'}) and did not fill: re-placing` })
      if (state.orders[role]?.id === o.id) state.orders[role] = null
    }
    // orphans: our prefix, not tracked → cancel (e.g. after "Start new plan" or a crash)
    const tracked = new Set([state.orders.stop?.id, state.orders.zone?.id].filter(Boolean))
    for (const o of open.mine) {
      if (tracked.has(o.txid)) continue
      try {
        await trader.cancel({ txid: o.txid })
        logs.push({ mode, role: 'orphan', action: 'cancel', status: 'cancelled', side: o.type, ordertype: o.ordertype, price: o.price, qty: o.vol - o.volExec, txid: o.txid, cl_ord_id: o.clOrdId, reason: 'untracked bot order' })
      } catch (e) {
        logs.push({ mode, role: 'orphan', action: 'cancel', status: 'error', txid: o.txid, reason: clip(e.message) })
      }
    }
    // DOGE the bot may use = balance − holds of the user's OWN (non-bot) open orders
    const mineOpenQty = open.mine.filter((o) => tracked.has(o.txid) && o.type === 'sell').reduce((a, o) => a + (o.vol - o.volExec), 0)
    othersHold = Math.max(0, bal.dogeHold - mineOpenQty)
    if (open.others.some((o) => o.type === 'sell')) extraFlags.push({ code: 'others_hold', message: `You have your own DOGE sell order(s) at Kraken holding ${fmtQty(othersHold)} DOGE; the bot protects the rest` })
    book = { doge: Math.max(0, bal.doge - othersHold), usd: bal.usd }
  }

  // ---------------- engine
  const step = stepDogeLive({ config, state, mode, market, book, fills: [], guard, killSwitch, rules, nowMs })
  state = step.state
  const flags = [...extraFlags, ...step.snapshot.flags]

  // ---------------- execute
  if (mode === 'dry') {
    for (const r of dryExecute(state, step.intents, { config, market, nowIso })) logs.push({ mode, ...pickLog(r) })
  } else {
    await executeLive({ trader, state, intents: step.intents, market, book: step.snapshot.book, killSwitch, config, logs, nowIso })
  }

  // ---------------- flags: log + alert only codes that are new since the last run
  const prevCodes = new Set((row.snapshot?.flags || []).map((f) => f.code))
  const fresh = flags.filter((f) => !prevCodes.has(f.code))
  for (const f of fresh) logs.push({ mode, role: 'plan', action: 'flag', status: f.code, reason: f.message })
  const alerts = fresh.filter((f) => ALERT_CODES.has(f.code))
  const fills = logs.filter((l) => l.action === 'fill')
  const placedLive = logs.filter((l) => l.mode === 'live' && ['placed', 'amended', 'cancelled'].includes(l.status))

  // real (read-only) Kraken balances for display while in dry-run (owner key)
  let kraken = null
  if (mode === 'dry') {
    const ro = krakenCredsFor(profile)
    if (ro) {
      const a = await fetchKrakenAccount(ro).catch(() => null)
      if (a?.balances) {
        const u = Number(a.balances.ZUSD || 0) + Number(a.balances.USD || 0)
        kraken = { doge: dogeFromKrakenBalance(a.balances).total, usd: Number.isFinite(u) ? u : null, openOrders: a.dogeOpenOrders }
      }
    }
  }

  const snapshot = {
    ...step.snapshot,
    flags,
    mode,
    source,
    tradeKey: Boolean(creds),
    tradeKeyConfigured: tradeKeyConfigured(env),
    liveEnabled: Boolean(row.live_enabled),
    killSwitch,
    orders: state.orders,
    zones: config.zones.map((z, i) => ({ ...z, done: Boolean(state.zonesDone[i]) })),
    rules: { orderMin: rules.orderMin, costMin: rules.costMin, priceDecimals: rules.priceDecimals, volumeDecimals: rules.volumeDecimals },
    kraken,
    requests: reqs.length,
  }

  if (logs.length) {
    const rowsOut = logs.map((l) => ({ user_id: userId, plan_id: state.planId, at: nowIso, details: {}, ...l }))
    if (reqs.length) rowsOut[0].details = { ...rowsOut[0].details, requests: reqs.slice(0, 30) }
    const ins = await sb.from('doge_live_log').insert(rowsOut)
    if (ins.error) flags.push({ code: 'log_error', message: clip(ins.error.message) })
  } else if (reqs.some((r) => !r.ok)) {
    await sb.from('doge_live_log').insert({ user_id: userId, plan_id: state.planId, at: nowIso, mode, role: 'plan', action: 'request', status: 'error', reason: clip(reqs.find((r) => !r.ok)?.error), details: { requests: reqs.slice(0, 30) } })
  }

  if (alerts.length || fills.length || placedLive.length) {
    const lines = [...fills.map((f) => `${f.mode === 'dry' ? 'Dry-run ' : ''}${f.role} fill: ${f.side} ${fmtQty(f.qty)} DOGE @ ${fmtPx(f.price)}`), ...placedLive.map((l) => `LIVE ${l.status} ${l.role} ${l.ordertype || ''} ${fmtQty(l.qty)} @ ${fmtPx(l.price)}`), ...alerts.map((a) => a.message)]
    await sb.from('alert_log').insert({ user_id: userId, fired_at: nowIso, kind: 'doge_live', price: market.price, title: `DOGE plan (${mode === 'live' ? 'LIVE' : 'dry-run'})`, message: clip(lines.join(' · '), 1000) })
    if (profile.telegram_chat_id) await sendTelegram(profile.telegram_chat_id, `DOGE plan (${mode === 'live' ? 'LIVE' : 'dry-run'})\n${lines.join('\n')}`).catch(() => null)
  }

  const up = await sb
    .from('doge_live_plans')
    .update({ state, snapshot, status: state.status, last_run_at: nowIso, last_error: null, lease_until: null, updated_at: nowIso })
    .eq('user_id', userId)
  if (up.error) throw new Error(`save: ${up.error.message}`)
  return { userId, mode, intents: step.intents.length, logs: logs.length, status: state.status }
}

function pickLog(r) {
  return { role: r.role, action: r.action, status: r.status, side: r.side ?? null, ordertype: r.ordertype ?? null, price: r.price ?? null, qty: r.qty ?? null, reason: clip(r.note ? `${r.reason || ''} (${r.note})` : r.reason), details: r.prev ? { prev: { price: r.prev.price, qty: r.prev.qty }, kind: r.kind ?? null } : { kind: r.kind ?? null } }
}

/** Live execution with last-moment safety checks. Never throws for a single order. */
export async function executeLive({ trader, state, intents, market, book, killSwitch, config, logs, nowIso }) {
  const bid = Number(market.bid) || Number(market.price)
  const restingSell = () => (state.orders.stop?.qty || 0) + (state.orders.zone?.qty || 0)
  for (const it of intents) {
    const base = { mode: 'live', role: it.role, action: it.action, side: it.side, ordertype: it.ordertype, price: it.price, qty: it.qty, details: { kind: it.kind, prev: it.prev ? { price: it.prev.price, qty: it.prev.qty } : null } }
    if (it.skip) {
      logs.push({ ...base, status: 'skipped', reason: it.skip })
      continue
    }
    const kind = it.action === 'cancel' ? 'cancel_stop' : it.role === 'pot' ? 'entry' : it.action === 'place' ? 'place_stop' : 'tighten_stop'
    const gate = liveOrderCheck(null, { kind, killSwitch: killSwitch && it.action !== 'cancel' })
    if (!gate.allowed && it.role !== 'pot') {
      logs.push({ ...base, status: 'refused', reason: gate.reason })
      continue
    }
    if (it.role === 'pot' && killSwitch) {
      logs.push({ ...base, status: 'refused', reason: 'kill switch' })
      continue
    }
    if (it.role === 'stop' && it.action !== 'cancel' && !(it.price < bid)) {
      logs.push({ ...base, status: 'refused', reason: `stop ${fmtPx(it.price)} not below the bid ${fmtPx(bid)}` })
      continue
    }
    if (it.side === 'sell' && it.action !== 'cancel') {
      const after = restingSell() - (state.orders[it.role]?.qty || 0) + it.qty
      if (after > book.doge + 1e-6) {
        logs.push({ ...base, status: 'refused', reason: `sell orders would total ${fmtQty(after)} > ${fmtQty(book.doge)} DOGE available` })
        continue
      }
    }
    try {
      if (it.action === 'cancel') {
        try {
          await trader.cancel({ txid: it.prev?.id, clOrdId: it.prev?.clOrdId })
        } catch (e) {
          if (!/Unknown order|EOrder:Unknown/i.test(e.message)) throw e
        }
        commitIntent(state, it)
        logs.push({ ...base, status: 'cancelled', txid: it.prev?.id, cl_ord_id: it.prev?.clOrdId, reason: it.reason })
      } else if (it.action === 'amend') {
        try {
          await trader.amend({
            txid: it.prev.id,
            qty: Math.abs(it.qty - it.prev.qty) > 1e-9 ? it.qty : null,
            triggerPrice: it.ordertype === 'stop-loss' && Math.abs(it.price - it.prev.price) > 1e-12 ? it.price : null,
            limitPrice: it.ordertype === 'limit' && Math.abs(it.price - it.prev.price) > 1e-12 ? it.price : null,
          })
          commitIntent(state, it, { at: nowIso })
          logs.push({ ...base, status: 'amended', txid: it.prev.id, cl_ord_id: it.prev.clOrdId, reason: it.reason })
        } catch (e) {
          // fallback: cancel + place (brief gap; logged)
          logs.push({ ...base, status: 'amend_failed', txid: it.prev.id, reason: clip(`${e.message}; replacing`) })
          await trader.cancel({ txid: it.prev.id }).catch(() => null)
          state.orders[it.role] = null
          const r = await place(trader, it, nowIso)
          commitIntent(state, it, r)
          logs.push({ ...base, action: 'place', status: 'placed', txid: r.id, cl_ord_id: r.clOrdId, reason: `replace: ${it.reason || ''}` })
        }
      } else {
        const r = await place(trader, it, nowIso)
        if (it.role === 'pot') {
          const q = (await trader.queryOrders([r.id]).catch(() => null))?.[r.id]
          const exec = Number(q?.vol_exec || 0)
          logs.push({ ...base, status: 'placed', txid: r.id, cl_ord_id: r.clOrdId, reason: it.reason })
          commitIntent(state, it, r)
          if (exec > 0) {
            applyFill(state, { role: 'pot', side: 'buy', qty: exec, price: Number(q.price) || it.price }, { config, dry: false, nowIso })
            logs.push({ ...base, action: 'fill', status: 'filled', qty: exec, price: Number(q.price) || it.price, txid: r.id })
          } else logs.push({ ...base, action: 'fill', status: 'unfilled', txid: r.id, reason: 'IOC pot buy did not fill; waits for the next breakout day' })
        } else {
          commitIntent(state, it, r)
          logs.push({ ...base, status: 'placed', txid: r.id, cl_ord_id: r.clOrdId, reason: it.reason })
        }
      }
    } catch (e) {
      logs.push({ ...base, status: 'error', reason: clip(e.message) })
    }
  }
}

/** AddOrder with an idempotent cl_ord_id; a timeout is resolved by looking the id up. */
async function place(trader, it, nowIso) {
  const clOrdId = newClOrdId(it.role)
  const send = () => (it.role === 'stop' ? trader.addStop({ qty: it.qty, price: it.price, clOrdId }) : it.role === 'zone' ? trader.addSellLimit({ qty: it.qty, price: it.price, clOrdId }) : trader.addBuyIoc({ qty: it.qty, price: it.price, clOrdId }))
  try {
    const r = await send()
    return { id: r?.txid?.[0] ?? null, clOrdId, at: nowIso }
  } catch (e) {
    if (!e.timeout) throw e
    const open = await trader.openOrders({ cl_ord_id: clOrdId }).catch(() => null)
    const hit = open && Object.keys(open.open || {})[0]
    if (hit) return { id: hit, clOrdId, at: nowIso }
    throw e
  }
}
