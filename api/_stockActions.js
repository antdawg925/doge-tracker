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

/** B20: Buy dips / Sell highs plans for Telegram /plans (own rows, active only). */
export async function planListText(sb, userId) {
  const { data: plans } = await sb.from('stock_plans').select('symbol, side, status, shares, filled_shares, limit_price, stop_price, last_stop_price, next_rung, dry_run, risk_tripped_at, last_error')
    .eq('user_id', userId).in('status', ['pending', 'working', 'filled']).order('created_at', { ascending: true })
  if (!plans?.length) return 'No active Buy dips / Sell highs plans.'
  const lines = plans.map((p) => {
    const short = p.side === 'short'
    const stop = Number(p.last_stop_price || p.stop_price)
    const st = p.status === 'filled' ? `${short ? 'short' : 'long'} ${p.filled_shares || p.shares} sh` : `${p.status} ${short ? 'short' : 'buy'} ${p.shares} @ ${money(p.limit_price)}`
    const rung = p.next_rung?.trigger ? ` · next rung ${money(p.next_rung.trigger)} → stop ${money(p.next_rung.stop)}` : ''
    return `${p.dry_run ? '📝' : '💵'} ${p.symbol}: ${st} · stop ${money(stop)}${rung}${p.risk_tripped_at ? ' · RISK HIT' : ''}${p.last_error ? `\n   ⚠ ${String(p.last_error).slice(0, 120)}` : ''}`
  })
  return ['Buy dips / Sell highs plans (📝 paper · 💵 real):', ...lines, 'Move a filled plan stop: /stop SYMBOL PRICE'].join('\n')
}

/** B20: /stop SYMBOL PRICE for a filled plan (tighten only; Schwab updated by the next market-hours run). */
export async function changePlanStop(sb, { userId, symbol, price }) {
  const sym = String(symbol || '').toUpperCase()
  const { data: plans } = await sb.from('stock_plans').select('*').eq('user_id', userId).eq('symbol', sym).eq('status', 'filled')
  if (!plans?.length) return null
  if (plans.length > 1) return { ok: false, error: `You have ${plans.length} filled ${sym} plans; change it on My Bot.` }
  const p = plans[0]
  const short = p.side === 'short'
  const cur = Number(p.last_stop_price || p.stop_price)
  const n = Math.round(Number(price) * 100) / 100
  if (!(n > 0)) return { ok: false, error: 'Give a price, e.g. /stop NVDA 95.50' }
  if (short ? !(n < cur) : !(n > cur)) return { ok: false, error: `The ${sym} plan stop only moves ${short ? 'down' : 'up'}: ${money(n)} is not ${short ? 'below' : 'above'} the current ${money(cur)}.` }
  const m = await fetchDailyMarket(sym, '1mo').catch(() => null)
  if (!m?.price) return { ok: false, error: `${sym} price unavailable; try again.` }
  if (short ? n <= m.price : n >= m.price) return { ok: false, error: `A ${sym} stop at ${money(n)} is ${short ? 'at/below' : 'at/above'} the market (${money(m.price)}); it would trigger at once.` }
  const u = await sb.from('stock_plans').update({ last_stop_price: n }).eq('id', p.id)
  if (u.error) return { ok: false, error: 'Could not save the stop.' }
  return { ok: true, symbol: sym, from: cur, to: n, price: m.price, schwab: p.dry_run ? 'Paper plan.' : 'Schwab stop updates on the next market-hours bot run (≤5 min in market hours).' }
}
