/**
 * Owner-only admin API (one function, routed by vercel.json):
 *   GET    /api/admin/users              all accounts + profile / tier (pending bot requests first)
 *                                        + read-only TSB status per bot user (Live / Paused / Locked /
 *                                        No plan, book vs baseline, max loss, last run). The owner
 *                                        can't unlock / pause / edit anyone else's bot here.
 *   PATCH  /api/admin/users/:id          { bot_access: boolean }
 *   DELETE /api/admin/users/:id          { confirmEmail }  deletes the auth user (rows cascade)
 *   GET    /api/admin/system             counts, project, deploy, Kraken keys present (yes/no), bot heartbeat
 *
 * Granting bot access clears the user's request (DB trigger).
 *
 * Every request verifies the caller's Supabase JWT and profiles.role = 'owner'
 * before the service key is used. Passwords are never read or returned
 * (Supabase Auth stores only bcrypt hashes).
 */
import { getAdminClient, readJsonBody, requireUser, sendJson } from './_supabase.js'
import { paperBookValue } from '../shared/paper.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function routeParts(req) {
  const q = req.query?.route
  const raw = Array.isArray(q) ? q.join('/') : q
  if (raw) return String(raw).split('/').filter(Boolean)
  const path = new URL(req.url || '/', 'http://localhost').pathname
  return path.replace(/^\/?(api\/)?admin\/?/, '').split('/').filter(Boolean)
}

async function listAllAuthUsers(sb) {
  const users = []
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 1000 })
    if (error) throw error
    users.push(...data.users)
    if (data.users.length < 1000) break
  }
  return users
}

/** Read-only TSB status for every bot user: badge + book vs baseline + max loss + last run. */
async function botStatusByUser(sb, ids) {
  if (!ids.length) return new Map()
  const [plans, guards, papers, runs] = await Promise.all([
    sb.from('doge_plans').select('user_id').in('user_id', ids),
    sb.from('bot_guard').select('user_id, locked, lock_reason, locked_at, paused, baseline_value, max_loss_usd').eq('symbol', 'DOGE').in('user_id', ids),
    sb.from('paper_state').select('user_id, cash, core_units, slice_units').eq('symbol', 'DOGE').in('user_id', ids),
    Promise.all(
      ids.map((id) =>
        sb.from('bot_runs').select('user_id, ran_at, price').eq('user_id', id).eq('symbol', 'DOGE').neq('decision', 'error')
          .order('ran_at', { ascending: false }).limit(1).maybeSingle(),
      ),
    ),
  ])
  const hasPlan = new Set((plans.data || []).map((r) => r.user_id))
  const guardBy = new Map((guards.data || []).map((r) => [r.user_id, r]))
  const paperBy = new Map((papers.data || []).map((r) => [r.user_id, r]))
  const runBy = new Map(runs.map((r) => r.data).filter(Boolean).map((r) => [r.user_id, r]))
  const out = new Map()
  for (const id of ids) {
    const g = guardBy.get(id)
    const run = runBy.get(id)
    const book = paperBookValue(paperBy.get(id), run?.price)
    const baseline = g?.baseline_value != null ? Number(g.baseline_value) : null
    const earnings = book != null && baseline != null ? book - baseline : null
    out.set(id, {
      status: !hasPlan.has(id) ? 'no_plan' : g?.locked ? 'locked' : g?.paused ? 'paused' : 'live',
      lockReason: g?.locked ? g.lock_reason : null,
      lockedAt: g?.locked ? g.locked_at : null,
      book,
      baseline,
      earnings,
      earningsPct: earnings != null && baseline > 0 ? (earnings / baseline) * 100 : null,
      maxLossUsd: g ? Number(g.max_loss_usd) : 1,
      lastRunAt: run?.ran_at ?? null,
    })
  }
  return out
}

async function listUsers(sb, res) {
  const [authUsers, profiles] = await Promise.all([
    listAllAuthUsers(sb),
    sb.from('profiles').select('id, email, display_name, role, bot_access, bot_access_requested_at'),
  ])
  if (profiles.error) throw profiles.error
  const byId = new Map(profiles.data.map((p) => [p.id, p]))
  const botIds = profiles.data.filter((p) => p.bot_access || p.role === 'owner').map((p) => p.id)
  const tsb = await botStatusByUser(sb, botIds).catch(() => new Map())
  const users = authUsers
    .map((u) => {
      const p = byId.get(u.id) || {}
      const role = p.role || 'member'
      const botAccess = role === 'owner' || Boolean(p.bot_access)
      return {
        id: u.id,
        email: u.email,
        displayName: p.display_name || u.user_metadata?.display_name || '',
        createdAt: u.created_at,
        lastSignInAt: u.last_sign_in_at || null,
        role,
        botAccess,
        botRequestedAt: botAccess ? null : p.bot_access_requested_at || null,
        tsb: botAccess ? tsb.get(u.id) || { status: 'no_plan' } : null,
      }
    })
    // Pending requests first (oldest request on top), then newest accounts.
    .sort((a, b) => {
      if (a.botRequestedAt && b.botRequestedAt) {
        return Date.parse(a.botRequestedAt) - Date.parse(b.botRequestedAt)
      }
      if (a.botRequestedAt || b.botRequestedAt) return a.botRequestedAt ? -1 : 1
      return Date.parse(b.createdAt) - Date.parse(a.createdAt)
    })
  return sendJson(res, 200, { users })
}

async function targetProfile(sb, id) {
  const { data } = await sb.from('profiles').select('id, email, role').eq('id', id).maybeSingle()
  return data
}

async function updateUser(sb, res, who, id, req) {
  const body = await readJsonBody(req)
  if (typeof body?.bot_access !== 'boolean') {
    return sendJson(res, 400, { error: 'Send { bot_access: true|false }.' })
  }
  if (id === who.user.id) return sendJson(res, 400, { error: 'You can’t change your own account here.' })
  const target = await targetProfile(sb, id)
  if (!target) return sendJson(res, 404, { error: 'User not found.' })
  if (target.role === 'owner') return sendJson(res, 400, { error: 'Owner accounts always have bot access.' })
  const { error } = await sb.from('profiles').update({ bot_access: body.bot_access }).eq('id', id)
  if (error) return sendJson(res, 500, { error: 'Could not update the user.' })
  return sendJson(res, 200, { ok: true, id, bot_access: body.bot_access })
}

async function deleteUser(sb, res, who, id, req) {
  if (id === who.user.id) return sendJson(res, 400, { error: 'You can’t delete your own account here.' })
  const body = await readJsonBody(req)
  const { data: got, error: getErr } = await sb.auth.admin.getUserById(id)
  if (getErr || !got?.user) return sendJson(res, 404, { error: 'User not found.' })
  const email = String(got.user.email || '').toLowerCase()
  if (String(body?.confirmEmail || '').trim().toLowerCase() !== email) {
    return sendJson(res, 400, { error: 'Type the account’s email exactly to confirm.' })
  }
  const target = await targetProfile(sb, id)
  if (target?.role === 'owner') return sendJson(res, 400, { error: 'Owner accounts can’t be deleted here.' })
  const { error } = await sb.auth.admin.deleteUser(id)
  if (error) return sendJson(res, 500, { error: 'Could not delete the account.' })
  return sendJson(res, 200, { ok: true, id })
}

async function system(sb, res) {
  const count = (q) => q.then(({ count: c, error }) => (error ? null : c))
  const [users, botUsers, owners, pendingRequests, flags] = await Promise.all([
    count(sb.from('profiles').select('id', { count: 'exact', head: true })),
    count(sb.from('profiles').select('id', { count: 'exact', head: true }).or('bot_access.eq.true,role.eq.owner')),
    count(sb.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'owner')),
    count(
      sb
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .not('bot_access_requested_at', 'is', null)
        .eq('bot_access', false),
    ),
    count(sb.from('feature_flags').select('key', { count: 'exact', head: true })),
  ])
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
  const [heartbeat, errors24h, runs24h, lockedUsers, pausedUsers] = await Promise.all([
    sb.from('bot_heartbeat').select('last_run_at, last_source, users_processed, errors, duration_ms').eq('symbol', 'DOGE').maybeSingle(),
    count(sb.from('bot_runs').select('id', { count: 'exact', head: true }).gte('ran_at', since).not('error', 'is', null)),
    count(sb.from('bot_runs').select('id', { count: 'exact', head: true }).gte('ran_at', since)),
    count(sb.from('bot_guard').select('user_id', { count: 'exact', head: true }).eq('locked', true)),
    count(sb.from('bot_guard').select('user_id', { count: 'exact', head: true }).eq('paused', true)),
  ])
  const hb = heartbeat.data
  let ref = null
  try {
    ref = new URL(process.env.SUPABASE_URL).hostname.split('.')[0]
  } catch {
    /* unset */
  }
  return sendJson(res, 200, {
    counts: { users, botUsers, owners, pendingRequests, flags },
    supabase: { ref, region: process.env.SUPABASE_REGION || null },
    server: {
      env: process.env.VERCEL_ENV || 'local',
      deploymentUrl: process.env.VERCEL_URL || null,
      region: process.env.VERCEL_REGION || null,
    },
    // Presence only: no Kraken calls, no values.
    kraken: {
      keysConfigured: Boolean(process.env.KRAKEN_API_KEY && process.env.KRAKEN_API_SECRET),
    },
    bot: {
      lastRun: hb?.last_run_at ?? null,
      lastSource: hb?.last_source ?? null,
      usersProcessed: hb?.users_processed ?? null,
      lastRunErrors: hb?.errors ?? null,
      durationMs: hb?.duration_ms ?? null,
      errors24h,
      runs24h,
      lockedUsers,
      pausedUsers,
      schedule: 'every 5 min (Supabase pg_cron)',
      telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    },
  })
}

export default async function handler(req, res) {
  try {
    const who = await requireUser(req, res, { role: 'owner' })
    if (!who) return
    const sb = getAdminClient()
    const [section, id, extra] = routeParts(req)

    if (section === 'users' && !id && !extra) {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed.' })
      return await listUsers(sb, res)
    }
    if (section === 'users' && id && !extra) {
      if (!UUID_RE.test(id)) return sendJson(res, 400, { error: 'Bad user id.' })
      if (req.method === 'PATCH') return await updateUser(sb, res, who, id, req)
      if (req.method === 'DELETE') return await deleteUser(sb, res, who, id, req)
      return sendJson(res, 405, { error: 'Method not allowed.' })
    }
    if (section === 'system' && !id) {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed.' })
      return await system(sb, res)
    }
    return sendJson(res, 404, { error: 'Unknown admin route.' })
  } catch (err) {
    console.error('admin api failed', err)
    return sendJson(res, 500, { error: 'Admin request failed.' })
  }
}
