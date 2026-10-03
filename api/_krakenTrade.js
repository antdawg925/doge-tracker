/**
 * Kraken TRADING client for the DOGE live plan (server only).
 *
 * Credentials: env KRAKEN_TRADE_KEY / KRAKEN_TRADE_SECRET (a separate trade-enabled key,
 * withdrawals OFF). Only the owner's plan may use them. The read-only key
 * (KRAKEN_API_KEY / KRAKEN_API_SECRET in api/_kraken.js) is never used to trade.
 * Secrets are never logged, returned or put in errors.
 *
 * Allowed endpoints (anything else throws): Balance, BalanceEx, OpenOrders, QueryOrders,
 * AddOrder, AmendOrder, CancelOrder. Sells use oflags=fciq (fee in USD) so a stop for the whole DOGE
 * balance never fails for want of DOGE to pay the fee. No withdrawal / funding / earn endpoints exist here.
 * Requests are JSON bodies (Kraken REST accepts JSON for private endpoints; the signature is
 * HMAC-SHA512(path + SHA256(nonce + body)) with the base64-decoded secret).
 */
import { createHash, createHmac } from 'node:crypto'
import { KRAKEN_XDGUSD, priceStr, volStr } from '../shared/dogeLive.js'

const BASE = 'https://api.kraken.com'
const TIMEOUT_MS = 10000
export const BOT_ORDER_PREFIX = 'tsb' // cl_ord_id prefix of every order this bot places
const ALLOWED = new Set(['Balance', 'BalanceEx', 'OpenOrders', 'QueryOrders', 'AddOrder', 'AmendOrder', 'CancelOrder'])

export class KrakenError extends Error {
  constructor(message, { endpoint, kraken = [], timeout = false } = {}) {
    super(message)
    this.endpoint = endpoint
    this.kraken = kraken
    this.timeout = timeout
  }
}

/** Trade key for this profile (owner only), or null → the plan stays DRY-RUN. */
export function krakenTradeCredsFor(profile, env = process.env) {
  if (profile?.role !== 'owner') return null
  const key = env.KRAKEN_TRADE_KEY
  const secret = env.KRAKEN_TRADE_SECRET
  return key && secret ? { key, secret } : null
}
export const tradeKeyConfigured = (env = process.env) => Boolean(env.KRAKEN_TRADE_KEY && env.KRAKEN_TRADE_SECRET)

let lastNonce = 0
const nextNonce = () => (lastNonce = Math.max(Date.now() * 1000, lastNonce + 1))

/** Unique client order id (≤ 18 chars free text): tsb + role letter + base36 time + rand. */
export function newClOrdId(role, nowMs = Date.now()) {
  const r = Math.floor(Math.random() * 36 ** 3).toString(36).padStart(3, '0')
  return `${BOT_ORDER_PREFIX}${role[0]}${nowMs.toString(36)}${r}`.slice(0, 18)
}

/**
 * @param creds { key, secret }
 * @param opts.fetchImpl   injectable fetch (tests mock Kraken)
 * @param opts.log         (entry) => void — summary of each call, never secrets
 */
export function createKrakenTrader({ creds, fetchImpl = fetch, log = () => {}, rules = KRAKEN_XDGUSD }) {
  if (!creds?.key || !creds?.secret) throw new Error('Kraken trade key missing')
  async function call(endpoint, params = {}) {
    if (!ALLOWED.has(endpoint)) throw new KrakenError(`Endpoint not allowed: ${endpoint}`, { endpoint })
    const path = `/0/private/${endpoint}`
    const nonce = nextNonce()
    const body = JSON.stringify({ nonce, ...params })
    const sign = createHmac('sha512', Buffer.from(creds.secret, 'base64'))
      .update(Buffer.concat([Buffer.from(path), createHash('sha256').update(String(nonce) + body).digest()]))
      .digest('base64')
    const t0 = Date.now()
    let res
    try {
      res = await fetchImpl(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'API-Key': creds.key, 'API-Sign': sign, 'Content-Type': 'application/json', Accept: 'application/json' },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (err) {
      const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError'
      log({ endpoint, params: redactParams(params), ok: false, error: timeout ? 'timeout' : 'network error', ms: Date.now() - t0 })
      throw new KrakenError(`Kraken ${endpoint}: ${timeout ? 'timeout' : 'network error'}`, { endpoint, timeout })
    }
    let data = null
    try {
      data = await res.json()
    } catch {
      /* non-JSON */
    }
    const errs = Array.isArray(data?.error) ? data.error : []
    const ok = res.ok && !errs.length
    log({ endpoint, params: redactParams(params), ok, status: res.status, error: errs.join(', ') || (res.ok ? null : `HTTP ${res.status}`), result: summarize(endpoint, data?.result), ms: Date.now() - t0 })
    if (!ok) throw new KrakenError(`Kraken ${endpoint}: ${errs.join(', ') || `HTTP ${res.status}`}`, { endpoint, kraken: errs })
    return data.result
  }
  return {
    balance: () => call('Balance'),
    balanceEx: () => call('BalanceEx'),
    openOrders: (params = {}) => call('OpenOrders', params),
    queryOrders: (txids) => call('QueryOrders', { txid: txids.join(','), trades: false }),
    /** Protective sell stop-loss (triggers a market sell at `price`, last-trade trigger). */
    addStop: ({ qty, price, clOrdId }) =>
      call('AddOrder', { pair: rules.pair, type: 'sell', ordertype: 'stop-loss', price: priceStr(price, rules), volume: volStr(qty, rules), trigger: 'last', oflags: 'fciq', cl_ord_id: clOrdId }),
    /** Zone sale: resting GTC sell limit. */
    addSellLimit: ({ qty, price, clOrdId }) =>
      call('AddOrder', { pair: rules.pair, type: 'sell', ordertype: 'limit', price: priceStr(price, rules), volume: volStr(qty, rules), timeinforce: 'GTC', oflags: 'fciq', cl_ord_id: clOrdId }),
    /** Pot buy: marketable IOC buy limit (never a market order). */
    addBuyIoc: ({ qty, price, clOrdId }) =>
      call('AddOrder', { pair: rules.pair, type: 'buy', ordertype: 'limit', price: priceStr(price, rules), volume: volStr(qty, rules), timeinforce: 'IOC', cl_ord_id: clOrdId }),
    /** In-place amend (keeps txid; no unprotected gap). */
    amend: ({ txid, qty, triggerPrice, limitPrice }) =>
      call('AmendOrder', {
        txid,
        ...(qty != null ? { order_qty: volStr(qty, rules) } : {}),
        ...(triggerPrice != null ? { trigger_price: priceStr(triggerPrice, rules) } : {}),
        ...(limitPrice != null ? { limit_price: priceStr(limitPrice, rules) } : {}),
      }),
    cancel: ({ txid, clOrdId }) => call('CancelOrder', txid ? { txid } : { cl_ord_id: clOrdId }),
  }
}

function redactParams(p) {
  const out = { ...p }
  delete out.nonce
  return out
}
function summarize(endpoint, r) {
  if (!r) return null
  if (endpoint === 'AddOrder') return { txid: r.txid, descr: r.descr?.order }
  if (endpoint === 'AmendOrder') return { amend_id: r.amend_id }
  if (endpoint === 'CancelOrder') return { count: r.count }
  if (endpoint === 'OpenOrders') return { open: Object.keys(r.open || {}).length }
  if (endpoint === 'QueryOrders') return Object.fromEntries(Object.entries(r).map(([k, o]) => [k, { status: o.status, vol_exec: o.vol_exec, price: o.price }]))
  if (endpoint === 'Balance' || endpoint === 'BalanceEx') return { assets: Object.keys(r).length }
  return null
}

/** DOGE + USD from Balance / BalanceEx (spot only: XXDG/XDG, ZUSD/USD; earn ".F" balances can't be sold). */
export function bookFromBalance(r) {
  const val = (k) => {
    const v = r?.[k]
    const n = Number(v && typeof v === 'object' ? v.balance : v)
    return Number.isFinite(n) ? n : 0
  }
  const hold = (k) => {
    const v = r?.[k]
    const n = Number(v && typeof v === 'object' ? v.hold_trade : 0)
    return Number.isFinite(n) ? n : 0
  }
  return { doge: val('XXDG') + val('XDG'), usd: val('ZUSD') + val('USD'), dogeHold: hold('XXDG') + hold('XDG'), usdHold: hold('ZUSD') + hold('USD') }
}

/** Open XDGUSD orders split into the bot's own (cl_ord_id prefix) and the user's. */
export function splitOpenOrders(openResult, pair = KRAKEN_XDGUSD.pair) {
  const mine = []
  const others = []
  for (const [txid, o] of Object.entries(openResult?.open || {})) {
    const p = String(o?.descr?.pair || '').toUpperCase()
    if (!/XDG|DOGE/.test(p) || !/USD/.test(p)) continue
    const row = {
      txid,
      clOrdId: o.cl_ord_id || null,
      type: o.descr?.type,
      ordertype: o.descr?.ordertype,
      price: Number(o.descr?.price),
      vol: Number(o.vol),
      volExec: Number(o.vol_exec || 0),
      pair,
    }
    if (row.clOrdId && String(row.clOrdId).startsWith(BOT_ORDER_PREFIX)) mine.push(row)
    else others.push(row)
  }
  return { mine, others }
}
