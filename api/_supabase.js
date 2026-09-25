/**
 * Server-only Supabase helpers for Vercel functions (never imported by src/).
 * Env: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (sensitive, server-side only).
 */
import { createClient } from '@supabase/supabase-js'

let admin = null

/** Service-role client: bypasses RLS. Use only after checking who is calling. */
export function getAdminClient() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  if (!admin) {
    admin = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
  }
  return admin
}

export function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

/** JSON body for both Vercel (pre-parsed req.body) and the Vite dev middleware (raw stream). */
export async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}')
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 16 * 1024) throw new Error('Body too large')
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

/**
 * Resolve the signed-in caller from `Authorization: Bearer <access token>`.
 * Returns { user, profile } or sends 401/403 and returns null.
 *
 *   const who = await requireUser(req, res, { role: 'owner' })  // owner-only (Kraken, bot admin)
 *   const who = await requireUser(req, res, { bot: true })      // Trade Smart Bot tier
 *   if (!who) return
 */
export async function requireUser(req, res, { role, bot } = {}) {
  const sb = getAdminClient()
  if (!sb) {
    sendJson(res, 500, { error: 'Auth is not configured on the server.' })
    return null
  }
  const header = req.headers?.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!token) {
    sendJson(res, 401, { error: 'Sign in required.' })
    return null
  }
  const { data, error } = await sb.auth.getUser(token)
  if (error || !data?.user) {
    sendJson(res, 401, { error: 'Session expired. Sign in again.' })
    return null
  }
  const { data: profile } = await sb
    .from('profiles')
    .select('id, email, display_name, role, bot_access')
    .eq('id', data.user.id)
    .maybeSingle()
  if (role && profile?.role !== role) {
    sendJson(res, 403, { error: 'Not allowed.' })
    return null
  }
  if (bot && !(profile?.bot_access || profile?.role === 'owner')) {
    sendJson(res, 403, { error: 'Trade Smart Bot access required.' })
    return null
  }
  return { user: data.user, profile }
}
