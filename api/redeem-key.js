/**
 * POST /api/redeem-key  { code }   (Authorization: Bearer <Supabase access token>)
 *
 * Unlocks the Trade Smart Bot tier for the signed-in user. The key is validated
 * with the service key and redeemed by the redeem_access_key() SQL function,
 * which takes one use and sets profiles.bot_access (and role 'owner' for owner
 * keys) in a single transaction.
 */
import { getAdminClient, readJsonBody, requireUser, sendJson } from './_supabase.js'

// Best-effort per-instance throttle against code guessing.
const WINDOW_MS = 10 * 60 * 1000
const MAX_ATTEMPTS = 10
const attempts = new Map()
function throttled(key) {
  const now = Date.now()
  const hits = (attempts.get(key) || []).filter((t) => now - t < WINDOW_MS)
  hits.push(now)
  attempts.set(key, hits)
  return hits.length > MAX_ATTEMPTS
}

function keyProblem(key) {
  if (!key) return 'That access key doesn’t exist. Check it and try again.'
  if (!key.active) return 'That access key has been deactivated.'
  if (key.uses >= key.max_uses) return 'That access key has already been used.'
  return null
}

export default async function handler(req, res) {
  try {
    return await redeem(req, res)
  } catch (err) {
    console.error('redeem-key failed', err)
    return sendJson(res, 500, { error: 'Something went wrong redeeming the key. Try again.' })
  }
}

async function redeem(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return sendJson(res, 405, { error: 'Method not allowed.' })
  }
  const who = await requireUser(req, res)
  if (!who) return
  if (throttled(who.user.id)) {
    return sendJson(res, 429, { error: 'Too many attempts. Wait a few minutes and try again.' })
  }

  let body
  try {
    body = await readJsonBody(req)
  } catch {
    return sendJson(res, 400, { error: 'Invalid request body.' })
  }
  const code = String(body?.code || '').trim().toUpperCase()
  if (!code) return sendJson(res, 400, { error: 'Enter your access key.' })

  const sb = getAdminClient()
  const { data: key, error: lookupErr } = await sb
    .from('access_keys')
    .select('code, role, active, uses, max_uses')
    .eq('code', code)
    .maybeSingle()
  if (lookupErr) return sendJson(res, 500, { error: 'Could not check the access key. Try again.' })
  const problem = keyProblem(key)
  if (problem) return sendJson(res, 400, { error: problem })

  const profile = who.profile
  const alreadyHas = profile?.role === 'owner' || (profile?.bot_access && key.role !== 'owner')
  if (alreadyHas) {
    // Don't burn a use on an account that's already unlocked.
    return sendJson(res, 200, { ok: true, role: profile.role, bot_access: true, already: true })
  }

  const { data, error } = await sb.rpc('redeem_access_key', { p_code: code, p_user: who.user.id })
  if (error) return sendJson(res, 500, { error: 'Could not redeem the access key. Try again.' })
  const row = Array.isArray(data) ? data[0] : data
  if (!row) return sendJson(res, 400, { error: 'That access key has already been used.' })
  return sendJson(res, 200, { ok: true, role: row.role, bot_access: row.bot_access })
}
