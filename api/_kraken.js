/**
 * Kraken helpers for the server bot.
 *   Public:  OHLC + Ticker (no key).
 *   Private: Balance + OpenOrders ONLY (query funds / query orders). This module
 *            has no order-placing function by design, and the owner's key has
 *            trading disabled on Kraken's side as well.
 * Credentials come from krakenCredsFor(profile): today only the owner, from Vercel
 * env KRAKEN_API_KEY / KRAKEN_API_SECRET (sensitive). Per-user keys can plug in there.
 * Secrets are never logged or returned.
 */
import { createHash, createHmac } from 'node:crypto'
import { normalizeKrakenOhlc, pickKrakenPairRows, pickKrakenTicker } from '../shared/kraken.js'

const BASE = 'https://api.kraken.com'
const TIMEOUT_MS = 10000

async function getJson(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`Kraken HTTP ${res.status}`)
  const data = await res.json()
  if (Array.isArray(data?.error) && data.error.length) throw new Error(`Kraken: ${data.error.join(', ')}`)
  return data.result
}

/** 4h (default) bars, oldest → newest, trimmed to `maxBars`, plus live ticker price. */
export async function fetchMarket({ pair, intervalMin = 240, maxBars = 720 }) {
  const [ohlc, ticker] = await Promise.allSettled([
    getJson(`${BASE}/0/public/OHLC?pair=${encodeURIComponent(pair)}&interval=${intervalMin}`),
    getJson(`${BASE}/0/public/Ticker?pair=${encodeURIComponent(pair)}`),
  ])
  if (ohlc.status !== 'fulfilled') throw ohlc.reason
  const bars = normalizeKrakenOhlc(pickKrakenPairRows(ohlc.value)).slice(-maxBars)
  if (bars.length < 20) throw new Error('Kraken returned too few candles')
  const tick = ticker.status === 'fulfilled' ? pickKrakenTicker(ticker.value) : null
  return {
    bars,
    price: tick?.price ?? bars[bars.length - 1].close,
    priceSource: tick ? 'ticker' : 'last_close',
    tickerError: ticker.status === 'rejected' ? String(ticker.reason?.message || ticker.reason) : null,
  }
}

/** Live ticker price only (used when a user re-authorizes TSB). */
export async function fetchTickerPrice(pair) {
  const tick = pickKrakenTicker(await getJson(`${BASE}/0/public/Ticker?pair=${encodeURIComponent(pair)}`))
  if (!tick) throw new Error('Kraken ticker empty')
  return tick.price
}

/** Which read-only Kraken key (if any) applies to this user. Owner → env key. */
export function krakenCredsFor(profile) {
  if (profile?.role !== 'owner') return null
  const key = process.env.KRAKEN_API_KEY
  const secret = process.env.KRAKEN_API_SECRET
  return key && secret ? { key, secret } : null
}

let lastNonce = 0
function nextNonce() {
  lastNonce = Math.max(Date.now() * 1000, lastNonce + 1)
  return String(lastNonce)
}

const READ_ONLY_PATHS = new Set(['/0/private/Balance', '/0/private/OpenOrders'])

async function privateCall(path, creds, params = {}) {
  if (!READ_ONLY_PATHS.has(path)) throw new Error('Only read-only Kraken endpoints are allowed.')
  const nonce = nextNonce()
  const body = new URLSearchParams({ nonce, ...params }).toString()
  const hash = createHash('sha256').update(nonce + body).digest()
  const sign = createHmac('sha512', Buffer.from(creds.secret, 'base64'))
    .update(Buffer.concat([Buffer.from(path), hash]))
    .digest('base64')
  return getJson(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'API-Key': creds.key,
      'API-Sign': sign,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  })
}

/** Read-only account snapshot. Errors are captured per call, never thrown. */
export async function fetchKrakenAccount(creds) {
  const out = { balances: null, openOrders: null, dogeOpenOrders: null, errors: [] }
  try {
    out.balances = await privateCall('/0/private/Balance', creds)
  } catch (err) {
    out.errors.push(`Balance: ${err?.message || err}`)
  }
  try {
    const r = await privateCall('/0/private/OpenOrders', creds)
    const open = r?.open && typeof r.open === 'object' ? Object.values(r.open) : []
    out.openOrders = open.length
    out.dogeOpenOrders = open.filter((o) => /XDG|DOGE/i.test(o?.descr?.pair || '')).length
  } catch (err) {
    out.errors.push(`OpenOrders: ${err?.message || err}`)
  }
  return out
}
