/**
 * Schwab Trader API (server only): OAuth, encrypted token storage, and the broker adapter.
 *
 * Endpoints (Schwab Trader API docs / schwab-py):
 *   authorize  https://api.schwabapi.com/v1/oauth/authorize?client_id=&redirect_uri=&response_type=code&state=
 *   token      POST https://api.schwabapi.com/v1/oauth/token  (Basic base64(key:secret), x-www-form-urlencoded)
 *              grant_type=authorization_code&code=&redirect_uri=   |   grant_type=refresh_token&refresh_token=
 *              → { access_token (30 min, expires_in 1800), refresh_token (7 days), token_type, scope, id_token }
 *   accounts   GET /trader/v1/accounts/accountNumbers → [{ accountNumber, hashValue }]
 *              GET /trader/v1/accounts/{hash}?fields=positions
 *   orders     GET /trader/v1/accounts/{hash}/orders?fromEnteredTime=&toEnteredTime=  (ISO, ≤ 60 days back)
 *              GET|DELETE /trader/v1/accounts/{hash}/orders/{orderId}
 *              POST /trader/v1/accounts/{hash}/orders        → 201, Location: …/orders/{orderId}
 *              PUT  /trader/v1/accounts/{hash}/orders/{id}   → replace (old canceled, new id in Location)
 *   quotes     GET /marketdata/v1/quotes?symbols=A,B&fields=quote
 *
 * Tokens: AES-256-GCM with SCHWAB_TOKEN_ENC_KEY (base64, 32 bytes), AAD = user id. Never logged.
 * The adapter has the same method names as the paper adapter (shared/broker/index.js); it is
 * only ever driven by api/_schwabLive.js, which gates every action through shared/guard.js.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { buildStopOrder, fillFromOrder, holdingsFromAccount, LIVE_RULES } from '../shared/schwabLive.js'

export const SCHWAB_API = 'https://api.schwabapi.com'
export const AUTHORIZE_URL = `${SCHWAB_API}/v1/oauth/authorize`
export const TOKEN_URL = `${SCHWAB_API}/v1/oauth/token`
export const DEFAULT_REDIRECT = 'https://trade-smart-app.vercel.app/api/schwab/callback'
export const STOCK_ORDERS_ENABLED = true

export const schwabConfigured = () => Boolean(process.env.SCHWAB_APP_KEY && process.env.SCHWAB_APP_SECRET && process.env.SCHWAB_TOKEN_ENC_KEY)
export const redirectUri = () => process.env.SCHWAB_REDIRECT_URI || DEFAULT_REDIRECT

// ------------------------------------------------------------ crypto
function encKey() {
  const raw = process.env.SCHWAB_TOKEN_ENC_KEY || ''
  const k = Buffer.from(raw, 'base64')
  if (k.length !== 32) throw new Error('SCHWAB_TOKEN_ENC_KEY must be 32 bytes (base64)')
  return k
}
const stateKey = () => createHash('sha256').update('tsb-schwab-oauth-state|').update(encKey()).digest()

export function encryptToken(plain, userId, key = encKey()) {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  c.setAAD(Buffer.from(String(userId)))
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()])
  return `v1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')}`
}

export function decryptToken(blob, userId, key = encKey()) {
  if (!blob || !String(blob).startsWith('v1:')) throw new Error('bad token blob')
  const buf = Buffer.from(String(blob).slice(3), 'base64')
  const d = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12))
  d.setAAD(Buffer.from(String(userId)))
  d.setAuthTag(buf.subarray(12, 28))
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8')
}

const b64u = (b) => Buffer.from(b).toString('base64url')

/** Signed OAuth state: { u: userId, n: nonce, o: origin, e: expiry ms }. */
export function signState(payload, key = stateKey()) {
  const body = b64u(JSON.stringify(payload))
  return `${body}.${b64u(createHmac('sha256', key).update(body).digest())}`
}

export function verifyState(state, { nowMs = Date.now(), key = stateKey() } = {}) {
  const [body, sig] = String(state || '').split('.')
  if (!body || !sig) return null
  const want = createHmac('sha256', key).update(body).digest()
  const got = Buffer.from(sig, 'base64url')
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null
  let p
  try {
    p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (!p?.u || !p?.n || !(p.e > nowMs)) return null
  return p
}

export const nonceHash = (n) => createHash('sha256').update(`tsb-schwab-nonce|${n}`).digest('hex')
export const newNonce = () => randomBytes(24).toString('base64url')

export function authorizeUrl(state) {
  const u = new URL(AUTHORIZE_URL)
  u.searchParams.set('client_id', process.env.SCHWAB_APP_KEY || '')
  u.searchParams.set('redirect_uri', redirectUri())
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('state', state)
  return u.toString()
}

// ------------------------------------------------------------ HTTP
export class SchwabError extends Error {
  constructor(status, message, { path = null } = {}) {
    super(message)
    this.status = status
    this.path = path
  }
}

const redactPath = (p) => String(p).replace(/\/accounts\/[^/?]+/g, '/accounts/{hash}')

async function readErr(res) {
  try {
    const t = await res.text()
    try {
      const j = JSON.parse(t)
      return String(j.message || j.error_description || j.error || j.errors?.[0]?.detail || j.errors?.[0]?.title || t).slice(0, 200)
    } catch {
      return t.slice(0, 200)
    }
  } catch {
    return ''
  }
}

/** Token endpoint call (code exchange or refresh). Returns the parsed token JSON. */
export async function tokenRequest(params, { fetchImpl = fetch } = {}) {
  const basic = Buffer.from(`${process.env.SCHWAB_APP_KEY}:${process.env.SCHWAB_APP_SECRET}`).toString('base64')
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new SchwabError(res.status, `token ${params.grant_type}: ${res.status} ${await readErr(res)}`, { path: '/v1/oauth/token' })
  const j = await res.json()
  if (!j?.access_token) throw new SchwabError(502, 'token response without access_token', { path: '/v1/oauth/token' })
  return j
}

/** Encrypted columns + expiries from a token response. refresh expiry = issue + 7 days. */
export function tokenColumns(tok, userId, { nowMs = Date.now(), refreshIssuedMs = nowMs } = {}) {
  const cols = {
    enc_access: encryptToken(tok.access_token, userId),
    access_expires_at: new Date(nowMs + (Number(tok.expires_in) || 1800) * 1000).toISOString(),
  }
  if (tok.refresh_token) {
    cols.enc_refresh = encryptToken(tok.refresh_token, userId)
    cols.refresh_expires_at = new Date(refreshIssuedMs + LIVE_RULES.refreshDays * 86400_000).toISOString()
  }
  return cols
}

/**
 * Valid access token for a broker_connections row, refreshing (and persisting) when it is
 * within 90 s of expiry. Marks the row expired when Schwab refuses the refresh token.
 */
export async function accessTokenFor(sb, conn, { nowMs = Date.now(), fetchImpl = fetch } = {}) {
  if (!(Date.parse(conn.refresh_expires_at) > nowMs)) throw new SchwabError(401, 'refresh token expired; reconnect Schwab')
  if (conn.enc_access && Date.parse(conn.access_expires_at) - nowMs > LIVE_RULES.accessSkewMs) return decryptToken(conn.enc_access, conn.user_id)
  let tok
  try {
    tok = await tokenRequest({ grant_type: 'refresh_token', refresh_token: decryptToken(conn.enc_refresh, conn.user_id) }, { fetchImpl })
  } catch (err) {
    if (err instanceof SchwabError && (err.status === 400 || err.status === 401)) {
      await sb.from('broker_connections').update({ status: 'expired', last_error: String(err.message).slice(0, 300), updated_at: new Date().toISOString() }).eq('user_id', conn.user_id).eq('broker', 'schwab')
      conn.status = 'expired'
    }
    throw err
  }
  // Keep the original 7-day refresh expiry (Schwab refresh tokens don't extend on use).
  const cols = tokenColumns({ ...tok, refresh_token: tok.refresh_token }, conn.user_id, { nowMs, refreshIssuedMs: Date.parse(conn.refresh_expires_at) - LIVE_RULES.refreshDays * 86400_000 })
  const up = await sb.from('broker_connections').update({ ...cols, updated_at: new Date().toISOString() }).eq('user_id', conn.user_id).eq('broker', 'schwab')
  if (up.error) throw new Error(`broker_connections: ${up.error.message}`)
  Object.assign(conn, cols)
  return tok.access_token
}

/** Thin JSON client for one access token. log({ method, path, status, ms, error }) gets no secrets. */
export function schwabHttp({ token, fetchImpl = fetch, log = () => {} }) {
  return async function call(method, path, { query = null, body = null } = {}) {
    const url = new URL(path, SCHWAB_API)
    if (query) for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, String(v))
    const t0 = Date.now()
    let res
    try {
      res = await fetchImpl(url.toString(), {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
      })
    } catch (err) {
      log({ method, path: redactPath(url.pathname), status: 0, ms: Date.now() - t0, error: String(err?.name || err).slice(0, 120) })
      throw new SchwabError(0, `network error on ${method} ${redactPath(url.pathname)}`)
    }
    const ms = Date.now() - t0
    if (!res.ok) {
      const msg = await readErr(res)
      log({ method, path: redactPath(url.pathname), status: res.status, ms, error: msg })
      throw new SchwabError(res.status, `${method} ${redactPath(url.pathname)}: ${res.status} ${msg}`, { path: redactPath(url.pathname) })
    }
    const location = res.headers.get('location') || res.headers.get('Location') || null
    let json = null
    const text = await res.text().catch(() => '')
    if (text) {
      try {
        json = JSON.parse(text)
      } catch {
        json = null
      }
    }
    const orderId = location ? orderIdFromLocation(location) : null
    log({ method, path: redactPath(url.pathname), status: res.status, ms, orderId })
    return { status: res.status, json, location, orderId }
  }
}

/** Order id from a Location header (…/trader/v1/accounts/{hash}/orders/{orderId}). */
export function orderIdFromLocation(loc) {
  const m = String(loc || '').match(/\/accounts\/[^/]+\/orders\/(\d+)\s*$/)
  return m ? m[1] : null
}

/** Account numbers → [{ hash, last4 }]. Only the hash is used for calls; last 4 for display. */
export async function fetchAccounts(call) {
  const r = await call('GET', '/trader/v1/accounts/accountNumbers')
  return (Array.isArray(r.json) ? r.json : []).filter((a) => a?.hashValue).map((a) => ({ hash: String(a.hashValue), last4: String(a.accountNumber || '').slice(-4) }))
}

/**
 * Schwab broker adapter (same method names as the paper adapter). Orders are protective
 * STOP orders only; it has no way to send market / limit / opening orders.
 */
export function createSchwabBroker({ call, accountHash, nowMs = Date.now() }) {
  if (!accountHash) throw new Error('No Schwab account selected')
  const base = `/trader/v1/accounts/${encodeURIComponent(accountHash)}`
  return {
    kind: 'schwab',
    /** Actual holdings → [{ symbol, longQty, shortQty }]. */
    async getPositions() {
      const r = await call('GET', base, { query: { fields: 'positions' } })
      return holdingsFromAccount(r.json)
    },
    /** Open + recent orders for reconciliation / duplicate detection (last 60 days). */
    async getOrders() {
      const to = new Date(nowMs)
      const from = new Date(nowMs - 59 * 86400_000)
      const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z') // schwab-py format: %Y-%m-%dT%H:%M:%SZ
      const r = await call('GET', `${base}/orders`, { query: { fromEnteredTime: iso(from), toEnteredTime: iso(to), maxResults: 3000 } })
      return Array.isArray(r.json) ? r.json : []
    },
    async getOrder(orderId) {
      const r = await call('GET', `${base}/orders/${encodeURIComponent(orderId)}`)
      return r.json
    },
    async placeStop({ symbol, positionSide, qty, stopPrice }) {
      const r = await call('POST', `${base}/orders`, { body: buildStopOrder({ symbol, side: positionSide, qty, stopPrice }) })
      if (!r.orderId) throw new SchwabError(502, 'order placed but no order id in Location header')
      return { orderId: r.orderId, status: r.status }
    },
    /** Replace = Schwab cancels the old order and creates a new one (new id in Location). */
    async modifyStop(orderId, { symbol, positionSide, qty, stopPrice }) {
      const r = await call('PUT', `${base}/orders/${encodeURIComponent(orderId)}`, { body: buildStopOrder({ symbol, side: positionSide, qty, stopPrice }) })
      return { orderId: r.orderId || null, status: r.status }
    },
    async cancel(orderId) {
      const r = await call('DELETE', `${base}/orders/${encodeURIComponent(orderId)}`)
      return { status: r.status }
    },
    /** Execution status of one of the bot's orders. */
    async syncFills(orderId) {
      return fillFromOrder(await this.getOrder(orderId))
    },
    /** Last prices from Schwab market data → Map(symbol → lastPrice). */
    async getQuotes(symbols) {
      if (!symbols.length) return new Map()
      const r = await call('GET', '/marketdata/v1/quotes', { query: { symbols: symbols.join(','), fields: 'quote' } })
      const out = new Map()
      for (const [k, v] of Object.entries(r.json || {})) {
        const last = Number(v?.quote?.lastPrice)
        if (Number.isFinite(last) && last > 0) out.set(k.toUpperCase(), last)
      }
      return out
    },
  }
}
