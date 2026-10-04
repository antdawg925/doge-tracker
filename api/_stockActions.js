/**
 * Stock stop actions for Telegram (/stop SYMBOL PRICE) using the Stocks-tab logic:
 * the stored effective stop (stock_stops, ratchet trigger) only tightens (long: up, short:
 * down), never past the market. A raised stop is the new floor for the engine (prevStop),
 * so later runs keep it or tighten further. Live Schwab positions: one modify is allowed
 * right away (allowModifyOnce) through the normal live pass. TSLA is never touched unless
 * opted in (stop_reminder_prefs 🔔).
 */
import { fetchDailyMarket, runStocks } from './_stockRunner.js'
import { remindFor } from './_stopReminders.js'
import { stockPassFor } from '../shared/marketHours.js'

const money = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : `$${Number(v).toFixed(Number(v) < 1 ? 4 : 2)}`)

export async function stockPrefs(sb, userId) {
  const { data } = await sb.from('stop_reminder_prefs').select('symbol, remind').eq('user_id', userId)
  return new Map((data || []).map((r) => [r.symbol, r.remind]))
}

/** Active positions (minus opted-out TSLA etc.) with their stop and a live price. */
export async function stockStopTargets(sb, userId, { live = true } = {}) {
  const [{ data: positions }, prefs] = await Promise.all([
    sb.from('stock_positions').select('id, symbol, side, shares, live').eq('user_id', userId).eq('status', 'active').order('created_at', { ascending: true }),
    stockPrefs(sb, userId),
  ])
  const list = (positions || []).filter((p) => remindFor(prefs, p.symbol))
  if (!list.length) return []
  const { data: stops } = await sb.from('stock_stops').select('position_id, stop, data').in('position_id', list.map((p) => p.id))
  const stopBy = new Map((stops || []).map((s) => [s.position_id, s]))
  return Promise.all(
    list.map(async (p) => {
      const s = stopBy.get(p.id)
      let price = Number(s?.data?.price)
      if (live) price = (await fetchDailyMarket(p.symbol, '1mo').catch(() => null))?.price ?? price
      return { ...p, stop: s ? Number(s.stop) : null, price: Number.isFinite(price) ? price : null }
    }),
  )
}

export async function changeStockStop(sb, { userId, symbol, price, nowMs = Date.now() }) {
  const sym = String(symbol || '').toUpperCase()
  const prefs = await stockPrefs(sb, userId)
  if (!remindFor(prefs, sym)) return { ok: false, error: `${sym} is excluded (long-term hold). Opt it in with 🔔 on the Stocks tab first.` }
  const { data: positions } = await sb.from('stock_positions').select('*').eq('user_id', userId).eq('status', 'active').eq('symbol', sym)
  if (!positions?.length) return { ok: false, error: `No active ${sym} position in Positions.` }
  if (positions.length > 1) return { ok: false, error: `You have ${positions.length} ${sym} positions; change it on the Stocks tab.` }
  const p = positions[0]
  const { data: row } = await sb.from('stock_stops').select('*').eq('position_id', p.id).maybeSingle()
  if (!row) return { ok: false, error: `${sym} has no computed stop yet; open the Stocks tab.` }
  const long = p.side === 'long'
  const cur = Number(row.stop)
  const n = Math.round(Number(price) * 100) / 100
  if (!(n > 0)) return { ok: false, error: 'Give a price, e.g. /stop SPY 745.50' }
  if (long ? !(n > cur) : !(n < cur)) return { ok: false, error: `The ${sym} stop only moves ${long ? 'up' : 'down'}: ${money(n)} is not ${long ? 'above' : 'below'} the current ${money(cur)}.` }
  const m = await fetchDailyMarket(sym, '1mo').catch(() => null)
  if (!m?.price) return { ok: false, error: `${sym} price unavailable; try again.` }
  if (long ? n >= m.price : n <= m.price) return { ok: false, error: `A ${sym} stop at ${money(n)} is ${long ? 'at/above' : 'at/below'} the market (${money(m.price)}); it would trigger at once.` }
  const iso = new Date(nowMs).toISOString()
  const data = { ...(row.data || {}), manual: { at: iso, from: cur, to: n, via: 'telegram' } }
  const u = await sb.from('stock_stops').update({ stop: n, data, updated_at: iso }).eq('position_id', p.id)
  if (u.error) return { ok: false, error: 'Could not save the stop.' }
  let schwab = null
  if (p.live) {
    const { data: lo } = await sb.from('stock_live_orders').select('position_id, data').eq('position_id', p.id).maybeSingle()
    if (lo) await sb.from('stock_live_orders').update({ data: { ...(lo.data || {}), allowModifyOnce: true } }).eq('position_id', p.id)
  }
  await runStocks(sb, { source: 'manual', userIds: [userId], force: true, nowMs }).catch(() => null)
  const { data: after } = await sb.from('stock_stops').select('stop').eq('position_id', p.id).maybeSingle()
  if (p.live) {
    const { data: lo } = await sb.from('stock_live_orders').select('status, stop_price, qty, flag').eq('position_id', p.id).maybeSingle()
    const session = stockPassFor(nowMs) === 'intraday'
    const note = session ? '' : ' Schwab stops only trigger in the regular session (9:30 AM–4:00 PM ET).'
    schwab = lo?.stop_price && Math.abs(Number(lo.stop_price) - n) < 0.005 ? `Schwab STOP now ${money(lo.stop_price)} for ${lo.qty} sh.${note}` : `Schwab order not updated yet${lo?.flag?.message ? `: ${lo.flag.message}` : ''}.${note}`
  }
  return { ok: true, symbol: sym, from: cur, to: Number(after?.stop ?? n), price: m.price, live: Boolean(p.live), schwab }
}
