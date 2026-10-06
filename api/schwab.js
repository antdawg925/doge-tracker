/**
 * Schwab connection + LIVE stop controls (routed by vercel.json /api/schwab/:route*).
 *
 *   POST /api/schwab/connect        bot-tier JWT → { url } (our /authorize with a signed state)
 *   GET  /api/schwab/authorize      ?state=  verifies the signed state → 302 to Schwab's login
 *   GET  /api/schwab/callback       ?code=&state=  Schwab → code exchange; tokens are stored
 *                                   encrypted as PENDING and the browser gets a one-time finish
 *                                   code (URL fragment). 400 on a bad / expired state.
 *   POST /api/schwab/finish         { code } JWT must be the user in the state → connection active.
 *                                   (Binds the Schwab login to the Supabase user that started it, so a
 *                                   forwarded link can't attach someone's Schwab to another login.)
 *   GET  /api/schwab/status         status + expiry + account last-4s + live switches (no tokens)
 *   POST /api/schwab/account        { index } pick the account the bot manages
 *   POST /api/schwab/live           { enabled, confirm: 'LIVE' } user-level Live switch (default off)
 *   POST /api/schwab/kill           { on } "Pause live orders entirely" (blocks every Schwab order action)
 *   POST /api/schwab/position-live  { positionId, live } per-position Live toggle (default off)
 *   POST /api/schwab/adopt          { positionId, orderId } "Let bot manage this order" (explicit)
 *   POST /api/schwab/cancel         { positionId } cancel the bot's Schwab order for a position
 *   POST /api/schwab/borrow         { symbols } read-only: quotes?fields=reference → isShortable /
 *                                   isHardToBorrow / htbRate / htbQuantity per symbol (caller's own login)
 *   POST /api/schwab/disconnect     forget tokens (orders already at Schwab stay)
 * Every route acts on the caller's own data only. Tokens never leave the server.
 */
import { getAdminClient, readJsonBody, requireUser, sendJson } from './_supabase.js'
import {
  accessTokenFor, authorizeUrl, createSchwabBroker, decryptToken, encryptToken, fetchAccounts, newNonce, nonceHash, redirectUri,
  schwabConfigured, schwabHttp, signState, tokenColumns, tokenRequest, verifyState,
} from './_schwab.js'
import { runStocks } from './_stockRunner.js'
import { LIVE_RULES, OPEN_STATUSES, borrowFromQuote, instructionFor } from '../shared/schwabLive.js'
import { liveOrderCheck } from '../shared/guard.js'
import { etDate } from '../shared/marketHours.js'

const ORIGINS = new Set(['https://trade-smart-app.vercel.app', 'https://get-trade-smart.vercel.app', 'https://doge-tracker-five.vercel.app'])
const DEFAULT_ORIGIN = 'https://trade-smart-app.vercel.app'
const STATE_TTL_MS = 10 * 60_000
const PENDING_TTL_MS = 15 * 60_000
const GET_ROUTES = new Set(['authorize', 'callback', 'status'])
const POST_ROUTES = new Set(['borrow', 'connect', 'finish', 'account', 'live', 'kill', 'position-live', 'adopt', 'cancel', 'disconnect'])

function routeOf(req) {
  const q = req.query?.route
  const raw = Array.isArray(q) ? q.join('/') : q
  if (raw) return String(raw)
  return new URL(req.url || '/', 'http://x').pathname.replace(/^\/?(api\/)?schwab\/?/, '')
}
const queryOf = (req) => Object.fromEntries(new URL(req.url || '/', 'http://x').searchParams)

function redirect(res, url) {
  res.statusCode = 302
  res.setHeader('Location', url)
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.end()
}
function badPage(res, status, msg) {
  res.statusCode = status
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(`<!doctype html><meta charset="utf-8"><title>Schwab</title><body style="font-family:system-ui;padding:2rem;background:#0b0f14;color:#e5e7eb"><h1 style="font-size:1.1rem">Schwab connection</h1><p>${msg}</p><p><a style="color:#22d3ee" href="${DEFAULT_ORIGIN}/bot?tab=stocks">Back to My Bot → Stocks</a></p></body>`)
}

function originOf(req) {
  const o = req.headers?.origin
  if (o && ORIGINS.has(o)) return o
  const host = req.headers?.['x-forwarded-host'] || req.headers?.host
  const h = host ? `https://${host}` : null
  return h && ORIGINS.has(h) ? h : DEFAULT_ORIGIN
}

async function liveEvent(sb, uid, kind, reason, extra = {}) {
  await sb.from('stock_paper_events').insert({ user_id: uid, symbol: extra.symbol || 'SCHWAB', position_id: extra.position_id ?? null, kind, reason: String(reason).slice(0, 300), data: { live: true, ...(extra.data || {}) }, new_price: extra.new_price ?? null, old_price: extra.old_price ?? null, qty: extra.qty ?? null })
}
const requestLogger = (sb, uid) => {
  const rows = []
  return {
    log: (r) => rows.push({ user_id: uid, symbol: 'SCHWAB', kind: 'live_request', reason: `LIVE ${r.method} ${r.path} → ${r.status || 'network'} (${r.ms} ms)${r.orderId ? ` order ${r.orderId}` : ''}${r.error ? `: ${String(r.error).slice(0, 160)}` : ''}`, data: { live: true, ...r } }),
    flush: async () => (rows.length ? sb.from('stock_paper_events').insert(rows) : null),
  }
}

async function getConn(sb, uid) {
  const { data, error } = await sb.from('broker_connections').select('*').eq('user_id', uid).eq('broker', 'schwab').maybeSingle()
  if (error) throw new Error(`broker_connections: ${error.message}`)
  return data
}

function publicStatus(c, nowMs) {
  if (!c || c.status === 'disconnected') return null
  const left = Date.parse(c.refresh_expires_at) - nowMs
  const today = etDate(nowMs)
  const expired = c.status === 'expired' || !(left > 0)
  return {
    status: expired ? 'expired' : c.status,
    connectedAt: c.connected_at,
    refreshExpiresAt: c.refresh_expires_at,
    expiresInMs: Number.isFinite(left) ? Math.max(0, left) : null,
    accounts: (c.accounts || []).map((a, i) => ({ index: i, last4: a.last4, selected: a.hash === c.account_hash })),
    accountLast4: c.account_last4,
    liveEnabled: Boolean(c.live_enabled),
    killSwitch: Boolean(c.kill_switch),
    lastError: expired ? null : c.last_error,
    actionsToday: c.data?.actions?.day === today ? Number(c.data.actions.n) || 0 : 0,
    dailyCap: LIVE_RULES.dailyActionCap,
    watchOnly: expired || !c.account_hash || !c.live_enabled || c.kill_switch,
    borrowProbe: c.data?.borrowProbe ?? null,
  }
}

export default async function handler(req, res) {
  try {
    const route = routeOf(req)
    const isGet = GET_ROUTES.has(route)
    if (!isGet && !POST_ROUTES.has(route)) return sendJson(res, 404, { error: 'Unknown Schwab route.' })
    if ((isGet && req.method !== 'GET') || (!isGet && req.method !== 'POST')) {
      res.setHeader('Allow', isGet ? 'GET' : 'POST')
      return sendJson(res, 405, { error: 'Method not allowed.' })
    }
    const sb = getAdminClient()
    if (!sb) return sendJson(res, 500, { error: 'Server is not configured.' })
    const nowMs = Date.now()

    // ---------------------------------------------------------------- browser redirects (no JWT)
    if (route === 'authorize') {
      if (!schwabConfigured()) return badPage(res, 503, 'Schwab is not configured on the server yet.')
      const st = verifyState(queryOf(req).state, { nowMs })
      if (!st) return badPage(res, 400, 'This Connect Schwab link is invalid or expired. Start again from My Bot → Stocks.')
      return redirect(res, authorizeUrl(queryOf(req).state))
    }
    if (route === 'callback') {
      const q = queryOf(req)
      const st = schwabConfigured() ? verifyState(q.state, { nowMs }) : null
      if (!st) return badPage(res, 400, 'Invalid or expired sign-in state. Nothing was connected. Start again from My Bot → Stocks.')
      const origin = ORIGINS.has(st.o) ? st.o : DEFAULT_ORIGIN
      if (q.error || !q.code) return redirect(res, `${origin}/bot?tab=stocks&schwab=error&reason=${encodeURIComponent(String(q.error || 'no_code').slice(0, 40))}`)
      const { data: prof } = await sb.from('profiles').select('role, bot_access').eq('id', st.u).maybeSingle()
      if (!(prof?.bot_access || prof?.role === 'owner')) return badPage(res, 403, 'Trade Smart Bot access is required to connect Schwab.')
      let tok
      try {
        tok = await tokenRequest({ grant_type: 'authorization_code', code: q.code, redirect_uri: redirectUri() })
      } catch (err) {
        console.error('schwab code exchange failed', err?.status, String(err?.message || '').slice(0, 120))
        return redirect(res, `${origin}/bot?tab=stocks&schwab=error&reason=exchange`)
      }
      let accounts = []
      try {
        accounts = await fetchAccounts(schwabHttp({ token: tok.access_token }))
      } catch (err) {
        console.error('schwab accountNumbers failed', err?.status)
      }
      const finish = newNonce()
      const cols = tokenColumns(tok, st.u, { nowMs })
      await sb.from('broker_oauth_pending').delete().eq('user_id', st.u)
      const ins = await sb.from('broker_oauth_pending').insert({ nonce_hash: nonceHash(finish), user_id: st.u, broker: 'schwab', ...cols, accounts })
      if (ins.error) {
        console.error('schwab pending insert', ins.error.message)
        return redirect(res, `${origin}/bot?tab=stocks&schwab=error&reason=store`)
      }
      // One-time finish code in the fragment (not sent to servers / logs); the signed-in app confirms it.
      return redirect(res, `${origin}/bot?tab=stocks#schwab-finish=${finish}`)
    }

    // ---------------------------------------------------------------- signed-in user (bot tier)
    const who = await requireUser(req, res, { bot: true })
    if (!who) return
    const uid = who.user.id
    let body = {}
    if (!isGet) {
      try {
        body = (await readJsonBody(req)) || {}
      } catch {
        return sendJson(res, 400, { error: 'Bad JSON body.' })
      }
      const target = body.userId ?? body.user_id
      if (target != null && String(target) !== uid) return sendJson(res, 403, { error: 'You can only manage your own Schwab connection.' })
    }

    if (route === 'status') {
      const c = await getConn(sb, uid)
      return sendJson(res, 200, { ok: true, configured: schwabConfigured(), redirectUri: redirectUri(), connection: publicStatus(c, nowMs), rules: LIVE_RULES })
    }

    if (route === 'borrow') {
      const syms = [...new Set((Array.isArray(body.symbols) ? body.symbols : []).map((x) => String(x || '').toUpperCase().trim()).filter((x) => /^[A-Z.\-]{1,10}$/.test(x)))].slice(0, 50)
      const c = await getConn(sb, uid)
      const usable = c && c.status === 'connected' && Date.parse(c.refresh_expires_at) > nowMs && schwabConfigured()
      if (!usable || !syms.length) return sendJson(res, 200, { ok: true, available: false, reason: !usable ? 'Schwab not connected' : 'no symbols', rows: {} })
      try {
        const call = schwabHttp({ token: await accessTokenFor(sb, c, { nowMs }) })
        const r = await call('GET', '/marketdata/v1/quotes', { query: { symbols: syms.join(','), fields: 'reference' } })
        const rows = {}
        for (const [k, v] of Object.entries(r.json || {})) rows[k.toUpperCase()] = borrowFromQuote(v)
        return sendJson(res, 200, { ok: true, available: true, source: 'GET /marketdata/v1/quotes?fields=reference', rows })
      } catch (err) {
        return sendJson(res, 200, { ok: true, available: false, reason: `Schwab: ${String(err?.message || 'request failed').slice(0, 120)}`, rows: {} })
      }
    }

    if (route === 'connect') {
      if (!schwabConfigured()) return sendJson(res, 503, { error: 'Schwab is not configured on the server yet.' })
      const origin = originOf(req)
      const state = signState({ u: uid, n: newNonce(), o: origin, e: nowMs + STATE_TTL_MS })
      return sendJson(res, 200, { ok: true, url: `${DEFAULT_ORIGIN}/api/schwab/authorize?state=${encodeURIComponent(state)}` })
    }

    if (route === 'finish') {
      const code = String(body.code || '')
      if (!code) return sendJson(res, 400, { error: 'Missing finish code.' })
      const { data: pend } = await sb.from('broker_oauth_pending').select('*').eq('nonce_hash', nonceHash(code)).maybeSingle()
      if (!pend || pend.user_id !== uid || Date.parse(pend.created_at) < nowMs - PENDING_TTL_MS) {
        return sendJson(res, 400, { error: 'This Schwab sign-in does not belong to your login or has expired. Tap Connect Schwab again.' })
      }
      const prev = await getConn(sb, uid)
      const accounts = pend.accounts || []
      const keep = prev?.account_hash && accounts.find((a) => a.hash === prev.account_hash)
      const sel = keep || (accounts.length === 1 ? accounts[0] : null)
      const row = {
        user_id: uid, broker: 'schwab', status: 'connected', enc_access: pend.enc_access, enc_refresh: pend.enc_refresh,
        access_expires_at: pend.access_expires_at, refresh_expires_at: pend.refresh_expires_at, connected_at: new Date(nowMs).toISOString(),
        accounts, account_hash: sel?.hash ?? null, account_last4: sel?.last4 ?? null,
        live_enabled: sel ? Boolean(prev?.live_enabled) : false, kill_switch: Boolean(prev?.kill_switch), last_error: null,
        data: { ...(prev?.data || {}), reminders: {} }, updated_at: new Date().toISOString(),
      }
      const up = await sb.from('broker_connections').upsert(row)
      if (up.error) return sendJson(res, 500, { error: 'Could not save the Schwab connection.' })
      await sb.from('broker_oauth_pending').delete().eq('nonce_hash', pend.nonce_hash)
      await liveEvent(sb, uid, 'live_setting', `LIVE Schwab connected (${accounts.length} account${accounts.length === 1 ? '' : 's'}; refresh expires ${row.refresh_expires_at})`)
      return sendJson(res, 200, { ok: true, connection: publicStatus(row, nowMs), needsAccount: !sel })
    }

    const c = await getConn(sb, uid)
    if (!c || c.status === 'disconnected') return sendJson(res, 400, { error: 'Connect Schwab first.' })

    if (route === 'disconnect') {
      await sb.from('broker_connections').update({ status: 'disconnected', enc_access: null, enc_refresh: null, live_enabled: false, updated_at: new Date().toISOString() }).eq('user_id', uid).eq('broker', 'schwab')
      await liveEvent(sb, uid, 'live_setting', 'LIVE Schwab disconnected in the app (orders already at Schwab stay in place)')
      return sendJson(res, 200, { ok: true })
    }

    if (route === 'kill') {
      const on = Boolean(body.on)
      await sb.from('broker_connections').update({ kill_switch: on, kill_switch_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('user_id', uid).eq('broker', 'schwab')
      await liveEvent(sb, uid, 'live_setting', on ? 'LIVE kill switch ON: all Schwab order actions paused' : 'LIVE kill switch off')
      return sendJson(res, 200, { ok: true, connection: publicStatus({ ...c, kill_switch: on }, nowMs) })
    }

    if (route === 'account') {
      const a = (c.accounts || [])[Number(body.index)]
      if (!a) return sendJson(res, 400, { error: 'Unknown account.' })
      const changed = a.hash !== c.account_hash
      const cols = { account_hash: a.hash, account_last4: a.last4, ...(changed ? { live_enabled: false } : {}), updated_at: new Date().toISOString() }
      await sb.from('broker_connections').update(cols).eq('user_id', uid).eq('broker', 'schwab')
      if (changed) await sb.from('stock_live_orders').delete().eq('user_id', uid).neq('status', 'working')
      await liveEvent(sb, uid, 'live_setting', `LIVE bot manages Schwab account …${a.last4}${changed && c.live_enabled ? ' (Live switched off: turn it on again for this account)' : ''}`)
      return sendJson(res, 200, { ok: true, connection: publicStatus({ ...c, ...cols }, nowMs) })
    }

    const expired = c.status !== 'connected' || !(Date.parse(c.refresh_expires_at) > nowMs)

    if (route === 'live') {
      const enabled = Boolean(body.enabled)
      if (enabled) {
        if (expired) return sendJson(res, 400, { error: 'Schwab connection expired. Reconnect first.' })
        if (!c.account_hash) return sendJson(res, 400, { error: 'Pick the Schwab account first.' })
        if (body.confirm !== 'LIVE') return sendJson(res, 400, { error: 'Confirm required.' })
      }
      await sb.from('broker_connections').update({ live_enabled: enabled, live_enabled_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('user_id', uid).eq('broker', 'schwab')
      await liveEvent(sb, uid, 'live_setting', enabled ? `LIVE Schwab stops ON for account …${c.account_last4}` : 'LIVE Schwab stops OFF (orders already at Schwab stay in place)')
      const run = enabled ? await runStocks(sb, { source: 'manual', userIds: [uid], force: true }).catch((e) => ({ error: String(e?.message || e) })) : null
      return sendJson(res, 200, { ok: true, connection: publicStatus({ ...c, live_enabled: enabled }, nowMs), live: run?.live ?? null })
    }

    // ---- per-position routes
    const posId = String(body.positionId || '')
    const { data: pos } = await sb.from('stock_positions').select('*').eq('id', posId).eq('user_id', uid).maybeSingle()
    if (!pos) return sendJson(res, 404, { error: 'Position not found.' })
    const { data: lo } = await sb.from('stock_live_orders').select('*').eq('position_id', pos.id).maybeSingle()

    if (route === 'position-live') {
      const live = Boolean(body.live)
      if (live && pos.status !== 'active') return sendJson(res, 400, { error: 'Only active positions can be Live.' })
      await sb.from('stock_positions').update({ live, updated_at: new Date().toISOString() }).eq('id', pos.id).eq('user_id', uid)
      // Turning Live back on after a fill / an order that vanished at Schwab starts fresh.
      if (live && lo && lo.status !== 'working') await sb.from('stock_live_orders').delete().eq('position_id', pos.id)
      await liveEvent(sb, uid, 'live_setting', `LIVE ${pos.symbol}: Live ${live ? 'ON' : 'OFF'}${!live && lo?.status === 'working' ? ` (order ${lo.order_id} stays at Schwab)` : ''}`, { symbol: pos.symbol, position_id: pos.id })
      const run = live && c.live_enabled && !expired && !c.kill_switch ? await runStocks(sb, { source: 'manual', userIds: [uid], force: true }).catch((e) => ({ error: String(e?.message || e) })) : null
      return sendJson(res, 200, { ok: true, live, ran: Boolean(run), result: run?.live ?? null })
    }

    if (expired) return sendJson(res, 400, { error: 'Schwab connection expired. Reconnect first.' })
    const today = etDate(nowMs)
    const actionsToday = c.data?.actions?.day === today ? Number(c.data.actions.n) || 0 : 0
    const logger = requestLogger(sb, uid)
    const bump = async () => {
      await sb.from('broker_connections').update({ data: { ...(c.data || {}), actions: { day: today, n: actionsToday + 1 } }, updated_at: new Date().toISOString() }).eq('user_id', uid).eq('broker', 'schwab')
    }
    try {
      const token = await accessTokenFor(sb, c, { nowMs })
      const broker = createSchwabBroker({ call: schwabHttp({ token, log: logger.log }), accountHash: c.account_hash, nowMs })

      if (route === 'adopt') {
        if (lo?.status === 'working' && lo.order_id) return sendJson(res, 400, { error: `The bot already manages order ${lo.order_id} for ${pos.symbol}.` })
        const orderId = String(body.orderId || '')
        if (!/^\d{1,20}$/.test(orderId)) return sendJson(res, 400, { error: 'Bad order id.' })
        const o = await broker.getOrder(orderId)
        const legs = o?.orderLegCollection || []
        const ok = o && o.orderType === 'STOP' && OPEN_STATUSES.has(o.status) && (o.orderStrategyType || 'SINGLE') === 'SINGLE' && legs.length === 1 &&
          String(legs[0]?.instrument?.symbol || '').toUpperCase() === pos.symbol && legs[0]?.instruction === instructionFor(pos.side)
        if (!ok) return sendJson(res, 400, { error: 'That order is not an open single STOP order for this position.' })
        const row = {
          position_id: pos.id, user_id: uid, symbol: pos.symbol, position_side: pos.side, instruction: instructionFor(pos.side), order_id: orderId,
          status: 'working', stop_price: Number(o.stopPrice), qty: Number(o.remainingQuantity) || Number(legs[0].quantity), adopted: true,
          placed_at: o.enteredTime || null, flag: null, foreign_stops: [], data: { allowModifyOnce: true }, updated_at: new Date().toISOString(),
        }
        await sb.from('stock_live_orders').upsert(row)
        await liveEvent(sb, uid, 'live_adopted', `LIVE bot now manages your Schwab order ${orderId} (${pos.symbol} STOP ${row.qty} @ $${row.stop_price})`, { symbol: pos.symbol, position_id: pos.id, new_price: row.stop_price, qty: row.qty, data: { orderId } })
        await logger.flush()
        const run = pos.live && c.live_enabled && !c.kill_switch ? await runStocks(sb, { source: 'manual', userIds: [uid], force: true }).catch(() => null) : null
        return sendJson(res, 200, { ok: true, adopted: orderId, ran: Boolean(run) })
      }

      if (route === 'cancel') {
        if (!(lo?.status === 'working' && lo.order_id)) return sendJson(res, 400, { error: 'No bot-managed Schwab order for this position.' })
        const g = liveOrderCheck(null, { kind: 'cancel_stop', killSwitch: c.kill_switch })
        if (!g.allowed) return sendJson(res, 409, { error: g.reason })
        if (actionsToday >= LIVE_RULES.dailyActionCap) return sendJson(res, 429, { error: `Daily cap of ${LIVE_RULES.dailyActionCap} Schwab order actions reached.` })
        await broker.cancel(lo.order_id)
        await bump()
        await sb.from('stock_live_orders').update({ status: 'gone', data: { ...(lo.data || {}), goneReason: `Canceled from the app (order ${lo.order_id}).` }, updated_at: new Date().toISOString() }).eq('position_id', pos.id)
        await sb.from('stock_positions').update({ live: false, updated_at: new Date().toISOString() }).eq('id', pos.id).eq('user_id', uid)
        await liveEvent(sb, uid, 'live_canceled', `LIVE canceled Schwab order ${lo.order_id} for ${pos.symbol}; position Live OFF`, { symbol: pos.symbol, position_id: pos.id, old_price: lo.stop_price, data: { orderId: lo.order_id } })
        await logger.flush()
        return sendJson(res, 200, { ok: true })
      }
    } catch (err) {
      await logger.flush().catch(() => null)
      await liveEvent(sb, uid, 'live_error', `LIVE ${route}: ${String(err?.message || err).slice(0, 200)}`, { symbol: pos.symbol, position_id: pos.id }).catch(() => null)
      return sendJson(res, 502, { error: `Schwab: ${String(err?.message || 'request failed').slice(0, 160)}` })
    }
    return sendJson(res, 404, { error: 'Unknown Schwab route.' })
  } catch (err) {
    console.error('schwab api failed', err?.message || err)
    return sendJson(res, 500, { error: 'Schwab request failed.' })
  }
}

// Exported for tests.
export const _internal = { publicStatus, ORIGINS, decryptToken, encryptToken }
