/**
 * Trade Smart Bot API (watch-only; routed by vercel.json):
 *   POST /api/bot/run             pg_cron every 5 min with `x-bot-secret: <BOT_CRON_SECRET>`,
 *                                 or the owner's JWT for a manual test run.
 *   POST /api/bot/paper/restart   bot-tier user restarts their own paper test.
 *   POST /api/bot/guard/unlock    user re-authorizes their OWN TSB after a Profit lock
 *                                 (clears the lock, baseline := current book value).
 *   POST /api/bot/guard/pause     { paused: boolean } — user pauses / resumes their OWN bot.
 *   POST /api/bot/guard/max-loss  { maxLossUsd: number >= 0 } — user's OWN "willing to lose" line.
 * Guard routes act only on the caller's user id (from their JWT). A body/query user id
 * that isn't the caller's is refused with 403 — the owner can't change someone else's.
 * No endpoint here places orders.
 */
import { timingSafeEqual, createHash } from 'node:crypto'
import { getAdminClient, readJsonBody, requireUser, sendJson } from './_supabase.js'
import { runBot } from './_botRunner.js'
import { fetchTickerPrice } from './_kraken.js'
import { BOT_SYMBOLS } from '../shared/botEngine.js'
import { parseMaxLoss, unlockGuard } from '../shared/guard.js'
import { paperBookValue } from '../shared/paper.js'

const SYMBOL = 'DOGE'
const GUARD_ROUTES = new Set(['guard/unlock', 'guard/pause', 'guard/max-loss'])

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
    if (route !== 'run' && route !== 'paper/restart' && !GUARD_ROUTES.has(route)) {
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
      const summary = await runBot(sb, { source })
      return sendJson(res, 200, { ok: true, ...summary })
    }

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

