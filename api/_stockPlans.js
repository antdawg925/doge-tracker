/**
 * Dip-buy stock_plans runner (called from the 5-min stocks cron).
 * Default dry-run: logs intended Schwab LIMIT BUY / STOP actions, places nothing.
 * Live: only when profiles.stocks_live AND broker_connections.live_enabled, RTH only for new orders.
 * Never touches TSLA or positions the plan did not create.
 */
import { accessTokenFor, createSchwabBroker, schwabConfigured } from './_schwab.js'
import { notify } from './_notify.js'
import { isTradingDay, etParts, stockPassFor } from '../shared/marketHours.js'
import { buildLimitBuyOrder, nextRatchetStop, shouldCancelPending, DIP_EXCLUDES } from '../shared/dipBuys.js'
import { fillFromOrder } from '../shared/schwabLive.js'

const clip = (s, n = 280) => (s == null ? null : String(s).slice(0, n))
const money = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : `$${Number(n).toFixed(Number(n) >= 1 ? 2 : 4)}`)

function rthOk(nowMs) {
  const p = etParts(nowMs)
  if (!isTradingDay(p.date, p.dow)) return false
  const mins = p.hour * 60 + p.minute
  return mins >= 9 * 60 + 30 && mins < 16 * 60 // 9:30–16:00 ET
}

async function loadConns(sb, userIds) {
  if (!userIds.length) return new Map()
  const { data } = await sb.from('broker_connections').select('*').eq('broker', 'schwab').in('user_id', userIds)
  return new Map((data || []).map((c) => [c.user_id, c]))
}

async function alert(sb, { userId, chatId, kind, title, message, urgent = false, nowMs }) {
  await sb.from('bot_alerts').insert({
    user_id: userId,
    symbol: title.split(':')[0]?.slice(0, 12) || 'STOCK',
    kind,
    title: clip(title, 120),
    message: clip(message, 500),
    level: null,
    price: null,
    data: { source: 'stock_plans' },
  }).then(() => {}, () => {})
  if (chatId) await notify(sb, { userId, chatId, text: `${title}\n${message}`, urgent, nowMs }).catch(() => {})
}

/**
 * @param sb service role
 * @param profiles [{id, telegram_chat_id, stocks_live}]
 * @param markets Map(symbol → {ok, price, bars})  daily bars with .close
 */
export async function runStockPlans(sb, { profiles, markets, nowMs = Date.now(), force = false } = {}) {
  const summary = { checked: 0, placed: 0, filled: 0, stopped: 0, cancelled: 0, raised: 0, dry: 0, errors: 0 }
  if (!profiles?.length) return summary
  const pass = force ? 'manual' : stockPassFor(nowMs)
  const inRth = rthOk(nowMs)
  const userIds = profiles.map((p) => p.id)
  const profileBy = new Map(profiles.map((p) => [p.id, p]))
  const { data: plans } = await sb
    .from('stock_plans')
    .select('*')
    .in('user_id', userIds)
    .in('status', ['pending', 'working', 'filled'])
  if (!plans?.length) return summary

  const conns = await loadConns(sb, userIds)
  const brokers = new Map()

  async function brokerFor(uid) {
    if (brokers.has(uid)) return brokers.get(uid)
    const c = conns.get(uid)
    if (!c || c.status !== 'connected' || !c.account_hash || !schwabConfigured()) {
      brokers.set(uid, null)
      return null
    }
    try {
      const token = await accessTokenFor(sb, c)
      const call = (await import('./_schwab.js')).schwabHttp({ token })
      const b = createSchwabBroker({ call, accountHash: c.account_hash, nowMs })
      brokers.set(uid, b)
      return b
    } catch {
      brokers.set(uid, null)
      return null
    }
  }

  for (const plan of plans) {
    summary.checked += 1
    const sym = String(plan.symbol || '').toUpperCase()
    const prof = profileBy.get(plan.user_id)
    const live = Boolean(prof?.stocks_live) && Boolean(conns.get(plan.user_id)?.live_enabled) && !plan.dry_run
    const spot = markets?.get(sym)?.price ?? markets?.get(sym)?.bars?.at?.(-1)?.close ?? null

    try {
      if (DIP_EXCLUDES.has(sym)) {
        await sb.from('stock_plans').update({ status: 'cancelled', last_error: 'TSLA excluded', notes: 'never touch TSLA' }).eq('id', plan.id)
        summary.cancelled += 1
        continue
      }

      // ---- pending / working: place or sync the limit buy
      if (plan.status === 'pending' || plan.status === 'working') {
        const cancel = shouldCancelPending(plan, { nowMs, spot })
        if (cancel.cancel) {
          if (live && plan.buy_order_id) {
            const b = await brokerFor(plan.user_id)
            if (b) await b.cancel(plan.buy_order_id).catch(() => {})
          }
          await sb.from('stock_plans').update({ status: cancel.reason.includes('day') ? 'expired' : 'cancelled', last_error: cancel.reason }).eq('id', plan.id)
          summary.cancelled += 1
          await alert(sb, { userId: plan.user_id, chatId: prof?.telegram_chat_id, kind: 'plan_cancelled', title: `${sym}: buy cancelled`, message: cancel.reason, nowMs })
          continue
        }

        if (plan.status === 'pending') {
          const payload = buildLimitBuyOrder({ symbol: sym, qty: plan.shares, limitPrice: Number(plan.limit_price), duration: 'GOOD_TILL_CANCEL' })
          if (!live || !inRth) {
            summary.dry += 1
            await sb.from('stock_plans').update({
              data: { ...(plan.data || {}), lastDry: { at: new Date(nowMs).toISOString(), action: 'place_limit_buy', payload, live, inRth } },
            }).eq('id', plan.id)
            if (!plan.data?.notifiedPlace) {
              await alert(sb, {
                userId: plan.user_id,
                chatId: prof?.telegram_chat_id,
                kind: 'plan_placed',
                title: `${sym}: ${live ? (inRth ? 'placing' : 'queued (RTH)') : 'DRY-RUN'} buy`,
                message: `Limit buy ${plan.shares} sh @ ${money(plan.limit_price)}, stop ${money(plan.stop_price)}, T1 ${money(plan.t1_price)}.${live ? '' : ' Live is off — nothing sent to Schwab.'}`,
                nowMs,
              })
              await sb.from('stock_plans').update({ data: { ...(plan.data || {}), notifiedPlace: true } }).eq('id', plan.id)
            }
            continue
          }
          const b = await brokerFor(plan.user_id)
          if (!b) {
            await sb.from('stock_plans').update({ last_error: 'Schwab not connected' }).eq('id', plan.id)
            summary.errors += 1
            continue
          }
          const r = await b.placeLimitBuy({ symbol: sym, qty: plan.shares, limitPrice: Number(plan.limit_price) })
          await sb.from('stock_plans').update({ status: 'working', buy_order_id: r.orderId, last_error: null }).eq('id', plan.id)
          summary.placed += 1
          await alert(sb, {
            userId: plan.user_id,
            chatId: prof?.telegram_chat_id,
            kind: 'plan_placed',
            title: `${sym}: Order placed`,
            message: `Limit buy ${plan.shares} sh @ ${money(plan.limit_price)} (order ${r.orderId}). Stop will set at ${money(plan.stop_price)} after fill.`,
            nowMs,
          })
          continue
        }

        // working: check fill
        if (plan.status === 'working' && plan.buy_order_id) {
          const b = await brokerFor(plan.user_id)
          if (!b) continue
          const fill = fillFromOrder(await b.getOrder(plan.buy_order_id))
          if (fill?.filled && fill.filledQty > 0) {
            const stopPx = Number(plan.stop_price)
            let stopOrderId = null
            if (live && inRth) {
              try {
                const sr = await b.placeStop({ symbol: sym, positionSide: 'long', qty: fill.filledQty, stopPrice: stopPx })
                stopOrderId = sr.orderId
              } catch (err) {
                await sb.from('stock_plans').update({ last_error: clip(`fill ok, stop failed: ${err.message}`) }).eq('id', plan.id)
              }
            } else {
              summary.dry += 1
            }
            await sb.from('stock_plans').update({
              status: 'filled',
              filled_at: new Date(nowMs).toISOString(),
              filled_price: fill.price ?? plan.limit_price,
              filled_shares: fill.filledQty,
              stop_order_id: stopOrderId,
              last_stop_price: stopPx,
              last_error: stopOrderId || !live ? null : 'stop not placed yet',
            }).eq('id', plan.id)
            summary.filled += 1
            await alert(sb, {
              userId: plan.user_id,
              chatId: prof?.telegram_chat_id,
              kind: 'plan_filled',
              title: `${sym}: Filled, stop set at ${money(stopPx)}`,
              message: `Bought ${fill.filledQty} sh @ ${money(fill.price ?? plan.limit_price)}.${stopOrderId ? ` Protective STOP ${stopOrderId}.` : live ? ' Stop pending (will retry).' : ' DRY-RUN: stop would be placed live.'}`,
              urgent: true,
              nowMs,
            })
          }
        }
        continue
      }

      // ---- filled: ensure stop, ratchet on close pass
      if (plan.status === 'filled') {
        const b = live ? await brokerFor(plan.user_id) : null
        // Re-place missing stop
        if (live && inRth && b && !plan.stop_order_id) {
          try {
            const sr = await b.placeStop({ symbol: sym, positionSide: 'long', qty: plan.filled_shares || plan.shares, stopPrice: Number(plan.last_stop_price || plan.stop_price) })
            await sb.from('stock_plans').update({ stop_order_id: sr.orderId, last_error: null }).eq('id', plan.id)
            await alert(sb, { userId: plan.user_id, chatId: prof?.telegram_chat_id, kind: 'plan_stop_replaced', title: `${sym}: stop re-placed at ${money(plan.last_stop_price || plan.stop_price)}`, message: `Order ${sr.orderId}`, urgent: true, nowMs })
          } catch (err) {
            await sb.from('stock_plans').update({ last_error: clip(err.message) }).eq('id', plan.id)
            summary.errors += 1
          }
        }
        // Sync stop fill → stopped
        if (live && b && plan.stop_order_id) {
          const fill = fillFromOrder(await b.getOrder(plan.stop_order_id).catch(() => null))
          if (fill?.filled) {
            await sb.from('stock_plans').update({ status: 'stopped' }).eq('id', plan.id)
            summary.stopped += 1
            await alert(sb, { userId: plan.user_id, chatId: prof?.telegram_chat_id, kind: 'plan_stopped', title: `${sym}: Stopped out`, message: `Stop filled ${fill.filledQty} sh @ ${money(fill.price)}`, urgent: true, nowMs })
            continue
          }
          // Detect cancelled stop → re-place
          const o = await b.getOrder(plan.stop_order_id).catch(() => null)
          if (o && String(o.status || '').toUpperCase() === 'CANCELED' && inRth) {
            const sr = await b.placeStop({ symbol: sym, positionSide: 'long', qty: plan.filled_shares || plan.shares, stopPrice: Number(plan.last_stop_price || plan.stop_price) })
            await sb.from('stock_plans').update({ stop_order_id: sr.orderId }).eq('id', plan.id)
            await alert(sb, { userId: plan.user_id, chatId: prof?.telegram_chat_id, kind: 'plan_stop_replaced', title: `${sym}: stop was cancelled — re-placed`, message: `Order ${sr.orderId} @ ${money(plan.last_stop_price || plan.stop_price)}`, urgent: true, nowMs })
          }
        }
        // Ratchet on close pass
        if (pass === 'close' || force) {
          const bars = markets?.get(sym)?.bars
          const close = bars?.at?.(-1)?.close ?? spot
          const cur = Number(plan.last_stop_price || plan.stop_price)
          const next = nextRatchetStop(cur, close, plan.ladder || [])
          if (next && next.stop > cur) {
            if (live && inRth && b && plan.stop_order_id) {
              await b.modifyStop(plan.stop_order_id, { symbol: sym, positionSide: 'long', qty: plan.filled_shares || plan.shares, stopPrice: next.stop })
                .then(async (r) => {
                  await sb.from('stock_plans').update({
                    last_stop_price: next.stop,
                    stop_order_id: r.orderId || plan.stop_order_id,
                    next_rung: plan.ladder?.find((x) => x.trigger > next.trigger) || null,
                  }).eq('id', plan.id)
                  summary.raised += 1
                  await alert(sb, { userId: plan.user_id, chatId: prof?.telegram_chat_id, kind: 'plan_stop_raised', title: `${sym}: Stop raised to ${money(next.stop)}`, message: `Weekly/daily close above ${money(next.trigger)}.`, nowMs })
                })
                .catch(async (err) => {
                  await sb.from('stock_plans').update({ last_error: clip(err.message) }).eq('id', plan.id)
                  summary.errors += 1
                })
            } else {
              summary.dry += 1
              await sb.from('stock_plans').update({
                data: { ...(plan.data || {}), lastDry: { at: new Date(nowMs).toISOString(), action: 'raise_stop', from: cur, to: next.stop, trigger: next.trigger } },
                last_stop_price: next.stop,
                next_rung: (plan.ladder || []).find((x) => x.trigger > next.trigger) || null,
              }).eq('id', plan.id)
              summary.raised += 1
              await alert(sb, { userId: plan.user_id, chatId: prof?.telegram_chat_id, kind: 'plan_stop_raised', title: `${sym}: Stop raised to ${money(next.stop)}${live ? '' : ' (dry-run)'}`, message: `Close above ${money(next.trigger)}.${live ? '' : ' Live off — move your Schwab stop to match.'}`, nowMs })
            }
          }
        }
      }
    } catch (err) {
      summary.errors += 1
      await sb.from('stock_plans').update({ last_error: clip(err?.message || err) }).eq('id', plan.id)
    }
  }
  return summary
}
