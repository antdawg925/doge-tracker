/**
 * Buy $ / Short $ "place now": the user's explicit order. Places the GTC LIMIT entry at Schwab at once
 * (Schwab accepts GTC orders any time; they work in the regular session). Does NOT need the Stocks
 * Live toggle. Blocks when: TSLA, Schwab not connected / no account / expired, live orders paused
 * (kill switch), or the daily Schwab order-action cap is reached.
 */
import { accessTokenFor, createSchwabBroker, schwabConfigured, schwabHttp } from './_schwab.js'
import { LIVE_RULES, isNotShortableError } from '../shared/schwabLive.js'
import { DIP_EXCLUDES } from '../shared/dipBuys.js'
import { etDate } from '../shared/marketHours.js'

export function placeNowBlock({ symbol, conn, nowMs = Date.now() }) {
  if (DIP_EXCLUDES.has(String(symbol).toUpperCase())) return 'TSLA is never traded by the bot.'
  if (!conn || conn.status !== 'connected' || !conn.account_hash || !(Date.parse(conn.refresh_expires_at) > nowMs)) return 'Schwab is not connected. Connect it on My Bot → Stocks first.'
  if (conn.kill_switch) return 'Live orders are PAUSED (kill switch). Turn it off on My Bot → Stocks to place orders.'
  const today = etDate(nowMs)
  const n = conn.data?.actions?.day === today ? Number(conn.data.actions.n) || 0 : 0
  if (n >= LIVE_RULES.dailyActionCap) return `Daily cap of ${LIVE_RULES.dailyActionCap} Schwab order actions reached.`
  return null
}

/** @returns {{ ok, orderId?, error? }} — the plan row is updated either way. */
export async function placeEntryNow(sb, { plan, conn, nowMs = Date.now(), broker = null }) {
  const block = placeNowBlock({ symbol: plan.symbol, conn, nowMs })
  if (block) return { ok: false, error: block }
  if (!broker && !schwabConfigured()) return { ok: false, error: 'Schwab is not configured on the server.' }
  const b = broker || createSchwabBroker({ call: schwabHttp({ token: await accessTokenFor(sb, conn, { nowMs }) }), accountHash: conn.account_hash, nowMs })
  const args = { symbol: plan.symbol, qty: plan.shares, limitPrice: Number(plan.limit_price), duration: 'GOOD_TILL_CANCEL' }
  let r
  try {
    r = plan.side === 'short' ? await b.placeShortSell(args) : await b.placeLimitBuy(args)
  } catch (err) {
    const msg = String(err?.message || err).slice(0, 240)
    await sb.from('stock_plans').update({ status: 'cancelled', last_error: `Schwab refused: ${msg}` }).eq('id', plan.id)
    return { ok: false, error: plan.side === 'short' && isNotShortableError(msg) ? `Schwab says ${plan.symbol} is not shortable: ${msg}` : `Schwab refused the order: ${msg}` }
  }
  const today = etDate(nowMs)
  const n = conn.data?.actions?.day === today ? Number(conn.data.actions.n) || 0 : 0
  await sb.from('broker_connections').update({ data: { ...(conn.data || {}), actions: { day: today, n: n + 1 } }, updated_at: new Date(nowMs).toISOString() }).eq('user_id', conn.user_id).eq('broker', 'schwab')
  await sb.from('stock_plans').update({ status: 'working', buy_order_id: r.orderId, last_error: null, data: { ...(plan.data || {}), manualOrder: true, placedAt: new Date(nowMs).toISOString() } }).eq('id', plan.id)
  return { ok: true, orderId: r.orderId }
}

/** Cancel a working entry at Schwab now (Positions → Pending orders → Cancel). Marks cancelled only once Schwab confirms. */
export async function cancelEntryNow(sb, { plan, conn, nowMs = Date.now(), broker = null }) {
  if (!conn || conn.status !== 'connected' || !conn.account_hash) return { ok: false, error: 'Schwab is not connected; cancel it in Schwab directly.' }
  if (conn.kill_switch) return { ok: false, error: 'Live orders are PAUSED (kill switch), so the bot sends nothing. Cancel it in Schwab directly.' }
  const b = broker || createSchwabBroker({ call: schwabHttp({ token: await accessTokenFor(sb, conn, { nowMs }) }), accountHash: conn.account_hash, nowMs })
  const { fillFromOrder } = await import('../shared/schwabLive.js')
  const before = fillFromOrder(await b.getOrder(plan.buy_order_id).catch(() => null))
  if (before.filledQty > 0) return { ok: false, error: `Already ${before.filled ? 'filled' : `partly filled (${before.filledQty} sh)`} at Schwab; the bot is protecting it.` }
  if (before.open) {
    try {
      await b.cancel(plan.buy_order_id)
    } catch (err) {
      return { ok: false, error: `Schwab cancel failed: ${String(err?.message || err).slice(0, 200)}` }
    }
  }
  const after = fillFromOrder(await b.getOrder(plan.buy_order_id).catch(() => null))
  if (after.filledQty > 0) return { ok: false, error: 'It filled while cancelling; the bot is protecting it.' }
  if (after.open) {
    await sb.from('stock_plans').update({ data: { ...(plan.data || {}), cancelRequested: new Date(nowMs).toISOString() }, last_error: 'cancel sent, waiting for Schwab' }).eq('id', plan.id)
    return { ok: true, pending: true, message: 'Cancel sent; Schwab has not confirmed yet. The bot re-checks within 5 min.' }
  }
  await sb.from('stock_plans').update({ status: 'cancelled', last_error: 'cancelled by user (Schwab confirmed)' }).eq('id', plan.id)
  return { ok: true }
}
