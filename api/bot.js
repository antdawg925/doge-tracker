/**
 * Trade Smart Bot API (watch-only; routed by vercel.json):
 *   POST /api/bot/run             pg_cron every 5 min with `x-bot-secret: <BOT_CRON_SECRET>`,
 *                                 or the owner's JWT for a manual test run.
 *   POST /api/bot/paper/restart   bot-tier user restarts their own paper test.
 * No endpoint here places orders.
 */
import { timingSafeEqual, createHash } from 'node:crypto'
import { getAdminClient, requireUser, sendJson } from './_supabase.js'
import { runBot } from './_botRunner.js'

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
    if (route !== 'run' && route !== 'paper/restart') return sendJson(res, 404, { error: 'Unknown bot route.' })
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
