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
import { notify, notifyLines } from './_notify.js'
import { coachBuyOrders } from '../shared/buyCoach.js'

const BASE = 'https://api.kraken.com'
const LEASE_MS = 120000
const ALERT_CODES = new Set(['drop_1h', 'near_stop', 'stop_crossed', 'raise_crossed', 'dry_fill', 'stopped', 'kill_switch', 'step_capped', 'daily_cap', 'pot_paused', 'pot_no_cash', 'order_gone', 'others_hold', 'no_stop_level', 'sell_below_min', 'sell_killed', 'no_trade_key'])
/** Telegram: these always go out immediately (even in quiet hours). */
export const URGENT_CODES = new Set(['drop_1h', 'near_stop', 'stop_crossed', 'dry_fill', 'stopped', 'kill_switch', 'order_gone', 'no_trade_key'])
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
  const [bars4h, daily, btcDaily, tick, pairs, bars5m] = await Promise.all([
    ohlc('XDGUSD', 240),
    ohlc('XDGUSD', 1440),
    ohlc('XBTUSD', 1440),
    pub(fetchImpl, 'Ticker?pair=XDGUSD'),
    pub(fetchImpl, 'AssetPairs?pair=XDGUSD').catch(() => null),
    ohlc('XDGUSD', 5).catch(() => []),
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
  return { price, bid: Number(t.b?.[0]) || price, ask: Number(t.a?.[0]) || price, bars4h, daily, btcDaily, bars5m, rules }
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
  // Real balances whenever a key can read them (live always; dry too, so the dry-run log shows
  // the exact orders for what he really holds). Reads only: BalanceEx / OpenOrders / QueryOrders.
  let book = null
  let othersHold = 0
  let openList = null // { userSells, botBuys } for the panel's Orders card
  let open = null
  let kraken = null
  const userBuyFills = []
  if (trader) {
    const bal = bookFromBalance(await trader.balanceEx())
    open = splitOpenOrders(await trader.openOrders())
    if (mode === 'live') {
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
          logs.push({ mode, role, action: 'fill', status: full ? 'filled' : 'partial', side: 'sell', ordertype: o.ordertype, price: fill.price, qty: exec, txid: o.id, cl_ord_id: o.clOrdId, reason: role === 'stop' ? 'bottom stop' : 'zone sale' })
        }
        if (!exec) extraFlags.push({ code: 'order_gone', message: `Bot ${role} order ${o.id} is no longer open at Kraken (${r?.status || 'unknown'}${r?.reason ? `: ${r.reason}` : ''}) and did not fill: re-placing it now` })
        if (state.orders[role]?.id === o.id) state.orders[role] = null
      }
      // orphans: our prefix, not tracked → cancel (e.g. after "Start new plan" or a crash)
      const trackedNow = new Set([state.orders.stop?.id, state.orders.zone?.id].filter(Boolean))
      for (const o of open.mine) {
        if (trackedNow.has(o.txid)) continue
        if (String(o.clOrdId || '').startsWith('tsbb')) continue // Telegram buy orders: managed by api/_dogeBuy.js
        try {
          await trader.cancel({ txid: o.txid })
          logs.push({ mode, role: 'orphan', action: 'cancel', status: 'cancelled', side: o.type, ordertype: o.ordertype, price: o.price, qty: o.vol - o.volExec, txid: o.txid, cl_ord_id: o.clOrdId, reason: 'untracked bot order' })
        } catch (e) {
          logs.push({ mode, role: 'orphan', action: 'cancel', status: 'error', txid: o.txid, reason: clip(e.message) })
        }
      }
    }
    // DOGE the bot may protect = balance − DOGE held by his OWN (non-bot) open sell orders
    const othersSell = open.others.filter((o) => o.type === 'sell').reduce((a, o) => a + (o.vol - o.volExec), 0)
    othersHold = othersSell
    if (othersSell > 0) extraFlags.push({ code: 'others_hold', message: `You have your own DOGE sell order(s) at Kraken for ${fmtQty(othersSell)} DOGE; the bot's stop covers the rest` })
    book = { doge: Math.max(0, bal.doge - othersHold), usd: bal.usd }
    openList = {
      userSells: open.others.filter((o) => o.type === 'sell').map((o) => ({ txid: o.txid, price: o.price, qty: Math.max(0, o.vol - o.volExec), ordertype: o.ordertype })),
      botBuys: open.mine.filter((o) => String(o.clOrdId || '').startsWith('tsbb')).map((o) => ({ txid: o.txid, price: o.price, qty: Math.max(0, o.vol - o.volExec), ordertype: o.ordertype })),
    }
    kraken = { doge: bal.doge, usd: bal.usd, openOrders: open.mine.length + open.others.length }

    // his own buy orders: track + detect fills (the bot never touches them)
    const prevBuys = state.userBuys || {}
    const nextBuys = {}
    for (const o of open.others.filter((x) => x.type === 'buy')) {
      const p = prevBuys[o.txid]
      nextBuys[o.txid] = { price: o.price, vol: o.vol, volExec: o.volExec, ordertype: o.ordertype, firstSeen: p?.firstSeen || nowIso, minDistPct: p?.minDistPct ?? null }
      if (p && o.volExec > (p.volExec || 0) + 1e-9) userBuyFills.push({ txid: o.txid, qty: o.volExec - (p.volExec || 0), price: o.price, partial: true })
    }
    const gone = Object.keys(prevBuys).filter((id) => !nextBuys[id])
    if (gone.length) {
      const q = await trader.queryOrders(gone).catch(() => null)
      for (const id of gone) {
        const r = q?.[id]
        const exec = Number(r?.vol_exec || 0) - (prevBuys[id].volExec || 0)
        if (exec > 1e-9) userBuyFills.push({ txid: id, qty: exec, price: Number(r.price) || prevBuys[id].price, partial: false })
      }
    }
    state.userBuys = nextBuys
    if (userBuyFills.length) {
      const all = [...(state.userFills || []), ...userBuyFills.map((f) => ({ ...f, at: nowIso }))]
      state.userFills = all.filter((f) => Date.parse(f.at) > nowMs - 3 * 86400000).slice(-10)
      for (const f of userBuyFills) logs.push({ mode, role: 'user', action: 'fill', status: 'user_buy_filled', side: 'buy', ordertype: 'limit', price: f.price, qty: f.qty, txid: f.txid, reason: 'Your own Kraken buy order filled' })
    }
  } else if (mode === 'dry') {
    const ro = krakenCredsFor(profile)
    if (ro) {
      const a = await fetchKrakenAccount(ro).catch(() => null)
      if (a?.balances) {
        const u = Number(a.balances.ZUSD || 0) + Number(a.balances.USD || 0)
        const d = dogeFromKrakenBalance(a.balances).total
        book = { doge: d, usd: Number.isFinite(u) ? u : 0 }
        kraken = { doge: d, usd: Number.isFinite(u) ? u : null, openOrders: a.dogeOpenOrders }
      }
    }
  }

  // ---------------- engine
  const step = stepDogeLive({ config, state, mode, market, book, fills: [], guard, killSwitch, rules, nowMs })
  state = step.state
  const flags = [...extraFlags, ...step.snapshot.flags, ...priceFlags({ market, stopPx: state.stopPx, status: state.status, nowMs })]

  // ---------------- execute
  if (mode === 'dry') {
    for (const r of dryExecute(state, step.intents, { config, market, nowIso, virtualBook: !book })) logs.push({ mode, ...pickLog(r) })
  } else {
    await executeLive({ trader, state, intents: step.intents, market, book: step.snapshot.book, killSwitch, config, logs, nowIso })
  }

  // ---------------- flags: log + alert only codes that are new since the last run
  const prevCodes = new Set((row.snapshot?.flags || []).map((f) => f.code))
  const fresh = flags.filter((f) => !prevCodes.has(f.code))
  for (const f of fresh) logs.push({ mode, role: 'plan', action: 'flag', status: f.code, reason: f.message })
  const alerts = []
  for (const f of fresh) {
    if (!ALERT_CODES.has(f.code)) continue
    if ((f.code === 'drop_1h' || f.code === 'near_stop') && !(await cooldownOk(sb, userId, `doge:${f.code}`, 3600000, nowMs))) continue
    alerts.push(f)
  }

  // ---------------- his buy orders: coaching (suggestions only)
  const coach = coachBuyOrders({
    orders: Object.entries(state.userBuys || {}).map(([txid, o]) => ({ txid, ...o })),
    fills: state.userFills || [],
    market,
    stopPx: state.stopPx,
    nowMs,
  })
  for (const [id, m] of Object.entries(coach.minDist)) if (state.userBuys?.[id]) state.userBuys[id].minDistPct = m
  const coachMsgs = []
  for (const m of coach.messages) if (await cooldownOk(sb, userId, `buycoach:${m.key}`, 4 * 3600000, nowMs)) coachMsgs.push(m.text)

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
    userBuys: Object.entries(state.userBuys || {}).map(([txid, o]) => ({ txid, price: o.price, qty: Math.max(0, o.vol - (o.volExec || 0)), ordertype: o.ordertype, distPct: o.price ? (market.price / o.price - 1) * 100 : null, since: o.firstSeen })),
    userSells: openList?.userSells ?? [],
    botBuys: openList?.botBuys ?? [],
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

  const tg = dogeTelegramLines({ logs, events: step.events, alerts, userBuyFills, state, snapshot, mode })
  if (tg.length) {
    const title = `DOGE stop (${mode === 'live' ? 'LIVE' : 'dry-run'})`
    await sb.from('alert_log').insert({ user_id: userId, fired_at: nowIso, kind: 'doge_live', price: market.price, title, message: clip(tg.map((l) => l.text).join(' · '), 1000) })
    await notifyLines(sb, { userId, chatId: profile.telegram_chat_id, title, lines: tg, nowMs }).catch(() => null)
  }
  if (coachMsgs.length) {
    await sb.from('alert_log').insert({ user_id: userId, fired_at: nowIso, kind: 'doge_buy_coach', price: market.price, title: 'Your DOGE buy orders', message: clip(coachMsgs.join(' · '), 1000) })
    for (const m of coachMsgs) await notify(sb, { userId, chatId: profile.telegram_chat_id, text: m, nowMs }).catch(() => null)
  }

  const up = await sb
    .from('doge_live_plans')
    .update({ state, snapshot, status: state.status, last_run_at: nowIso, last_error: null, lease_until: null, updated_at: nowIso })
    .eq('user_id', userId)
  if (up.error) throw new Error(`save: ${up.error.message}`)
  return { userId, mode, intents: step.intents.length, logs: logs.length, status: state.status }
}

/** Urgent price conditions: DOGE −8% within 1h (5-min candles), price within 1% of the stop. */
export function priceFlags({ market, stopPx, status = 'active', nowMs = Date.now() }) {
  const out = []
  const p = Number(market?.price)
  if (!(p > 0)) return out
  const recent = (market.bars5m || []).filter((b) => b.t >= nowMs - 3600000)
  const hi = recent.length ? Math.max(...recent.map((b) => b.high)) : null
  if (hi && p <= hi * 0.92) out.push({ code: 'drop_1h', message: `🚨 DOGE fell ${((1 - p / hi) * 100).toFixed(1)}% in the last hour: ${fmtPx(hi)} → ${fmtPx(p)}${stopPx ? ` (stop ${fmtPx(stopPx)})` : ''}` })
  const s = Number(stopPx)
  if (status === 'active' && s > 0 && p > s && p <= s * 1.01) out.push({ code: 'near_stop', message: `⚠️ DOGE ${fmtPx(p)} is within 1% of your stop ${fmtPx(s)} (${((p / s - 1) * 100).toFixed(2)}% above)` })
  return out
}

/** Telegram lines for one run: stop raises, placements, resizes, fills, cancels, errors. */
export function dogeTelegramLines({ logs, events = [], alerts = [], userBuyFills = [], state, snapshot, mode }) {
  const dry = mode !== 'live'
  const out = []
  const add = (text, urgent = false) => out.push({ text, urgent })
  const replacing = alerts.some((a) => a.code === 'order_gone')
  for (const e of events) {
    if (e.type === 'raise') add(e.from == null ? `Stop set at ${fmtPx(e.to)}: ${e.reason}` : `Stop raised ${fmtPx(e.from)} → ${fmtPx(e.to)}: ${e.reason}`)
  }
  for (const l of logs) {
    const st = String(l.status || '')
    const name = l.role === 'stop' ? 'stop-loss' : l.role === 'sell' ? 'sell (IOC limit)' : l.role === 'zone' ? 'zone sell limit' : l.role === 'pot' ? 'pot buy (IOC)' : l.role
    if (l.role === 'plan' || l.role === 'user') continue
    const amt = `${fmtQty(l.qty)} DOGE`
    if (st === 'would_place' || st === 'placed') add(`${dry ? 'Would place' : '✅ Placed'} ${name} ${fmtPx(l.price)} for ${amt}`, replacing && l.role === 'stop')
    else if (st === 'would_amend' || st === 'amended') {
      const prev = l.details?.prev
      const pxMoved = prev && Math.abs(prev.price - l.price) > 1e-12
      const qtyMoved = prev && Math.abs(prev.qty - l.qty) > 1e-6
      if (l.role === 'stop' && pxMoved && !qtyMoved && events.some((e) => e.type === 'raise' && Math.abs(e.to - l.price) < 1e-12)) {
        add(dry ? '(dry-run: would move the Kraken stop order)' : '✅ Kraken stop order moved')
        continue
      }
      add(`${dry ? 'Would update' : 'Updated'} ${name}: ${pxMoved ? `${fmtPx(prev.price)} → ` : ''}${fmtPx(l.price)} for ${qtyMoved ? `${fmtQty(prev.qty)} → ` : ''}${amt}`)
    } else if (st === 'would_cancel' || st === 'cancelled') add(`${dry ? 'Would cancel' : 'Cancelled'} ${name} ${fmtPx(l.price)} (${l.reason || ''})`, l.role === 'stop')
    else if (st === 'filled' || st === 'partial') add(l.role === 'stop' ? `🛑 Bottom stop FILLED: sold ${amt} @ ~${fmtPx(l.price)}. Waiting: no re-entry.` : `${l.role} ${st}: ${l.side} ${amt} @ ${fmtPx(l.price)}`, l.side === 'sell')
    else if (st === 'dry_fill') add(`Dry-run: ${l.role} would fill ${amt} @ ${fmtPx(l.price)}`, l.side === 'sell')
    else if (['error', 'refused', 'amend_failed'].includes(st)) add(`❗ ${name} ${st}: ${l.reason || ''}`, true)
  }
  for (const f of userBuyFills) {
    const sp = snapshot?.stop
    add(`Your buy filled ${fmtQty(f.qty)} DOGE @ ${fmtPx(f.price)}. Stop now covers ${fmtQty(sp?.qty ?? 0)} DOGE at ${fmtPx(sp?.price ?? state.stopPx)}.`)
  }
  for (const a of alerts) add(a.message, URGENT_CODES.has(a.code))
  return out
}

/** Per-user notification cooldown (notify_cooldowns): true = send now (and stamps it). */
export async function cooldownOk(sb, userId, key, ms, nowMs = Date.now()) {
  const { data } = await sb.from('notify_cooldowns').select('sent_at').eq('user_id', userId).eq('key', key).maybeSingle()
  if (data?.sent_at && Date.parse(data.sent_at) > nowMs - ms) return false
  const r = await sb.from('notify_cooldowns').upsert({ user_id: userId, key, sent_at: new Date(nowMs).toISOString() })
  return !r.error
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
    if (!gate.allowed && it.role !== 'pot' && it.role !== 'sell') {
      logs.push({ ...base, status: 'refused', reason: gate.reason })
      continue
    }
    if ((it.role === 'pot' || it.role === 'sell') && killSwitch) {
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
        if (it.role === 'pot' || it.role === 'sell') {
          const q = (await trader.queryOrders([r.id]).catch(() => null))?.[r.id]
          const exec = Number(q?.vol_exec || 0)
          logs.push({ ...base, status: 'placed', txid: r.id, cl_ord_id: r.clOrdId, reason: it.reason })
          commitIntent(state, it, r)
          if (exec > 0) {
            applyFill(state, { role: it.role, side: it.side, qty: exec, price: Number(q.price) || it.price }, { config, dry: false, nowIso })
            logs.push({ ...base, action: 'fill', status: 'filled', qty: exec, price: Number(q.price) || it.price, txid: r.id })
          } else logs.push({ ...base, action: 'fill', status: 'unfilled', txid: r.id, reason: it.role === 'pot' ? 'IOC pot buy did not fill; waits for the next breakout day' : 'IOC sell did not fill (price moved); press Sell again or sell at Kraken' })
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
  const send = () =>
    it.role === 'stop'
      ? trader.addStop({ qty: it.qty, price: it.price, clOrdId })
      : it.role === 'zone'
        ? trader.addSellLimit({ qty: it.qty, price: it.price, clOrdId })
        : it.role === 'sell'
          ? trader.addSellIoc({ qty: it.qty, price: it.price, clOrdId })
          : trader.addBuyIoc({ qty: it.qty, price: it.price, clOrdId })
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
