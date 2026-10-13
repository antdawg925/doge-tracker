/**
 * Buy dips (long) + Sell highs (short) stock_plans runner (called from the 5-min stocks cron).
 * Short: SELL_SHORT limit in RTH → on fill BUY_TO_COVER STOP above; stop ratchets DOWN only on a
 * daily close below each support rung; Schwab "not shortable" rejection → alert + cancelled.
 * Default dry-run: logs intended Schwab LIMIT BUY / STOP actions, places nothing.
 * Live: only when profiles.stocks_live AND broker_connections.live_enabled (and not paused); every
 * Schwab write (entry, stop place / move / resize) happens in regular hours only, through the kill
 * switch, the daily action cap and (entries) the Stocks pause / lock. Fills are read before any
 * cancel; partial fills are protected; stop raises saved on the after-close pass are sent to Schwab
 * by the first market-hours run (the Schwab stop is compared to the plan stop every run, never loosened).
 * Never touches TSLA or positions the plan did not create.
 */
import { accessTokenFor, createSchwabBroker, schwabConfigured } from './_schwab.js'
import { notify } from './_notify.js'
import { isTradingDay, etParts, etDate, stockPassFor, closeMinutes } from '../shared/marketHours.js'
import { buildLimitBuyOrder, nextRatchetStop, shouldCancelPending, DIP_EXCLUDES } from '../shared/dipBuys.js'
import { buildShortLimitOrder, nextShortRatchetStop } from '../shared/sellHighs.js'
import { fillFromOrder, isNotShortableError, LIVE_RULES, roundStop, sharesToProtect, tickSize } from '../shared/schwabLive.js'
import { liveOrderCheck, orderCheck } from '../shared/guard.js'
import { RISK_CAP_ACTION, openLoss, riskCapHit } from '../shared/riskCap.js'

const clip = (s, n = 280) => (s == null ? null : String(s).slice(0, n))
const money = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : `$${Number(n).toFixed(Number(n) >= 1 ? 2 : 4)}`)

function rthOk(nowMs) {
  const p = etParts(nowMs)
  if (!isTradingDay(p.date, p.dow)) return false
  const mins = p.minutes // etParts gives minutes since ET midnight (p.hour/p.minute were undefined → NaN → never RTH)
  return mins >= 9 * 60 + 30 && mins < closeMinutes(p.date) // 9:30–16:00 ET (13:00 on early-close days)
}

async function loadConns(sb, userIds) {
  if (!userIds.length) return new Map()
  const { data } = await sb.from('broker_connections').select('*').eq('broker', 'schwab').in('user_id', userIds)
  return new Map((data || []).map((c) => [c.user_id, c]))
}

async function alert(sb, { userId, chatId, kind, title, message, urgent = false, nowMs, symbol = null, short = false }) {
  // Sell highs (short) plans are tagged so Telegram + My Bot read the same way as dip buys.
  title = `${short ? 'Sell highs' : 'Buy dips'} · ${title}`
  // In-app alert log (same table the Stocks alerts + Schwab reminders use).
  const ins = await sb.from('stock_alert_log').insert({
    user_id: userId,
    symbol: String(symbol || title.split(':')[0] || 'STOCK').slice(0, 12),
    fired_at: new Date(nowMs || Date.now()).toISOString(),
    kind,
    title: clip(title, 120),
    message: clip(message, 500),
  }).then((r) => r, (e) => ({ error: e }))
  if (ins?.error) console.error('stock_plans alert log', ins.error?.message || ins.error)
  if (chatId) await notify(sb, { userId, chatId, text: `${title}\n${message}`, urgent, nowMs }).catch(() => {})
}

/**
 * @param sb service role
 * @param profiles [{id, telegram_chat_id, stocks_live}]
 * @param markets Map(symbol → {ok, price, bars})  daily bars with .close
 */
export async function runStockPlans(sb, { profiles, markets, nowMs = Date.now(), force = false, _broker = null } = {}) {
  const summary = { checked: 0, riskHalted: 0, placed: 0, filled: 0, stopped: 0, cancelled: 0, raised: 0, dry: 0, errors: 0 }
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
    if (_broker) return _broker // offline checks only (scripts/check-dip-buys.mjs)
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

  // Schwab refused the short (not shortable / no borrow) → alert + plan cancelled.
  async function notShortable(plan, why) {
    const sym = String(plan.symbol || '').toUpperCase()
    const prof = profileBy.get(plan.user_id)
    await sb.from('stock_plans').update({ status: 'cancelled', last_error: clip(`not shortable: ${why}`) }).eq('id', plan.id)
    summary.cancelled += 1
    await alert(sb, { symbol: sym, short: true, userId: plan.user_id, chatId: prof?.telegram_chat_id, kind: 'plan_not_shortable', title: `${sym}: Schwab rejected the short`, message: `Not shortable right now (${clip(why, 160)}). Plan cancelled — nothing is open.`, urgent: true, nowMs })
  }

  // ---- live helpers shared by every plan of a user
  const today = etDate(nowMs)
  const { data: guardRows } = await sb.from('stock_guard').select('*').in('user_id', userIds).eq('book', 'stocks')
  const guardBy = new Map((guardRows || []).map((g) => [g.user_id, g]))
  const actionCount = new Map()
  const actionsToday = (uid) => {
    if (!actionCount.has(uid)) {
      const c = conns.get(uid)
      actionCount.set(uid, c?.data?.actions?.day === today ? Number(c.data.actions.n) || 0 : 0)
    }
    return actionCount.get(uid)
  }
  // Same per-user counter the Stocks-tab Live code uses (broker_connections.data.actions).
  async function bump(uid) {
    const n = actionsToday(uid) + 1
    actionCount.set(uid, n)
    const c = conns.get(uid)
    if (!c) return
    c.data = { ...(c.data || {}), actions: { day: today, n } }
    await sb.from('broker_connections').update({ data: c.data, updated_at: new Date(nowMs).toISOString() }).eq('user_id', uid).eq('broker', 'schwab')
  }
  /** B6: every Schwab write goes through the kill switch, the daily action cap and (entries) the Stocks pause / lock. */
  function gate(uid, kind) {
    const c = conns.get(uid)
    if (c?.kill_switch) return { allowed: false, reason: 'Live orders paused entirely (kill switch)' }
    if (kind !== 'cancel_stop' && actionsToday(uid) >= LIVE_RULES.dailyActionCap) return { allowed: false, reason: `Daily cap of ${LIVE_RULES.dailyActionCap} Schwab order actions reached` }
    const g = guardBy.get(uid) ?? null
    return kind === 'entry' ? orderCheck(g, { kind: 'entry' }) : liveOrderCheck(g, { kind, killSwitch: false })
  }
  const holdingsBy = new Map()
  async function holdingsFor(uid, b) {
    if (!holdingsBy.has(uid)) holdingsBy.set(uid, await b.getPositions().catch(() => null))
    return holdingsBy.get(uid)
  }
  const setData = (plan, patch) => (plan.data = { ...(plan.data || {}), ...patch })

  /** Place the protective stop, or grow an existing one to `qty`. Never loosens. */
  async function placeOrResize(plan, { b, stopOrderId, stopQty, qty, stopPx, sym, posSide }) {
    if (stopOrderId && stopQty >= qty) return { stopOrderId, stopQty, error: null }
    const kind = stopOrderId ? 'tighten_stop' : 'place_stop'
    const g = gate(plan.user_id, kind)
    if (!g.allowed) return { stopOrderId, stopQty, error: clip(`stop not ${stopOrderId ? 'resized' : 'placed'}: ${g.reason}`) }
    try {
      if (stopOrderId) {
        const r = await b.modifyStop(stopOrderId, { symbol: sym, positionSide: posSide, qty, stopPrice: stopPx })
        await bump(plan.user_id)
        return { stopOrderId: r.orderId || stopOrderId, stopQty: qty, error: null }
      }
      const r = await b.placeStop({ symbol: sym, positionSide: posSide, qty, stopPrice: stopPx })
      await bump(plan.user_id)
      return { stopOrderId: r.orderId, stopQty: qty, error: null }
    } catch (err) {
      return { stopOrderId, stopQty, error: clip(`stop ${stopOrderId ? 'resize' : 'placement'} failed: ${err.message}`) }
    }
  }

  async function markFilled(plan, { b, qty, price, live, sym, posSide, short, prof, A }) {
    const stopPx = roundStop(Number(plan.last_stop_price || plan.stop_price), posSide)
    let stopOrderId = plan.stop_order_id || null
    let stopQty = Number(plan.data?.stopQty) || 0
    let err = null
    if (live && inRth && b) {
      const r = await placeOrResize(plan, { b, stopOrderId, stopQty, qty, stopPx, sym, posSide })
      ;({ stopOrderId, stopQty } = r)
      err = r.error
    } else if (live) {
      err = 'stop not placed yet (waits for market hours)'
    } else {
      summary.dry += 1
    }
    await sb.from('stock_plans').update({
      status: 'filled',
      filled_at: new Date(nowMs).toISOString(),
      filled_price: price ?? plan.limit_price,
      filled_shares: qty,
      stop_order_id: stopOrderId,
      last_stop_price: stopPx,
      data: setData(plan, { stopQty, ...(stopOrderId ? { schwabStop: stopPx } : {}) }),
      last_error: err ?? (stopOrderId || !live ? null : 'stop not placed yet'),
    }).eq('id', plan.id)
    summary.filled += 1
    await A({
      userId: plan.user_id,
      chatId: prof?.telegram_chat_id,
      kind: 'plan_filled',
      title: short ? `${sym}: Short filled${stopOrderId ? `, cover stop set at ${money(stopPx)}` : ''}` : `${sym}: Filled${stopOrderId ? `, stop set at ${money(stopPx)}` : ''}`,
      message: `${short ? 'Sold short' : 'Bought'} ${qty}${qty < Number(plan.shares) ? ` of ${plan.shares}` : ''} sh @ ${money(price ?? plan.limit_price)}.${stopOrderId ? ` Protective ${short ? 'BUY_TO_COVER ' : ''}STOP ${stopOrderId} for ${stopQty} sh.` : live ? ` Stop NOT placed yet: ${err || 'will retry'}.` : ' DRY-RUN: stop would be placed live.'}`,
      urgent: true,
      nowMs,
    })
  }

  /** B5: a partly filled entry that is still working → protect the shares filled so far. */
  async function protectPartial(plan, { b, qty, live, sym, posSide, short, prof, A }) {
    const stopPx = roundStop(Number(plan.last_stop_price || plan.stop_price), posSide)
    let stopOrderId = plan.stop_order_id || null
    let stopQty = Number(plan.data?.stopQty) || 0
    let err = null
    if (live && inRth && b) {
      const r = await placeOrResize(plan, { b, stopOrderId, stopQty, qty, stopPx, sym, posSide })
      ;({ stopOrderId, stopQty } = r)
      err = r.error
    } else if (live) {
      err = 'partial fill: stop waits for market hours'
    } else {
      err = 'partial fill: Live off/paused, shares not protected by the bot'
    }
    const grew = qty !== Number(plan.filled_shares || 0)
    if (!grew && stopOrderId === (plan.stop_order_id || null) && err === plan.last_error) return
    await sb.from('stock_plans').update({ filled_shares: qty, stop_order_id: stopOrderId, data: setData(plan, { stopQty, partial: true, ...(stopOrderId ? { schwabStop: stopPx } : {}) }), last_error: err }).eq('id', plan.id)
    if (grew) {
      await A({ userId: plan.user_id, chatId: prof?.telegram_chat_id, kind: 'plan_partial', title: `${sym}: Partial fill ${qty}/${plan.shares} sh`, message: stopOrderId ? `${short ? 'Buy-to-cover stop' : 'Stop'} ${stopOrderId} covers ${stopQty} sh at ${money(stopPx)}. Rest of the order is still working.` : `Not protected yet: ${err}.`, urgent: true, nowMs })
    }
  }

  /**
   * B1/B2/B8/B11-safe: in market hours, make the Schwab stop match the plan: re-place a missing /
   * cancelled stop (only for shares still held), tighten to the plan stop (never loosen), shrink to
   * the shares still held. One read of positions per user.
   */
  async function syncStop(plan, { b, stopFill, want, appQty, sym, posSide, short, prof, A, spot }) {
    const flagOnce = async (key, title, message) => {
      const flags = plan.data?.flags || {}
      if (flags[key]) return
      await sb.from('stock_plans').update({ data: setData(plan, { flags: { ...flags, [key]: new Date(nowMs).toISOString() } }), last_error: clip(message) }).eq('id', plan.id)
      await A({ userId: plan.user_id, chatId: prof?.telegram_chat_id, kind: 'plan_stop_flag', title: `${sym}: ${title}`, message, urgent: true, nowMs })
    }
    const holdings = await holdingsFor(plan.user_id, b)
    if (!holdings) {
      await sb.from('stock_plans').update({ last_error: 'could not read Schwab positions; stop not changed' }).eq('id', plan.id)
      return
    }
    const prot = sharesToProtect({ symbol: sym, side: posSide, appShares: appQty, holdings })
    const dead = !plan.stop_order_id || (stopFill && !stopFill.open && !stopFill.filled && stopFill.status !== 'UNKNOWN')
    if (prot.status !== 'ok') {
      await flagOnce('not_held', `stop not ${dead ? 're-placed' : 'changed'}`, `${prot.message}. If you closed it yourself, cancel the plan.`)
      return
    }
    const crossed = Number.isFinite(spot) && spot > 0 && (short ? want <= spot : want >= spot)
    if (dead) {
      if (crossed) return flagOnce(`crossed_${want}`, 'stop already crossed', `Plan stop ${money(want)} vs price ${money(spot)} would fill immediately. Not placed — review it.`)
      const r = await placeOrResize(plan, { b, stopOrderId: null, stopQty: 0, qty: prot.qty, stopPx: want, sym, posSide })
      await sb.from('stock_plans').update({ stop_order_id: r.stopOrderId, data: setData(plan, { stopQty: r.stopQty, ...(r.stopOrderId ? { schwabStop: want } : {}) }), last_error: r.error }).eq('id', plan.id)
      if (r.stopOrderId) await A({ userId: plan.user_id, chatId: prof?.telegram_chat_id, kind: 'plan_stop_replaced', title: `${sym}: ${short ? 'cover ' : ''}stop ${plan.stop_order_id ? 're-placed' : 'placed'} at ${money(want)}`, message: `Order ${r.stopOrderId} for ${r.stopQty} sh.`, urgent: true, nowMs })
      else summary.errors += 1
      return
    }
    if (!stopFill?.open) return // could not read the stop this run
    const at = Number(stopFill.stopPrice)
    const curQty = Number(stopFill.qty) || Number(plan.data?.stopQty) || appQty
    const tick = tickSize(at || want)
    const tighter = Number.isFinite(at) && at > 0 && (short ? want < at - tick / 2 : want > at + tick / 2)
    const qtyTarget = Math.min(curQty, prot.qty)
    const newStop = tighter && !crossed ? want : at
    if (newStop === at && qtyTarget === curQty) {
      if (tighter && crossed) await flagOnce(`crossed_${want}`, 'stop not moved (already crossed)', `Plan stop ${money(want)} vs price ${money(spot)} would fill immediately. Schwab stop kept at ${money(at)}.`)
      return
    }
    const g = gate(plan.user_id, 'tighten_stop')
    if (!g.allowed) {
      await sb.from('stock_plans').update({ last_error: clip(`Schwab stop not updated: ${g.reason}`) }).eq('id', plan.id)
      return
    }
    try {
      const r = await b.modifyStop(plan.stop_order_id, { symbol: sym, positionSide: posSide, qty: qtyTarget, stopPrice: newStop })
      await bump(plan.user_id)
      await sb.from('stock_plans').update({ stop_order_id: r.orderId || plan.stop_order_id, data: setData(plan, { stopQty: qtyTarget, schwabStop: newStop }), last_error: null }).eq('id', plan.id)
      const parts = []
      if (newStop !== at) parts.push(`${short ? 'lowered' : 'raised'} ${money(at)} → ${money(newStop)}`)
      if (qtyTarget !== curQty) parts.push(`resized ${curQty} → ${qtyTarget} sh (shares held at Schwab)`)
      await A({ userId: plan.user_id, chatId: prof?.telegram_chat_id, kind: 'plan_stop_raised', title: `${sym}: Schwab ${short ? 'cover ' : ''}stop updated`, message: `${parts.join('; ')}. Order ${r.orderId || plan.stop_order_id}.`, nowMs })
    } catch (err) {
      await sb.from('stock_plans').update({ last_error: clip(`Schwab stop update failed: ${err.message}`) }).eq('id', plan.id)
      summary.errors += 1
    }
  }

  for (const plan of plans) {
    summary.checked += 1
    const sym = String(plan.symbol || '').toUpperCase()
    const prof = profileBy.get(plan.user_id)
    // Every gate, server-side: plan not dry-run + Stocks Live + Schwab connected + Live Schwab stops ON
    // + live orders not paused (kill switch: no place / move / cancel). RTH is checked per action below.
    const conn = conns.get(plan.user_id)
    // Buy $ / Short $ placed at once (data.manualOrder) = his explicit order: managed without the Live toggles.
    const live = !plan.dry_run && conn?.status === 'connected' && !conn?.kill_switch && (Boolean(plan.data?.manualOrder) || (Boolean(prof?.stocks_live) && Boolean(conn?.live_enabled)))
    const spot = markets?.get(sym)?.price ?? markets?.get(sym)?.bars?.at?.(-1)?.close ?? null
    const short = plan.side === 'short'
    const posSide = short ? 'short' : 'long'
    const entryWord = short ? 'short' : 'buy'
    const A = (o) => alert(sb, { ...o, symbol: sym, short })

    try {
      if (DIP_EXCLUDES.has(sym)) {
        await sb.from('stock_plans').update({ status: 'cancelled', last_error: 'TSLA excluded', notes: 'never touch TSLA' }).eq('id', plan.id)
        summary.cancelled += 1
        continue
      }

      // ---- Risk cap (emergency kill switch, separate from the stop). Halted plans: no place / move /
      // cancel at all. Only a read-only check of an already-resting stop so a stop-out still records.
      if (plan.risk_tripped_at) {
        summary.riskHalted += 1
        if (live && plan.status === 'filled' && plan.stop_order_id) {
          const b = await brokerFor(plan.user_id)
          const fill = b ? fillFromOrder(await b.getOrder(plan.stop_order_id).catch(() => null)) : null
          if (fill?.filled) {
            await sb.from('stock_plans').update({ status: 'stopped' }).eq('id', plan.id)
            summary.stopped += 1
            await A({ userId: plan.user_id, chatId: prof?.telegram_chat_id, kind: 'plan_stopped', title: `${sym}: Stopped out`, message: `Resting ${short ? 'buy-to-cover ' : ''}stop filled ${fill.filledQty} sh @ ${money(fill.price)} (plan was halted by Risk cap).`, urgent: true, nowMs })
          }
        }
        continue
      }
      if (plan.status === 'filled' && Number(plan.risk_cap_usd) > 0) {
        const qty = plan.filled_shares || plan.shares
        const loss = openLoss({ side: posSide, entry: plan.filled_price || plan.limit_price, price: spot, qty })
        if (riskCapHit(plan.risk_cap_usd, loss)) {
          // Conditional update = exactly one trip (and one alert) even if two runs overlap.
          const { data: tripped } = await sb.from('stock_plans')
            .update({ risk_tripped_at: new Date(nowMs).toISOString(), risk_trip_loss: Number(loss.toFixed(2)), last_error: `risk cap hit: loss ${money(loss)} > cap ${money(plan.risk_cap_usd)}` })
            .eq('id', plan.id).is('risk_tripped_at', null).select('id')
          summary.riskHalted += 1
          if (tripped?.length) {
            if (RISK_CAP_ACTION === 'halt_and_exit') {
              // TODO(Anthony decision pending): flatten at market here. Intentionally not implemented.
            }
            await A({
              userId: plan.user_id,
              chatId: prof?.telegram_chat_id,
              kind: 'plan_risk_cap',
              title: `🚨 ${sym}: RISK HIT — bot stopped`,
              message: `${short ? 'Short' : 'Long'} ${qty} sh open loss ${money(loss)} > your Risk cap ${money(plan.risk_cap_usd)} @ ${money(spot)}.${plan.dry_run ? ' (paper plan)' : ''} The bot will place, move or cancel nothing more for it. ${live && plan.stop_order_id ? 'Your resting Schwab stop stays in place.' : 'Nothing is being sold.'} Raise Risk or tap Resume on Positions to re-arm.`,
              urgent: true,
              nowMs,
            })
          }
          continue
        }
      }

      // ---- pending / working: place or sync the entry order
      if (plan.status === 'pending' || plan.status === 'working') {
        // B3: for a working order, read Schwab FIRST. A fill always wins over the cancel rules.
        let b = null
        let order = null
        let fill = null
        if (plan.status === 'working' && plan.buy_order_id) {
          b = await brokerFor(plan.user_id)
          if (b) {
            order = await b.getOrder(plan.buy_order_id).catch(() => null)
            fill = order ? fillFromOrder(order) : null
          }
        }
        const filledQty = fill?.filledQty > 0 ? Math.floor(fill.filledQty) : 0

        if (order && String(order?.status || '').toUpperCase() === 'REJECTED' && !(filledQty > 0)) {
          const why = order?.statusDescription || order?.cancelMessage || order?.rejectReason || 'REJECTED'
          if (short && isNotShortableError(why)) {
            await notShortable(plan, why)
          } else {
            await sb.from('stock_plans').update({ status: 'cancelled', last_error: clip(`Schwab rejected: ${why}`) }).eq('id', plan.id)
            summary.cancelled += 1
            await A({ userId: plan.user_id, chatId: prof?.telegram_chat_id, kind: 'plan_rejected', title: `${sym}: Schwab rejected the ${entryWord}`, message: `${clip(why, 160)}. Plan cancelled.`, urgent: true, nowMs })
          }
          continue
        }

        // B10: paper (dry-run) plans simulate the entry fill from daily bars (low/high touched the limit).
        if (plan.dry_run && plan.status === 'pending') {
          const sim = simulateEntry(plan, markets?.get(sym)?.bars, short)
          if (sim) {
            await sb.from('stock_plans').update({
              status: 'filled',
              filled_at: new Date(sim.t || nowMs).toISOString(),
              filled_price: sim.price,
              filled_shares: plan.shares,
              last_stop_price: Number(plan.last_stop_price || plan.stop_price),
              data: { ...(plan.data || {}), simulated: true, simFill: { date: sim.date, price: sim.price } },
            }).eq('id', plan.id)
            summary.filled += 1
            await A({ userId: plan.user_id, chatId: prof?.telegram_chat_id, kind: 'plan_filled', title: `${sym}: Paper ${entryWord} filled @ ${money(sim.price)}`, message: `Simulated from the ${sim.date} daily bar (paper plan, nothing at Schwab). Paper stop ${money(plan.stop_price)}.`, nowMs })
            continue
          }
        }

        // B4: the Cancel button only flags the plan; the runner cancels at Schwab first, then marks it.
        const cancel = plan.data?.cancelRequested ? { cancel: true, reason: 'cancelled by user' } : shouldCancelPending(plan, { nowMs, spot })
        const orderDone = fill && !fill.open
        if (fill && (fill.filled || (filledQty > 0 && (cancel.cancel || orderDone)))) {
          // Full fill, or a partial fill whose entry is ending: cancel the unfilled rest, protect what filled.
          if (!fill.filled && fill.open) {
            if (!live) {
              await sb.from('stock_plans').update({ last_error: `partial fill ${filledQty} sh; remaining order ${plan.buy_order_id} still open at Schwab (Live off/paused, cannot cancel)` }).eq('id', plan.id)
              continue
            }
            try {
              await b.cancel(plan.buy_order_id)
              await bump(plan.user_id)
            } catch (err) {
              await sb.from('stock_plans').update({ last_error: clip(`cancel of unfilled rest failed: ${err.message}`) }).eq('id', plan.id)
              summary.errors += 1
              continue
            }
          }
          await markFilled(plan, { b, qty: filledQty, price: fill.price, live, sym, posSide, short, prof, A, entryWord })
          continue
        }

        if (cancel.cancel) {
          if (plan.buy_order_id) {
            // B4/B3: never mark cancelled while the entry may still be live at Schwab.
            if (!b || !order) {
              await sb.from('stock_plans').update({ last_error: clip(`${cancel.reason}: could not read Schwab order ${plan.buy_order_id}; not cancelled yet (will retry)`) }).eq('id', plan.id)
              summary.errors += 1
              continue
            }
            if (fill?.open) {
              if (!live) {
                await sb.from('stock_plans').update({ last_error: clip(`${cancel.reason}: order ${plan.buy_order_id} is still open at Schwab and Live is off/paused. Cancel it at Schwab or turn Live on.`) }).eq('id', plan.id)
                if (!plan.data?.cancelBlockedAlerted) {
                  await A({ userId: plan.user_id, chatId: prof?.telegram_chat_id, kind: 'plan_cancel_blocked', title: `${sym}: ${entryWord} should be cancelled — still open at Schwab`, message: `${cancel.reason}. Live is off or paused, so the bot can't cancel order ${plan.buy_order_id}. Cancel it at Schwab (or turn Live on).`, urgent: true, nowMs })
                  await sb.from('stock_plans').update({ data: { ...(plan.data || {}), cancelBlockedAlerted: true } }).eq('id', plan.id)
                }
                continue
              }
              try {
                await b.cancel(plan.buy_order_id)
                await bump(plan.user_id)
              } catch (err) {
                await sb.from('stock_plans').update({ last_error: clip(`cancel failed: ${err.message}`) }).eq('id', plan.id)
                summary.errors += 1
                continue
              }
              const after = fillFromOrder(await b.getOrder(plan.buy_order_id).catch(() => null))
              if (after.filledQty > 0) {
                await markFilled(plan, { b, qty: Math.floor(after.filledQty), price: after.price, live, sym, posSide, short, prof, A, entryWord })
                continue
              }
              if (after.open || after.status === 'UNKNOWN') {
                await sb.from('stock_plans').update({ last_error: 'cancel sent, waiting for Schwab to confirm' }).eq('id', plan.id)
                continue
              }
            }
          }
          await sb.from('stock_plans').update({ status: cancel.reason.includes('day') ? 'expired' : 'cancelled', last_error: cancel.reason }).eq('id', plan.id)
          summary.cancelled += 1
          await A({ userId: plan.user_id, chatId: prof?.telegram_chat_id, kind: 'plan_cancelled', title: `${sym}: ${entryWord} cancelled`, message: `${cancel.reason}${plan.buy_order_id ? ` (order ${plan.buy_order_id} cancelled at Schwab)` : ''}`, nowMs })
          continue
        }

        // B5: partial fill on a still-working entry → protect the shares filled so far.
        if (plan.status === 'working' && filledQty > 0 && fill?.open) {
          await protectPartial(plan, { b, qty: filledQty, live, sym, posSide, short, prof, A })
          continue
        }

        if (plan.status === 'pending') {
          const payload = (short ? buildShortLimitOrder : buildLimitBuyOrder)({ symbol: sym, qty: plan.shares, limitPrice: Number(plan.limit_price), duration: 'GOOD_TILL_CANCEL' })
          // B6: entries also obey the daily action cap and the Stocks pause / lock.
          const g = live && inRth ? gate(plan.user_id, 'entry') : { allowed: true }
          if (!live || !inRth || !g.allowed) {
            summary.dry += 1
            await sb.from('stock_plans').update({
              data: { ...(plan.data || {}), lastDry: { at: new Date(nowMs).toISOString(), action: short ? 'place_limit_sell_short' : 'place_limit_buy', payload, live, inRth, blocked: g.allowed ? null : g.reason } },
              ...(g.allowed ? {} : { last_error: clip(`not placed: ${g.reason}`) }),
            }).eq('id', plan.id)
            if (!plan.data?.notifiedPlace) {
              await A({
                userId: plan.user_id,
                chatId: prof?.telegram_chat_id,
                kind: 'plan_placed',
                title: `${sym}: ${live ? (!g.allowed ? 'blocked' : inRth ? 'placing' : 'queued (RTH)') : plan.dry_run ? 'DRY-RUN' : 'waiting (Live off)'} ${entryWord}`,
                message: (short
                  ? `Limit SELL SHORT ${plan.shares} sh @ ${money(plan.limit_price)}, buy-to-cover stop ${money(plan.stop_price)}, cover target ${money(plan.t1_price)}.`
                  : `Limit buy ${plan.shares} sh @ ${money(plan.limit_price)}, stop ${money(plan.stop_price)}, T1 ${money(plan.t1_price)}.`) +
                  (!g.allowed ? ` Not sent: ${g.reason}.` : live ? '' : plan.dry_run ? ' Live is off — nothing sent to Schwab.' : ' Real plan: waits until Stocks Live + Live Schwab stops are on (and not paused). Nothing sent yet.'),
                nowMs,
              })
              await sb.from('stock_plans').update({ data: { ...(plan.data || {}), notifiedPlace: true } }).eq('id', plan.id)
            }
            continue
          }
          b = await brokerFor(plan.user_id)
          if (!b) {
            await sb.from('stock_plans').update({ last_error: 'Schwab not connected' }).eq('id', plan.id)
            summary.errors += 1
            continue
          }
          let r
          try {
            r = short
              ? await b.placeShortSell({ symbol: sym, qty: plan.shares, limitPrice: Number(plan.limit_price) })
              : await b.placeLimitBuy({ symbol: sym, qty: plan.shares, limitPrice: Number(plan.limit_price) })
            await bump(plan.user_id)
          } catch (err) {
            if (short && isNotShortableError(err?.message)) {
              await notShortable(plan, err.message)
              continue
            }
            throw err
          }
          await sb.from('stock_plans').update({ status: 'working', buy_order_id: r.orderId, last_error: null }).eq('id', plan.id)
          summary.placed += 1
          await A({
            userId: plan.user_id,
            chatId: prof?.telegram_chat_id,
            kind: 'plan_placed',
            title: `${sym}: Order placed`,
            message: short
              ? `Limit SELL SHORT ${plan.shares} sh @ ${money(plan.limit_price)} (order ${r.orderId}). Buy-to-cover stop will set at ${money(plan.stop_price)} after fill.`
              : `Limit buy ${plan.shares} sh @ ${money(plan.limit_price)} (order ${r.orderId}). Stop will set at ${money(plan.stop_price)} after fill.`,
            nowMs,
          })
        }
        continue
      }

      // ---- filled: keep the Schwab stop in sync with the plan stop; ratchet on the close pass only
      if (plan.status === 'filled') {
        const want = roundStop(Number(plan.last_stop_price || plan.stop_price), posSide)
        const appQty = Number(plan.filled_shares || plan.shares)

        // B10: paper plans simulate the stop-out from daily bars after the fill day.
        if (plan.dry_run) {
          const out = simulateStop(plan, markets?.get(sym)?.bars, short, want)
          if (out) {
            const pnl = (short ? Number(plan.filled_price) - out.price : out.price - Number(plan.filled_price)) * appQty
            await sb.from('stock_plans').update({ status: 'stopped', data: { ...(plan.data || {}), simulated: true, simExit: { date: out.date, price: out.price, pnl: Number(pnl.toFixed(2)) } } }).eq('id', plan.id)
            summary.stopped += 1
            await A({ userId: plan.user_id, chatId: prof?.telegram_chat_id, kind: 'plan_stopped', title: `${sym}: Paper stop hit @ ${money(out.price)}`, message: `Simulated from the ${out.date} daily bar. Paper P/L ${pnl >= 0 ? '+' : '−'}${money(Math.abs(pnl))}.`, nowMs })
            continue
          }
        }

        const b = live ? await brokerFor(plan.user_id) : null
        let stopFill = null
        if (b && plan.stop_order_id) {
          // B17: one read of the stop order per run.
          const so = await b.getOrder(plan.stop_order_id).catch(() => null)
          stopFill = so ? fillFromOrder(so) : null
          if (stopFill?.filled) {
            await sb.from('stock_plans').update({ status: 'stopped' }).eq('id', plan.id)
            summary.stopped += 1
            await A({ userId: plan.user_id, chatId: prof?.telegram_chat_id, kind: 'plan_stopped', title: short ? `${sym}: Stopped out (short covered)` : `${sym}: Stopped out`, message: `${short ? 'Buy-to-cover stop' : 'Stop'} filled ${stopFill.filledQty} sh @ ${money(stopFill.price)}`, urgent: true, nowMs })
            continue
          }
        }

        if (b && inRth) {
          await syncStop(plan, { b, stopFill, want, appQty, sym, posSide, short, prof, A, spot })
        }

        // B9: ratchet on completed daily candles only (the after-close pass), never on a manual refresh.
        if (pass === 'close') {
          const bar = markets?.get(sym)?.bars?.at?.(-1)
          const close = bar && (!bar.date || bar.date === today) ? bar.close : null
          if (Number.isFinite(close)) {
            const cur = Number(plan.last_stop_price || plan.stop_price)
            const next = short ? nextShortRatchetStop(cur, close, plan.ladder || []) : nextRatchetStop(cur, close, plan.ladder || [])
            const better = next && (short ? next.stop < cur : next.stop > cur)
            const nextRung = (trig) => (short ? (plan.ladder || []).find((x) => x.trigger < trig) : (plan.ladder || []).find((x) => x.trigger > trig)) || null
            const moved = short ? 'lowered' : 'raised'
            const why = short ? `Daily close below ${money(next?.trigger)} (support rung).` : `Daily close above ${money(next?.trigger)}.`
            if (better) {
              // B1: stock orders go out in regular hours only, so the plan stop is saved now and the
              // Schwab stop is modified by the first market-hours run (syncStop compares to Schwab).
              await sb.from('stock_plans').update({
                data: { ...(plan.data || {}), lastRatchet: { at: new Date(nowMs).toISOString(), action: short ? 'lower_stop' : 'raise_stop', from: cur, to: next.stop, trigger: next.trigger } },
                last_stop_price: next.stop,
                next_rung: nextRung(next.trigger),
              }).eq('id', plan.id)
              summary.raised += 1
              const tail = plan.dry_run ? ' (paper plan)' : live ? ' Schwab stop moves at the next open (9:30 ET).' : ' Live off — move your Schwab stop to match.'
              await A({ userId: plan.user_id, chatId: prof?.telegram_chat_id, kind: 'plan_stop_raised', title: `${sym}: ${short ? 'Cover stop' : 'Stop'} ${moved} to ${money(next.stop)}${plan.dry_run ? ' (paper)' : ''}`, message: `${why}${tail}`, nowMs })
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

/** B10: paper entry fill from daily bars since the plan was created (limit touched). */
export function simulateEntry(plan, bars, short) {
  if (!bars?.length || !plan.created_at) return null
  const from = etDate(Date.parse(plan.created_at))
  const lim = Number(plan.limit_price)
  for (const b of bars) {
    if (!b?.date || b.date < from || !Number.isFinite(b.low) || !Number.isFinite(b.high)) continue
    if (short ? b.high >= lim : b.low <= lim) {
      // A gap through the limit fills at the open (better price) on later days; creation day fills at the limit.
      const gap = b.date > from && Number.isFinite(b.open) && (short ? b.open > lim : b.open < lim)
      return { date: b.date, t: b.t, price: gap ? b.open : lim }
    }
  }
  return null
}

/** B10: paper stop-out from daily bars after the fill day and after the last stop move. */
export function simulateStop(plan, bars, short, stop) {
  if (!bars?.length || !plan.filled_at || !(stop > 0)) return null
  let from = etDate(Date.parse(plan.filled_at))
  const moved = plan.data?.lastRatchet?.at ? etDate(Date.parse(plan.data.lastRatchet.at)) : null
  if (moved && moved > from) from = moved
  for (const b of bars) {
    if (!b?.date || b.date <= from || !Number.isFinite(b.low) || !Number.isFinite(b.high)) continue
    if (short ? b.high >= stop : b.low <= stop) {
      const gap = Number.isFinite(b.open) && (short ? b.open > stop : b.open < stop)
      return { date: b.date, price: gap ? b.open : stop }
    }
  }
  return null
}
