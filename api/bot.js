/**
 * Trade Smart Bot API (watch-only; routed by vercel.json):
 *   POST /api/bot/run             pg_cron every 5 min with `x-bot-secret: <BOT_CRON_SECRET>`,
 *                                 or the owner's JWT for a manual test run.
 *   POST /api/bot/paper/restart   bot-tier user restarts their own paper test.
 *   POST /api/bot/guard/unlock    user re-authorizes their OWN TSB after a Profit lock
 *                                 (clears the lock, baseline := current book value).
 *   POST /api/bot/guard/pause     { paused: boolean } — user pauses / resumes their OWN bot.
 *   POST /api/bot/guard/max-loss  { maxLossUsd: number >= 0 } — user's OWN "willing to lose" line.
 *   POST /api/bot/stocks/refresh  bot-tier user: recompute their OWN stock stops now (after add/edit).
 *   POST /api/bot/stocks/plan     { symbol, riskUsd, side } bot-tier user: "Plan a trade" suggested sizing (nothing saved).
 *   POST /api/bot/stocks/guard/pause|max-loss|unlock  the caller's OWN stocks paper guard
 *                                 (stock_guard, separate from DOGE's bot_guard).
 * /run also runs the watch-only stock pass (api/_stockRunner.js): every 5 min in US market
 * hours + one after-close pass per trading day; outside those it is a no-op.
 * Guard routes act only on the caller's user id (from their JWT). A body/query user id
 * that isn't the caller's is refused with 403 — the owner can't change someone else's.
 *   POST /api/bot/doge-live/save      { config, startNew? } the caller's DOGE live plan (creates it)
 *   POST /api/bot/doge-live/new-plan  { confirm: 'NEW' } restart the plan state (after a lock exit)
 *   POST /api/bot/doge-live/live      { enabled, confirm: 'LIVE' } owner + trade key only
 *   POST /api/bot/doge-live/kill      { on } red kill switch: cancels bot orders, places nothing
 *   POST /api/bot/doge-live/balances  read-only Kraken balances to prefill the start (owner)
 *   POST /api/bot/doge-live/run       recompute the caller's plan now
 * Only the DOGE live plan (api/_dogeLive.js) can place Kraken orders, and only in LIVE mode
 * (trade key in env + Live switch on). Everything else here is watch-only.
 */
import { timingSafeEqual, createHash } from 'node:crypto'
import { getAdminClient, readJsonBody, requireUser, sendJson } from './_supabase.js'
import { runBot } from './_botRunner.js'
import { fetchDailyMarket, rangeFor, runStocks, symbolInfo } from './_stockRunner.js'
import { schwabHousekeeping } from './_schwabLive.js'
import { planTrade } from '../shared/stockEngine.js'
import { bookParts, initStockGuard } from '../shared/stockPaper.js'
import { fetchKrakenAccount, fetchTickerPrice, krakenCredsFor } from './_kraken.js'
import { BOT_SYMBOLS } from '../shared/botEngine.js'
import { parseMaxLoss, unlockGuard } from '../shared/guard.js'
import { paperBookValue } from '../shared/paper.js'
import { runDogeLive, fetchLiveMarket } from './_dogeLive.js'
import { tradeKeyConfigured } from './_krakenTrade.js'
import { initLiveState, normalizeLiveConfig } from '../shared/dogeLive.js'
import { dogeFromKrakenBalance } from '../shared/botEngine.js'

const SYMBOL = 'DOGE'
const GUARD_ROUTES = new Set(['guard/unlock', 'guard/pause', 'guard/max-loss'])
const LIVE_ROUTES = new Set(['doge-live/save', 'doge-live/new-plan', 'doge-live/live', 'doge-live/kill', 'doge-live/balances', 'doge-live/run'])
const STOCK_ROUTES = new Set(['stocks/refresh', 'stocks/plan', 'stocks/guard/pause', 'stocks/guard/max-loss', 'stocks/guard/unlock'])

function routeParts(req) {
  const q = req.query?.route
  const raw = Array.isArray(q) ? q.join('/') : q
  if (raw) return String(raw).split('/').filter(Boolean)
  const path = new URL(req.url || '/', 'http://localhost').pathname
  return path.replace(/^\/?(api\/)?bot\/?/, '').split('/').filter(Boolean)
}

/** Constant-time compare (hash first so lengths always match). */
function secretMatches(given) {
  const expected = process.env.BOT_CRON_SECRET
  if (!expected || !given) return false
  const a = createHash('sha256').update(String(given)).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

export default async function handler(req, res) {
  try {
    const route = routeParts(req).join('/')
    if (route !== 'run' && route !== 'paper/restart' && !GUARD_ROUTES.has(route) && !STOCK_ROUTES.has(route) && !LIVE_ROUTES.has(route)) {
      return sendJson(res, 404, { error: 'Unknown bot route.' })
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST')
      return sendJson(res, 405, { error: 'Method not allowed.' })
    }
    const sb = getAdminClient()
    if (!sb) return sendJson(res, 500, { error: 'Bot is not configured on the server.' })

    if (route === 'run') {
      const given = req.headers?.['x-bot-secret']
      let source = 'cron'
      if (given !== undefined) {
        if (!secretMatches(given)) return sendJson(res, 401, { error: 'Bad bot secret.' })
      } else {
        const who = await requireUser(req, res, { role: 'owner' })
        if (!who) return
        source = 'manual'
      }
      // DOGE and the stock pass are independent: one failing never skips the other.
      let summary = null
      let dogeError = null
      try {
        summary = await runBot(sb, { source })
      } catch (err) {
        dogeError = String(err?.message || err)
      }
      // DOGE live plan (dry-run unless trade key + Live switch); independent of the rest.
      let dogeLive = null
      try {
        dogeLive = await runDogeLive(sb, { source })
      } catch (err) {
        console.error('doge live failed', err?.message || err)
        dogeLive = { error: String(err?.message || err).slice(0, 200) }
      }
      if (summary) summary.dogeLive = dogeLive
      let stocks
      try {
        stocks = await runStocks(sb, { source })
      } catch (err) {
        console.error('stock pass failed', err?.message || err)
        stocks = { error: 'stock pass failed' }
      }
      let schwab = null
      try {
        schwab = await schwabHousekeeping(sb)
      } catch (err) {
        schwab = { error: String(err?.message || err).slice(0, 200) }
      }
      if (stocks && typeof stocks === 'object') stocks.schwab = schwab
      if (dogeError) {
        console.error('bot run failed', dogeError)
        return sendJson(res, 500, { error: 'Bot run failed.', stocks })
      }
      return sendJson(res, 200, { ok: true, ...summary, stocks })
    }

    if (STOCK_ROUTES.has(route)) return await stockRoute(sb, req, res, route)
    if (LIVE_ROUTES.has(route)) return await liveRoute(sb, req, res, route)

    if (GUARD_ROUTES.has(route)) return await guardRoute(sb, req, res, route)

    // paper/restart — the caller's own book only
    const who = await requireUser(req, res, { bot: true })
    if (!who) return
    const summary = await runBot(sb, {
      source: 'paper_restart',
      userIds: [who.user.id],
      resetPaperFor: who.user.id,
    })
    if (!summary.usersProcessed) return sendJson(res, 400, { error: 'Save a plan on My Bot first.' })
    const mine = summary.results[0]
    if (mine?.error) return sendJson(res, 502, { error: 'Restart failed; try again in a minute.' })
    return sendJson(res, 200, { ok: true, ranAt: summary.ranAt, price: summary.price })
  } catch (err) {
    console.error('bot api failed', err?.message || err)
    return sendJson(res, 500, { error: 'Bot run failed.' })
  }
}

/** Stock watcher routes: always the caller's own data (bot tier). */
async function stockRoute(sb, req, res, route) {
  const who = await requireUser(req, res, { bot: true })
  if (!who) return
  let body = {}
  try {
    body = (await readJsonBody(req)) || {}
  } catch {
    return sendJson(res, 400, { error: 'Bad JSON body.' })
  }
  const target = body.userId ?? body.user_id
  if (target != null && String(target) !== who.user.id) {
    return sendJson(res, 403, { error: 'You can only refresh your own positions.' })
  }
  if (route.startsWith('stocks/guard/')) return await stockGuardRoute(sb, res, route, body, who.user.id)
  if (route === 'stocks/refresh') {
    const summary = await runStocks(sb, { source: 'manual', userIds: [who.user.id], force: true })
    return sendJson(res, 200, { ok: true, ranAt: summary.ranAt, positions: summary.positions, errors: summary.errors })
  }
  // stocks/plan
  const symbol = String(body.symbol || '').trim().toUpperCase()
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) return sendJson(res, 400, { error: 'Enter a stock symbol.' })
  const riskUsd = body.riskUsd == null || body.riskUsd === '' ? 100 : Number(body.riskUsd)
  if (!Number.isFinite(riskUsd) || riskUsd <= 0 || riskUsd > 1e7) return sendJson(res, 400, { error: 'Max loss $ must be a positive number.' })
  let market
  try {
    market = await fetchDailyMarket(symbol, rangeFor([]))
  } catch {
    return sendJson(res, 502, { error: `Couldn't load ${symbol} from Yahoo; check the symbol or try again.` })
  }
  const info = (await symbolInfo(sb, [symbol]).catch(() => new Map())).get(symbol) ?? null
  try {
    const side = body.side === 'long' ? 'long' : 'short'
    const plan = planTrade({ side, bars: market.bars, price: market.price, info, riskUsd, nowMs: Date.now() })
    return sendJson(res, 200, { ok: true, symbol, name: market.name, priceAt: market.priceAt, ...plan })
  } catch (e) {
    return sendJson(res, 400, { error: e.message })
  }
}

/** Stocks paper guard: pause / max loss / unlock on the caller's own stock_guard row. */
async function stockGuardRoute(sb, res, route, body, userId) {
  const now = new Date().toISOString()
  const { data: guard, error } = await sb.from('stock_guard').select('*').eq('user_id', userId).eq('book', 'stocks').maybeSingle()
  if (error) return sendJson(res, 500, { error: 'Could not read your stocks guard.' })
  const write = async (cols) => {
    const r = guard
      ? await sb.from('stock_guard').update({ ...cols, updated_at: now }).eq('user_id', userId).eq('book', 'stocks')
      : await sb.from('stock_guard').insert({ user_id: userId, book: 'stocks', ...initStockGuard({ nowIso: now }), ...cols, updated_at: now })
    return !r.error
  }
  if (route === 'stocks/guard/pause') {
    if (typeof body.paused !== 'boolean') return sendJson(res, 400, { error: 'Send { paused: true|false }.' })
    const ok = await write({ paused: body.paused, paused_at: body.paused ? now : null, paused_by: body.paused ? userId : null })
    return ok ? sendJson(res, 200, { ok: true, paused: body.paused }) : sendJson(res, 500, { error: 'Could not update.' })
  }
  if (route === 'stocks/guard/max-loss') {
    let maxLoss
    try {
      maxLoss = parseMaxLoss(body.maxLossUsd)
    } catch (e) {
      return sendJson(res, 400, { error: e.message })
    }
    const ok = await write({ max_loss_usd: maxLoss })
    return ok ? sendJson(res, 200, { ok: true, maxLossUsd: maxLoss }) : sendJson(res, 500, { error: 'Could not save the max loss.' })
  }
  // unlock: baseline := current book (entry basis + paper P/L now)
  if (!guard?.locked) return sendJson(res, 400, { error: 'Your stocks paper book is not locked.' })
  const [orders, active] = await Promise.all([
    sb.from('stock_paper_orders').select('*').eq('user_id', userId),
    sb.from('stock_positions').select('id').eq('user_id', userId).eq('status', 'active'),
  ])
  if (orders.error || active.error) return sendJson(res, 500, { error: 'Could not read your paper book.' })
  const parts = bookParts(orders.data, new Set(active.data.map((r) => r.id)))
  const next = unlockGuard(guard, { bookValueNow: parts.book, units: 0, price: 0, userId, nowIso: now })
  const up = await sb
    .from('stock_guard')
    .update({
      locked: false,
      lock_reason: null,
      unlocked_at: now,
      unlocked_by: userId,
      baseline_value: parts.book,
      baseline_source: 'reauthorized',
      baseline_set_at: now,
      data: { ...next.data, reauth_pnl: parts.pnl },
      updated_at: now,
    })
    .eq('user_id', userId)
    .eq('book', 'stocks')
    .eq('updated_at', guard.updated_at)
    .select('user_id')
  if (up.error) return sendJson(res, 500, { error: 'Could not unlock.' })
  if (!up.data.length) return sendJson(res, 409, { error: 'The bot just ran; try again.' })
  await sb.from('stock_alert_log').insert({
    user_id: userId,
    symbol: 'STOCKS',
    fired_at: now,
    kind: 'unlocked',
    level: parts.book,
    title: 'Stocks paper book re-authorized',
    message: `New starting amount ${parts.book.toFixed(2)} USD; it locks again if the book falls below that minus your max loss.`,
  })
  await runStocks(sb, { source: 'manual', userIds: [userId], force: true }).catch(() => null)
  return sendJson(res, 200, { ok: true, baselineValue: parts.book, maxLossUsd: Number(guard.max_loss_usd ?? 1) })
}

/** Unlock / pause / max-loss: always the caller's own guard row; service role writes. */
async function guardRoute(sb, req, res, route) {
  const who = await requireUser(req, res, { bot: true })
  if (!who) return
  const userId = who.user.id
  let body = {}
  try {
    body = (await readJsonBody(req)) || {}
  } catch {
    return sendJson(res, 400, { error: 'Bad JSON body.' })
  }
  const target = body.userId ?? body.user_id ?? req.query?.userId ?? req.query?.user_id
  if (target != null && String(target) !== userId) {
    return sendJson(res, 403, { error: 'You can only change your own bot.' })
  }
  const now = new Date().toISOString()
  const { data: guard, error } = await sb.from('bot_guard').select('*').eq('user_id', userId).eq('symbol', SYMBOL).maybeSingle()
  if (error) return sendJson(res, 500, { error: 'Could not read your bot state.' })

  if (route === 'guard/pause') {
    if (typeof body.paused !== 'boolean') return sendJson(res, 400, { error: 'Send { paused: true|false }.' })
    const cols = { paused: body.paused, paused_at: body.paused ? now : null, paused_by: body.paused ? userId : null, updated_at: now }
    const r = guard
      ? await sb.from('bot_guard').update(cols).eq('user_id', userId).eq('symbol', SYMBOL)
      : await sb.from('bot_guard').insert({ user_id: userId, symbol: SYMBOL, ...cols })
    if (r.error) return sendJson(res, 500, { error: 'Could not update the bot.' })
    return sendJson(res, 200, { ok: true, paused: body.paused })
  }

  if (route === 'guard/max-loss') {
    let maxLoss
    try {
      maxLoss = parseMaxLoss(body.maxLossUsd)
    } catch (e) {
      return sendJson(res, 400, { error: e.message })
    }
    const cols = { max_loss_usd: maxLoss, updated_at: now }
    const r = guard
      ? await sb.from('bot_guard').update(cols).eq('user_id', userId).eq('symbol', SYMBOL)
      : await sb.from('bot_guard').insert({ user_id: userId, symbol: SYMBOL, ...cols })
    if (r.error) return sendJson(res, 500, { error: 'Could not save the max loss.' })
    return sendJson(res, 200, { ok: true, maxLossUsd: maxLoss })
  }

  // guard/unlock
  if (!guard?.locked) return sendJson(res, 400, { error: 'Your bot is not locked.' })
  const { data: paper } = await sb.from('paper_state').select('*').eq('user_id', userId).eq('symbol', SYMBOL).maybeSingle()
  if (!paper) return sendJson(res, 400, { error: 'No paper book yet; wait for the next run.' })
  let price
  try {
    price = await fetchTickerPrice(BOT_SYMBOLS[SYMBOL].pair)
  } catch {
    return sendJson(res, 502, { error: 'Could not get a live price; try again in a minute.' })
  }
  const book = paperBookValue(paper, price)
  const units = Number(paper.core_units) + Number(paper.slice_units)
  const next = unlockGuard(guard, { bookValueNow: book, units, price, userId, nowIso: now })
  const up = await sb
    .from('bot_guard')
    .update({
      locked: false,
      lock_reason: null,
      unlocked_at: now,
      unlocked_by: userId,
      baseline_value: next.baseline_value,
      baseline_shares: next.baseline_shares,
      baseline_avg_cost: next.baseline_avg_cost,
      baseline_source: next.baseline_source,
      baseline_set_at: now,
      data: next.data,
      updated_at: now,
    })
    .eq('user_id', userId)
    .eq('symbol', SYMBOL)
    .eq('updated_at', guard.updated_at)
    .select('user_id')
  if (up.error) return sendJson(res, 500, { error: 'Could not unlock.' })
  if (!up.data.length) return sendJson(res, 409, { error: 'The bot just ran; try again.' })
  await sb.from('alert_log').insert({
    user_id: userId,
    fired_at: now,
    kind: 'unlocked',
    level: book,
    price,
    title: 'TSB re-authorized',
    message: `You unlocked TSB. New starting amount ${book.toFixed(2)} USD; it locks again if the book falls below that minus your max loss.`,
  })
  return sendJson(res, 200, { ok: true, baselineValue: book, price, maxLossUsd: Number(guard.max_loss_usd ?? 1) })
}


/** DOGE live plan routes: always the caller's own plan; writes via service role. */
async function liveRoute(sb, req, res, route) {
  const who = await requireUser(req, res, { bot: true })
  if (!who) return
  const userId = who.user.id
  let body = {}
  try {
    body = (await readJsonBody(req)) || {}
  } catch {
    return sendJson(res, 400, { error: 'Bad JSON body.' })
  }
  const target = body.userId ?? body.user_id
  if (target != null && String(target) !== userId) return sendJson(res, 403, { error: 'You can only change your own plan.' })
  const now = new Date()
  const nowIso = now.toISOString()
  const { data: row, error } = await sb.from('doge_live_plans').select('*').eq('user_id', userId).maybeSingle()
  if (error) return sendJson(res, 500, { error: 'Could not read your plan.' })
  const isOwner = who.profile?.role === 'owner'
  const log = (fields) => sb.from('doge_live_log').insert({ user_id: userId, plan_id: row?.state?.planId ?? null, at: nowIso, mode: row?.live_enabled && isOwner && tradeKeyConfigured() ? 'live' : 'dry', role: 'plan', ...fields })
  const rerun = async () => {
    const r = await runDogeLive(sb, { source: 'manual', userIds: [userId] }).catch((e) => ({ error: e.message }))
    const { data } = await sb.from('doge_live_plans').select('snapshot, status, live_enabled, kill_switch, config').eq('user_id', userId).maybeSingle()
    return { run: r?.results?.[0] ?? r, plan: data }
  }

  if (route === 'doge-live/balances') {
    const ro = krakenCredsFor(who.profile)
    if (!ro) return sendJson(res, 400, { error: 'No Kraken key is linked to your account.' })
    const [a, m] = await Promise.all([fetchKrakenAccount(ro), fetchLiveMarket().catch(() => null)])
    if (!a.balances) return sendJson(res, 502, { error: 'Kraken balance unavailable; try again.' })
    const doge = dogeFromKrakenBalance(a.balances).total
    const usd = Number(a.balances.ZUSD || 0) + Number(a.balances.USD || 0)
    const price = m?.price ?? null
    return sendJson(res, 200, { ok: true, doge, usd, price, value: price ? doge * price + usd : null })
  }

  if (route === 'doge-live/save') {
    let config
    try {
      config = normalizeLiveConfig(body.config || {}, now.getTime())
    } catch (e) {
      return sendJson(res, 400, { error: e.message })
    }
    if (!(config.startValue > 0)) return sendJson(res, 400, { error: 'Start value must be positive.' })
    const fresh = !row || body.startNew === true || row.status === 'ended'
    const state = fresh ? initLiveState(config, now.getTime()) : { ...row.state, zonesDone: config.zones.map((_, i) => Boolean(row.state?.zonesDone?.[i])) }
    if (!fresh && state) state.hwm = Math.max(Number(state.hwm) || 0, config.startValue)
    const cols = { config, state, status: 'active', updated_at: nowIso }
    const r = row ? await sb.from('doge_live_plans').update(cols).eq('user_id', userId) : await sb.from('doge_live_plans').insert({ user_id: userId, ...cols })
    if (r.error) return sendJson(res, 500, { error: 'Could not save the plan.' })
    await log({ action: 'config', status: fresh ? 'plan_started' : 'config_saved', reason: `Start $${config.startValue} on ${config.startDate}: ${config.startDoge} DOGE + $${config.startUsd}; pot $${config.potUsd}; zones ${config.zones.map((z) => `$${z.price}→${z.keepPct}%`).join(', ')}`, details: { config } })
    return sendJson(res, 200, { ok: true, ...(await rerun()) })
  }

  if (!row) return sendJson(res, 400, { error: 'Save a plan first.' })

  if (route === 'doge-live/new-plan') {
    if (body.confirm !== 'NEW') return sendJson(res, 400, { error: 'Confirm with { confirm: "NEW" }.' })
    const config = normalizeLiveConfig(row.config, now.getTime())
    const prev = row.state || {}
    // keep the real resting order ids so the next run cancels them as untracked bot orders
    const state = initLiveState(config, now.getTime())
    const r = await sb.from('doge_live_plans').update({ state, status: 'active', updated_at: nowIso }).eq('user_id', userId)
    if (r.error) return sendJson(res, 500, { error: 'Could not start a new plan.' })
    await log({ action: 'config', status: 'plan_restarted', reason: `New plan (previous ${prev.planId || '—'} ${prev.status || ''})` })
    return sendJson(res, 200, { ok: true, ...(await rerun()) })
  }

  if (route === 'doge-live/kill') {
    if (typeof body.on !== 'boolean') return sendJson(res, 400, { error: 'Send { on: true|false }.' })
    const r = await sb.from('doge_live_plans').update({ kill_switch: body.on, kill_switch_at: body.on ? nowIso : null, updated_at: nowIso }).eq('user_id', userId)
    if (r.error) return sendJson(res, 500, { error: 'Could not update.' })
    await log({ action: 'kill', status: body.on ? 'kill_on' : 'kill_off', reason: body.on ? 'Kill switch ON: cancel bot orders, place nothing' : 'Kill switch off' })
    return sendJson(res, 200, { ok: true, ...(await rerun()) })
  }

  if (route === 'doge-live/live') {
    if (typeof body.enabled !== 'boolean') return sendJson(res, 400, { error: 'Send { enabled: true|false }.' })
    if (body.enabled) {
      if (body.confirm !== 'LIVE') return sendJson(res, 400, { error: 'Confirm with { confirm: "LIVE" }.' })
      if (!isOwner) return sendJson(res, 403, { error: 'Live orders are only available on the owner account.' })
      if (!tradeKeyConfigured()) return sendJson(res, 400, { error: 'No Kraken trade key configured (KRAKEN_TRADE_KEY / KRAKEN_TRADE_SECRET). Staying in dry-run.' })
    }
    const r = await sb.from('doge_live_plans').update({ live_enabled: body.enabled, live_enabled_at: body.enabled ? nowIso : null, updated_at: nowIso }).eq('user_id', userId)
    if (r.error) return sendJson(res, 500, { error: 'Could not update.' })
    await log({ action: 'live', status: body.enabled ? 'live_on' : 'live_off', reason: body.enabled ? 'Live switch ON' : 'Live switch off (bot orders cancelled; back to dry-run)' })
    return sendJson(res, 200, { ok: true, ...(await rerun()) })
  }

  // doge-live/run
  return sendJson(res, 200, { ok: true, ...(await rerun()) })
}
