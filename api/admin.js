/**
 * Owner-only admin API (one function, routed by vercel.json):
 *   GET    /api/admin/users              all accounts + profile / tier / redeemed key
 *   PATCH  /api/admin/users/:id          { bot_access: boolean }
 *   DELETE /api/admin/users/:id          { confirmEmail }  deletes the auth user (rows cascade)
 *   GET    /api/admin/system             counts, project, deploy, Kraken keys present (yes/no)
 *
 * Every request verifies the caller's Supabase JWT and profiles.role = 'owner'
 * before the service key is used. Passwords are never read or returned
 * (Supabase Auth stores only bcrypt hashes).
 */
import { getAdminClient, readJsonBody, requireUser, sendJson } from './_supabase.js'

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

async function listUsers(sb, res) {
  const [authUsers, profiles, redemptions] = await Promise.all([
    listAllAuthUsers(sb),
    sb.from('profiles').select('id, email, display_name, role, bot_access'),
    sb.from('access_key_redemptions').select('code, user_id, redeemed_at').order('redeemed_at'),
  ])
  if (profiles.error || redemptions.error) throw profiles.error || redemptions.error
  const byId = new Map(profiles.data.map((p) => [p.id, p]))
  const keysBy = new Map()
  for (const r of redemptions.data) {
    keysBy.set(r.user_id, [...(keysBy.get(r.user_id) || []), r.code])
  }
  const users = authUsers
    .map((u) => {
      const p = byId.get(u.id) || {}
      const role = p.role || 'member'
      return {
        id: u.id,
        email: u.email,
        displayName: p.display_name || u.user_metadata?.display_name || '',
        createdAt: u.created_at,
        lastSignInAt: u.last_sign_in_at || null,
        role,
        botAccess: role === 'owner' || Boolean(p.bot_access),
        keys: keysBy.get(u.id) || [],
      }
    })
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
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
  const [users, botUsers, owners, activeKeys, flags] = await Promise.all([
    count(sb.from('profiles').select('id', { count: 'exact', head: true })),
    count(sb.from('profiles').select('id', { count: 'exact', head: true }).or('bot_access.eq.true,role.eq.owner')),
    count(sb.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'owner')),
    count(sb.from('access_keys').select('code', { count: 'exact', head: true }).eq('active', true)),
    count(sb.from('feature_flags').select('key', { count: 'exact', head: true })),
  ])
  let ref = null
  try {
    ref = new URL(process.env.SUPABASE_URL).hostname.split('.')[0]
  } catch {
    /* unset */
  }
  return sendJson(res, 200, {
    counts: { users, botUsers, owners, activeKeys, flags },
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
    bot: { lastRun: null, status: 'not running yet' },
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
