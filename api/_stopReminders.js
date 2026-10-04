/**
 * Missing-stop reminders on Telegram (runs inside the 5-min /api/bot/run cron).
 *
 * Crypto (owner with a Kraken key): any coin at Kraken worth > $50 whose balance is not
 * covered by open sell stop orders (his own or the bot's) → "⚠️ No stop on N DOGE ($X).
 * Suggested stop: $Y (bottom stop)." At most every 4h per coin. DOGE is skipped while the DOGE
 * plan is LIVE (the bot keeps the real stop).
 *
 * Stocks: each active position in Positions (+ Schwab holdings when connected) with no open
 * stop order covering the shares → reminder with the Stocks tab stop (tighter of ATR and
 * max-loss). Regular session only, plus once ~15 min before the open; at most every 2h per
 * symbol. TSLA is excluded by default; per-symbol opt-in/out in stop_reminder_prefs.
 * Without a usable Schwab connection: judged from the bot's paper/watch stop state and says
 * "can't see Schwab orders yet. Connect Schwab to confirm."
 *
 * Reads only. Never places, edits or cancels anything.
 */
import { createKrakenTrader, krakenTradeCredsFor } from './_krakenTrade.js'
import { sendTelegram } from './_telegram.js'
import { cooldownOk } from './_dogeLive.js'
import { accessTokenFor, createSchwabBroker, schwabConfigured, schwabHttp } from './_schwab.js'
import { findOwnStops } from '../shared/schwabLive.js'
import { etParts, isTradingDay, closeMinutes, OPEN_MIN } from '../shared/marketHours.js'
import { ewmAtr } from '../shared/dogeLive.js'
import { normalizeKrakenOhlc, pickKrakenPairRows } from '../shared/kraken.js'

export const CRYPTO_MIN_USD = 50
export const DEFAULT_EXCLUDED = Object.freeze(new Set(['TSLA']))
const STABLE = new Set(['USDT', 'USDC', 'DAI', 'PYUSD', 'USD', 'ZUSD', 'EUR', 'ZEUR', 'USDG', 'RLUSD'])
const STOP_TYPES = new Set(['stop-loss', 'stop-loss-limit', 'trailing-stop', 'trailing-stop-limit'])
const H = 3600000
const usd = (v) => `$${Math.round(v).toLocaleString('en-US')}`
const q0 = (v) => (v >= 100 ? Math.round(v).toLocaleString('en-US') : Number(v.toPrecision(4)).toString())
const px = (v) => (v == null ? '—' : v >= 100 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`)

/** Kraken balance asset → altname used in pairs (XXDG→XDG, XXBT→XBT, XETH→ETH, SOL→SOL). */
export function krakenAlt(asset) {
  const a = String(asset).toUpperCase()
  if (/\.(F|S|M|B|P)$/.test(a) || /\d+\.S$/.test(a)) return null // earn / staked: can't carry a stop
  if (a.length === 4 && (a[0] === 'X' || a[0] === 'Z') && !['XRP', 'XTZ'].includes(a)) return a.slice(1)
  return a
}
const displayName = (alt) => ({ XDG: 'DOGE', XBT: 'BTC' })[alt] || alt

/**
 * Pure: which coins are uncovered. balances = { asset: qty }, prices = { alt: usd },
 * openOrders = Kraken OpenOrders result.open
 */
export function cryptoUncovered({ balances, prices, openOrders, minUsd = CRYPTO_MIN_USD }) {
  const held = new Map()
  for (const [asset, raw] of Object.entries(balances || {})) {
    const alt = krakenAlt(asset)
    const qty = Number(raw && typeof raw === 'object' ? raw.balance : raw)
    if (!alt || STABLE.has(alt) || !(qty > 0)) continue
    held.set(alt, (held.get(alt) || 0) + qty)
  }
  const out = []
  for (const [alt, qty] of held) {
    const p = prices[alt]
    if (!(p > 0) || qty * p < minUsd) continue
    let covered = 0
    for (const o of Object.values(openOrders || {})) {
      const pair = String(o?.descr?.pair || '').toUpperCase()
      if (o?.descr?.type !== 'sell' || !STOP_TYPES.has(o?.descr?.ordertype)) continue
      if (!(pair.startsWith(alt) || (alt === 'XDG' && pair.startsWith('DOGE')) || (alt === 'XBT' && pair.startsWith('BTC')))) continue
      covered += Number(o.vol) - Number(o.vol_exec || 0)
    }
    if (covered >= qty * 0.99) continue
    out.push({ alt, name: displayName(alt), qty, price: p, value: qty * p, covered, uncovered: qty - covered })
  }
  return out
}

/** When to send stock reminders: 'session' (regular hours), 'preopen' (~9:15 ET), or null. */
export function stockReminderWindow(nowMs) {
  const { date, minutes, dow } = etParts(nowMs)
  if (!isTradingDay(date, dow)) return null
  if (minutes >= OPEN_MIN && minutes < closeMinutes(date)) return 'session'
  if (minutes >= OPEN_MIN - 15 && minutes < OPEN_MIN - 10) return 'preopen'
  return null
}

export const remindFor = (prefs, symbol) => {
  const p = prefs.get(String(symbol).toUpperCase())
  return p == null ? !DEFAULT_EXCLUDED.has(String(symbol).toUpperCase()) : Boolean(p)
}

async function pub(fetchImpl, path) {
  const r = await fetchImpl(`https://api.kraken.com/0/public/${path}`, { signal: AbortSignal.timeout(10000) })
  const j = await r.json()
  if (j.error?.length) throw new Error(j.error.join(', '))
  return j.result
}

export async function runStopReminders(sb, { nowMs = Date.now(), fetchImpl = fetch, env = process.env, dogePlans = null } = {}) {
  const out = { crypto: [], stocks: [], errors: [] }
  const { data: profiles } = await sb.from('profiles').select('id, role, bot_access, telegram_chat_id').or('bot_access.eq.true,role.eq.owner')
  const users = (profiles || []).filter((p) => p.telegram_chat_id)
  if (!users.length) return out
  const { data: prefRows } = await sb.from('stop_reminder_prefs').select('user_id, symbol, remind').in('user_id', users.map((u) => u.id))

  for (const prof of users) {
    const send = async (key, cooldownMs, text) => {
      if (!(await cooldownOk(sb, prof.id, key, cooldownMs, nowMs))) return false
      await sendTelegram(prof.telegram_chat_id, text).catch(() => null)
      await sb.from('alert_log').insert({ user_id: prof.id, fired_at: new Date(nowMs).toISOString(), kind: 'no_stop', title: 'Missing stop', message: text.slice(0, 1000) })
      return true
    }

    // ---------------- crypto (Kraken)
    const creds = krakenTradeCredsFor(prof, env)
    if (creds) {
      try {
        const trader = createKrakenTrader({ creds, fetchImpl })
        const [bal, open] = await Promise.all([trader.balance(), trader.openOrders()])
        const alts = [...new Set(Object.keys(bal || {}).map(krakenAlt).filter((a) => a && !STABLE.has(a)))]
        const prices = {}
        for (const alt of alts) {
          try {
            const t = Object.values(await pub(fetchImpl, `Ticker?pair=${alt}USD`))[0]
            prices[alt] = Number(t?.c?.[0])
          } catch {
            /* no USD pair */
          }
        }
        const plan = (dogePlans || (await sb.from('doge_live_plans').select('user_id, live_enabled, kill_switch, state, snapshot').eq('user_id', prof.id).then((r) => r.data))).find?.((p) => p.user_id === prof.id) || null
        const dogeLive = plan && plan.live_enabled && !plan.kill_switch && plan.snapshot?.mode === 'live'
        for (const c of cryptoUncovered({ balances: bal, prices, openOrders: open?.open })) {
          if (c.alt === 'XDG' && dogeLive) continue
          let sug = null
          let why = ''
          if (c.alt === 'XDG' && plan?.state?.stopPx) {
            sug = Number(plan.state.stopPx)
            why = 'bottom stop'
          } else {
            try {
              const d = normalizeKrakenOhlc(pickKrakenPairRows(await pub(fetchImpl, `OHLC?pair=${c.alt}USD&interval=1440`))).filter((b) => b.t + 86400000 <= nowMs)
              const atr = ewmAtr(d.slice(-60), 14)
              if (atr) {
                sug = c.price - 3 * atr
                why = '3× daily ATR under price'
              }
            } catch {
              /* no candles */
            }
          }
          const part = c.covered > 0 ? ` (stops cover only ${q0(c.covered)})` : ''
          const text = `⚠️ No stop on ${q0(c.uncovered)} ${c.name} (${usd(c.uncovered * c.price)})${part}. Suggested stop: ${px(sug)}${why ? ` (${why})` : ''}.`
          if (await send(`nostop:crypto:${c.alt}`, 4 * H, text)) out.crypto.push(c.name)
        }
      } catch (e) {
        out.errors.push(`kraken: ${String(e?.message || e).slice(0, 160)}`)
      }
    }

    // ---------------- stocks
    const win = stockReminderWindow(nowMs)
    if (!win) continue
    const prefs = new Map((prefRows || []).filter((r) => r.user_id === prof.id).map((r) => [r.symbol, r.remind]))
    const { data: positions } = await sb.from('stock_positions').select('id, symbol, side, shares').eq('user_id', prof.id).eq('status', 'active')
    const ids = (positions || []).map((p) => p.id)
    const [{ data: stops }, { data: paper }, { data: conn }] = await Promise.all([
      ids.length ? sb.from('stock_stops').select('position_id, stop, data').in('position_id', ids) : { data: [] },
      ids.length ? sb.from('stock_paper_orders').select('position_id, status, stop_price').in('position_id', ids).eq('status', 'working') : { data: [] },
      sb.from('broker_connections').select('*').eq('broker', 'schwab').eq('user_id', prof.id).maybeSingle(),
    ])
    const stopBy = new Map((stops || []).map((s) => [s.position_id, s]))
    const paperBy = new Map((paper || []).map((s) => [s.position_id, s]))
    let schwab = null
    const usable = schwabConfigured() && conn && conn.status === 'connected' && conn.account_hash && Date.parse(conn.refresh_expires_at) > nowMs
    if (usable) {
      try {
        const token = await accessTokenFor(sb, conn, { nowMs, fetchImpl })
        const broker = createSchwabBroker({ call: schwabHttp({ token, fetchImpl }), accountHash: conn.account_hash, nowMs })
        schwab = { holdings: await broker.getPositions(), orders: await broker.getOrders() }
      } catch (e) {
        out.errors.push(`schwab: ${String(e?.message || e).slice(0, 160)}`)
      }
    }
    const items = []
    for (const p of positions || []) items.push({ symbol: p.symbol, side: p.side, shares: Number(p.shares), pos: p })
    if (schwab) {
      for (const h of schwab.holdings) {
        if (items.some((i) => i.symbol === h.symbol)) continue
        if (h.longQty > 0) items.push({ symbol: h.symbol, side: 'long', shares: h.longQty, pos: null })
        if (h.shortQty > 0) items.push({ symbol: h.symbol, side: 'short', shares: h.shortQty, pos: null })
      }
    }
    for (const it of items) {
      if (!remindFor(prefs, it.symbol)) continue
      const st = it.pos ? stopBy.get(it.pos.id) : null
      const sug = st ? Number(st.stop) : null
      const sugTxt = sug ? `Suggested stop: ${px(sug)} (${st?.data?.rule === 'risk' ? 'max-loss stop' : 'ATR stop'}, the tighter of ATR and max-loss)` : 'No suggested stop yet: add it in Positions'
      let text = null
      if (schwab) {
        const h = schwab.holdings.find((x) => x.symbol === it.symbol)
        const held = h ? (it.side === 'short' ? h.shortQty : h.longQty) : 0
        if (!(held > 0)) continue // not held at Schwab
        const covered = findOwnStops({ orders: schwab.orders, symbol: it.symbol, side: it.side }).reduce((a, o) => a + (Number(o.qty) || 0), 0)
        if (covered >= held - 1e-9) continue
        text = `⚠️ No stop on ${q0(held - covered)} ${it.symbol} shares at Schwab${covered > 0 ? ` (stops cover only ${q0(covered)} of ${q0(held)})` : ''}. ${sugTxt}.`
      } else {
        const pp = it.pos ? paperBy.get(it.pos.id) : null
        text = `⚠️ ${it.symbol}: ${q0(it.shares)} shares, can't see Schwab orders yet. Connect Schwab to confirm there's a stop. ${sugTxt}.${pp ? ` (The bot's paper stop @ ${px(Number(pp.stop_price))} is simulated, not a real order.)` : ''}`
      }
      if (win === 'preopen') text = `Before the open: ${text}`
      // one key for both windows: the pre-open nudge also holds the 9:30 one off for 2h
      if (await send(`nostop:stock:${it.symbol}:${it.side}`, 2 * H, text)) out.stocks.push(it.symbol)
    }
  }
  return out
}
