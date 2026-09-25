/**
 * POST /api/signup  { email, password, inviteCode, displayName }
 *
 * Public signups are disabled in Supabase Auth; this is the only way to create an
 * account. The invite use is reserved atomically (consume_invite RPC) before the
 * user is created and given back if anything after that fails.
 */
import { getAdminClient, readJsonBody, sendJson } from './_supabase.js'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MIN_PASSWORD = 8

// Best-effort per-instance throttle (serverless instances don't share memory).
const WINDOW_MS = 10 * 60 * 1000
const MAX_ATTEMPTS = 10
const attempts = new Map()
function throttled(ip) {
  const now = Date.now()
  const hits = (attempts.get(ip) || []).filter((t) => now - t < WINDOW_MS)
  hits.push(now)
  attempts.set(ip, hits)
  return hits.length > MAX_ATTEMPTS
}

function clientIp(req) {
  const fwd = req.headers?.['x-forwarded-for']
  return (Array.isArray(fwd) ? fwd[0] : fwd || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown'
}

function inviteProblem(invite) {
  if (!invite) return 'That invite code doesn’t exist. Check it and try again.'
  if (!invite.active) return 'That invite code has been deactivated.'
  if (invite.uses >= invite.max_uses) return 'That invite code has already been used.'
  return null
}

export default async function handler(req, res) {
  try {
    return await signup(req, res)
  } catch (err) {
    console.error('signup failed', err)
    return sendJson(res, 500, { error: 'Something went wrong creating the account. Try again.' })
  }
}

async function signup(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return sendJson(res, 405, { error: 'Method not allowed.' })
  }
  const sb = getAdminClient()
  if (!sb) return sendJson(res, 500, { error: 'Signup is not configured on the server.' })
  if (throttled(clientIp(req))) {
    return sendJson(res, 429, { error: 'Too many attempts. Wait a few minutes and try again.' })
  }

  let body
  try {
    body = await readJsonBody(req)
  } catch {
    return sendJson(res, 400, { error: 'Invalid request body.' })
  }
  const email = String(body?.email || '').trim().toLowerCase()
  const password = String(body?.password || '')
  const code = String(body?.inviteCode || '').trim().toUpperCase()
  const displayName = String(body?.displayName || '').trim().slice(0, 60)

  if (!code) return sendJson(res, 400, { error: 'Enter your invite code.' })
  if (!displayName) return sendJson(res, 400, { error: 'Enter your name.' })
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return sendJson(res, 400, { error: 'Enter a valid email address.' })
  }
  if (password.length < MIN_PASSWORD || password.length > 72) {
    return sendJson(res, 400, { error: `Password must be ${MIN_PASSWORD}–72 characters.` })
  }

  // Friendly pre-check (the atomic consume below is what actually enforces it).
  const { data: invite, error: lookupErr } = await sb
    .from('invites')
    .select('code, role, active, uses, max_uses')
    .eq('code', code)
    .maybeSingle()
  if (lookupErr) return sendJson(res, 500, { error: 'Could not check the invite code. Try again.' })
  const problem = inviteProblem(invite)
  if (problem) return sendJson(res, 400, { error: problem, field: 'inviteCode' })

  const { data: consumed, error: consumeErr } = await sb.rpc('consume_invite', { p_code: code })
  if (consumeErr) return sendJson(res, 500, { error: 'Could not use the invite code. Try again.' })
  const claimed = Array.isArray(consumed) ? consumed[0] : consumed
  if (!claimed) {
    return sendJson(res, 400, { error: 'That invite code has already been used.', field: 'inviteCode' })
  }

  const release = () => sb.rpc('release_invite', { p_code: code })

  const { data: created, error: createErr } = await sb.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: displayName },
  })
  if (createErr || !created?.user) {
    await release()
    const msg = String(createErr?.message || '')
    if (/already|registered|exists/i.test(msg)) {
      return sendJson(res, 409, { error: 'An account with that email already exists. Sign in instead.', field: 'email' })
    }
    if (/password/i.test(msg)) return sendJson(res, 400, { error: msg, field: 'password' })
    return sendJson(res, 500, { error: 'Could not create the account. Try again.' })
  }

  const { error: profileErr } = await sb.from('profiles').insert({
    id: created.user.id,
    email,
    display_name: displayName,
    role: claimed.role === 'owner' ? 'owner' : 'member',
  })
  if (profileErr) {
    await sb.auth.admin.deleteUser(created.user.id)
    await release()
    return sendJson(res, 500, { error: 'Could not finish setting up the account. Try again.' })
  }

  return sendJson(res, 200, { ok: true })
}
