/**
 * LIVE Schwab stop orders for the stock runner + connection housekeeping (server only).
 * Rules live in shared/schwabLive.js (pure, tested); this file does the I/O.
 * Every Schwab request/response summary is logged to stock_paper_events as kind
 * 'live_request' (method, path with the account hash redacted, status, ms, order id; never
 * tokens). Errors are logged and flagged per position; they never fail the run.
 */
import { etDate } from '../shared/marketHours.js'
import { LIVE_RULES, OPEN_STATUSES as OPEN, connectionLive, fillFromOrder, instructionFor, planLiveAction, remindersDue, stopString } from '../shared/schwabLive.js'
import { accessTokenFor, createSchwabBroker, schwabConfigured, schwabHttp } from './_schwab.js'
import { notify, notifyLines } from './_notify.js'

const clip = (s, n = 300) => (s == null ? null : String(s).slice(0, n))
const money = (n) => (Number.isFinite(n) ? `$${stopString(n)}` : '—')

export const LIVE_ORDER_COLS = [
  'position_id', 'user_id', 'symbol', 'position_side', 'instruction', 'order_id', 'status', 'stop_price', 'qty', 'held_qty',
  'adopted', 'placed_at', 'last_modified_day', 'last_checked_at', 'fill_price', 'filled_at', 'flag', 'foreign_stops', 'data',
]

export async function loadConnections(sb, userIds) {
  if (!userIds.length) return new Map()
  const { data, error } = await sb.from('broker_connections').select('*').eq('broker', 'schwab').in('user_id', userIds)
  if (error) throw new Error(`broker_connections: ${error.message}`)
  return new Map((data || []).map((c) => [c.user_id, c]))
}

const sameFlag = (a, b) => (a?.code || null) === (b?.code || null) && (a?.message || null) === (b?.message || null)

/**
 * @param ctx.positions active stock_positions rows of this run
 * @param ctx.snapshots Map(positionId → engine snapshot) from this run
 * @param ctx.guardFor  (userId) → stocks guard (shared/guard.js shape)
 */
export async function runLive(sb, { positions, snapshots, guardFor, pass, nowMs, runId, profileBy, fetchImpl = fetch }) {
  const summary = { users: 0, actions: 0, errors: 0, flags: 0 }
  if (!schwabConfigured()) return { ...summary, skipped: 'schwab not configured' }
  const livePos = positions.filter((p) => p.live)
  if (!livePos.length) return summary
  const uids = [...new Set(livePos.map((p) => p.user_id))]
  const conns = await loadConnections(sb, uids)
  const { data: loRows, error: loErr } = await sb.from('stock_live_orders').select('*').in('position_id', livePos.map((p) => p.id))
  if (loErr) throw new Error(`stock_live_orders: ${loErr.message}`)
  const loBy = new Map((loRows || []).map((r) => [r.position_id, r]))
  const today = etDate(nowMs)
  const iso = new Date(nowMs).toISOString()

  for (const uid of uids) {
    summary.users += 1
    const mine = livePos.filter((p) => p.user_id === uid)
    const conn = conns.get(uid) || null
    const events = []
    const alerts = []
    const upserts = []
    const ev = (kind, p, extra = {}) => events.push({ user_id: uid, run_id: runId, position_id: p?.id ?? null, symbol: p?.symbol ?? 'SCHWAB', at: iso, kind, ...extra })
    const baseRow = (p) => ({
      position_id: p.id, user_id: uid, symbol: p.symbol, position_side: p.side, instruction: instructionFor(p.side), status: 'none',
      order_id: null, stop_price: null, qty: null, held_qty: null, adopted: false, placed_at: null, last_modified_day: null,
      fill_price: null, filled_at: null, flag: null, foreign_stops: [], data: {},
    })
    const setFlag = (p, row, f) => {
      const next = f ? { code: f.code, message: f.message, at: sameFlag(row.flag, f) ? row.flag?.at ?? iso : iso } : null
      if (f && !sameFlag(row.flag, f)) {
        summary.flags += 1
        ev('live_flag', p, { reason: clip(`LIVE ${f.message}`), data: { live: true, code: f.code } })
        if (['stop_crossed', 'not_found', 'jump_cap', 'own_stop', 'gone', 'daily_cap', 'error', 'expired'].includes(f.code)) {
          alerts.push({ position_id: p.id, symbol: p.symbol, kind: `live_${f.code}`, title: `${p.symbol}: LIVE ${f.code === 'stop_crossed' ? 'stop already crossed, review' : f.code.replace(/_/g, ' ')}`, message: f.message })
        }
      }
      row.flag = next
    }

    const gate = connectionLive(conn, nowMs)
    if (!gate.ok) {
      // Watch-only for this user (not connected / expired / kill switch / Live off): just keep flags current.
      for (const p of mine) {
        const row = { ...baseRow(p), ...(loBy.get(p.id) || {}) }
        const f = gate.code === 'live_off' ? null : { code: gate.code, message: gate.message }
        if (!sameFlag(row.flag, f)) {
          setFlag(p, row, f)
          upserts.push({ ...row, last_checked_at: iso })
        }
      }
      await persist(sb, { upserts, events, alerts, uid, iso, profileBy })
      continue
    }

    let broker
    let holdings
    let orders
    let quotes = new Map()
    try {
      const token = await accessTokenFor(sb, conn, { nowMs, fetchImpl })
      const call = schwabHttp({
        token,
        fetchImpl,
        log: (r) => ev('live_request', null, { reason: clip(`LIVE ${r.method} ${r.path} → ${r.status || 'network'} (${r.ms} ms)${r.orderId ? ` order ${r.orderId}` : ''}${r.error ? `: ${r.error}` : ''}`), data: { live: true, ...r } }),
      })
      broker = createSchwabBroker({ call, accountHash: conn.account_hash, nowMs })
      holdings = await broker.getPositions()
      orders = await broker.getOrders()
      quotes = await broker.getQuotes([...new Set(mine.map((p) => p.symbol))]).catch(() => new Map())
    } catch (err) {
      summary.errors += 1
      ev('live_error', null, { reason: clip(`LIVE ${err?.message || err}`), data: { live: true, status: err?.status ?? null } })
      const expired = conn.status === 'expired'
      for (const p of mine) {
        const row = { ...baseRow(p), ...(loBy.get(p.id) || {}) }
        setFlag(p, row, expired ? { code: 'expired', message: 'Schwab connection expired: watch-only until you reconnect' } : { code: 'error', message: clip(`Schwab: ${err?.message || err}`, 200) })
        upserts.push({ ...row, last_checked_at: iso })
      }
      await persist(sb, { upserts, events, alerts, uid, iso, profileBy })
      continue
    }

    const counter = conn.data?.actions?.day === today ? Number(conn.data.actions.n) || 0 : 0
    let actionsToday = counter
    for (const p of mine) {
      const row = { ...baseRow(p), ...(loBy.get(p.id) || {}) }
      row.data = { ...(row.data || {}) }
      try {
        // Reconcile the bot's own order first (fills, cancels at Schwab, live stop/qty).
        if (row.status === 'working' && row.order_id) {
          const listed = orders.find((o) => String(o.orderId) === String(row.order_id))
          const f = fillFromOrder(listed || (await broker.getOrder(row.order_id)))
          if (f.filled) {
            Object.assign(row, { status: 'filled', fill_price: f.price, filled_at: f.closeTime || iso })
            ev('live_filled', p, { fill_price: f.price, qty: f.filledQty, old_price: row.stop_price, reason: clip(`LIVE Schwab stop filled: ${f.filledQty} ${p.symbol} @ ${money(f.price)}`), data: { live: true, orderId: row.order_id } })
            alerts.push({ position_id: p.id, symbol: p.symbol, kind: 'live_filled', title: `${p.symbol}: Schwab stop FILLED`, message: `${f.filledQty} sh @ ${money(f.price)} (stop ${money(row.stop_price)}). Close the position in the app when you've checked Schwab.`, level: row.stop_price, price: f.price })
          } else if (!f.open) {
            row.status = 'gone'
            row.data.goneReason = `The bot's order ${row.order_id} is ${f.status} at Schwab. Turn Live off and on to place a new one.`
          } else {
            if (f.stopPrice > 0) row.stop_price = f.stopPrice
            if (f.qty > 0) row.qty = f.qty
          }
        }
        const snap = snapshots.get(p.id)
        const price = quotes.get(p.symbol) ?? snap?.price
        const plan = planLiveAction({ conn, position: p, snapshot: snap, liveOrder: row, holdings, openOrders: orders, price, pass, today, actionsToday, guard: guardFor(uid), nowMs })
        row.foreign_stops = plan.foreign || []
        const h = holdings.find((x) => x.symbol === p.symbol)
        row.held_qty = h ? (p.side === 'short' ? h.shortQty : h.longQty) : 0
        row.data.lastPlan = { action: plan.action, pending: plan.pending ?? null, price: price ?? null, priceSource: quotes.has(p.symbol) ? 'schwab' : 'yahoo', target: snap?.stop ?? null }
        if (plan.action === 'place') {
          actionsToday += 1
          const r = await broker.placeStop({ symbol: p.symbol, positionSide: p.side, qty: plan.qty, stopPrice: plan.stopPrice })
          Object.assign(row, { order_id: r.orderId, status: 'working', stop_price: plan.stopPrice, qty: plan.qty, placed_at: iso, adopted: false })
          summary.actions += 1
          ev('live_placed', p, { new_price: plan.stopPrice, qty: plan.qty, reason: clip(`LIVE placed Schwab STOP ${instructionFor(p.side)} ${plan.qty} ${p.symbol} @ ${money(plan.stopPrice)} GTC (order ${r.orderId})`), guard_note: plan.note, data: { live: true, orderId: r.orderId } })
          alerts.push({ position_id: p.id, symbol: p.symbol, kind: 'live_placed', title: `${p.symbol}: Schwab stop placed at ${money(plan.stopPrice)}`, message: `${instructionFor(p.side)} ${plan.qty} sh, STOP, good till canceled. Order ${r.orderId}.`, level: plan.stopPrice, price })
          setFlag(p, row, null)
        } else if (plan.action === 'modify') {
          actionsToday += 1
          const r = await broker.modifyStop(row.order_id, { symbol: p.symbol, positionSide: p.side, qty: plan.qty, stopPrice: plan.stopPrice })
          const oldId = row.order_id
          if (!r.orderId) {
            // No Location header on the replace: find the new working STOP for this symbol at the new price.
            const again = await broker.getOrders().catch(() => [])
            const hit = again.find((o) => o.orderType === 'STOP' && OPEN.has(o.status) && String(o.orderId) !== String(oldId) && Number(o.stopPrice) === plan.stopPrice && (o.orderLegCollection || []).some((l) => l?.instrument?.symbol === p.symbol && l?.instruction === instructionFor(p.side)))
            if (hit) r.orderId = String(hit.orderId)
          }
          Object.assign(row, { order_id: r.orderId || row.order_id, status: 'working', stop_price: plan.stopPrice, qty: plan.qty, last_modified_day: today })
          if (!r.orderId) row.data.idUnknownAfterReplace = true
          delete row.data.allowModifyOnce
          summary.actions += 1
          ev('live_modified', p, { old_price: plan.fromStop, new_price: plan.stopPrice, qty: plan.qty, reason: clip(`LIVE replaced Schwab stop ${money(plan.fromStop)} → ${money(plan.stopPrice)}${plan.qty !== plan.fromQty ? `, qty ${plan.fromQty} → ${plan.qty}` : ''} (order ${oldId} → ${r.orderId || '?'})`), guard_note: plan.note, data: { live: true, orderId: r.orderId, oldOrderId: oldId } })
          alerts.push({ position_id: p.id, symbol: p.symbol, kind: 'live_modified', title: `${p.symbol}: Schwab stop moved to ${money(plan.stopPrice)}`, message: `Was ${money(plan.fromStop)}. ${plan.qty} sh, order ${r.orderId || oldId}.`, level: plan.stopPrice, price })
          setFlag(p, row, plan.flag)
        } else {
          setFlag(p, row, plan.flag)
        }
        if (row.status === 'gone') setFlag(p, row, { code: 'gone', message: row.data.goneReason })
      } catch (err) {
        summary.errors += 1
        ev('live_error', p, { reason: clip(`LIVE ${err?.message || err}`), data: { live: true, status: err?.status ?? null } })
        setFlag(p, row, { code: 'error', message: clip(`Schwab: ${err?.message || err}`, 200) })
      }
      upserts.push({ ...row, last_checked_at: iso })
    }
    if (actionsToday !== counter) {
      const data = { ...(conn.data || {}), actions: { day: today, n: actionsToday } }
      const up = await sb.from('broker_connections').update({ data, updated_at: new Date().toISOString() }).eq('user_id', uid).eq('broker', 'schwab')
      if (up.error) ev('live_error', null, { reason: clip(`LIVE action counter: ${up.error.message}`), data: { live: true } })
    }
    await persist(sb, { upserts, events, alerts, uid, iso, profileBy })
  }
  return summary
}

async function persist(sb, { upserts, events, alerts, uid, iso, profileBy }) {
  try {
    if (upserts.length) {
      const rows = upserts.map((r) => ({ ...Object.fromEntries(LIVE_ORDER_COLS.map((k) => [k, r[k] ?? null])), foreign_stops: r.foreign_stops || [], data: r.data || {}, adopted: Boolean(r.adopted), status: r.status || 'none', updated_at: iso }))
      const u = await sb.from('stock_live_orders').upsert(rows)
      if (u.error) console.error('stock_live_orders upsert', u.error.message)
    }
    if (events.length) {
      const e = await sb.from('stock_paper_events').insert(events)
      if (e.error) console.error('live events insert', e.error.message)
    }
    if (alerts.length) {
      const a = await sb.from('stock_alert_log').insert(alerts.map((x) => ({ user_id: uid, fired_at: iso, level: x.level ?? null, price: x.price ?? null, ...x })))
      if (a.error) console.error('live alerts insert', a.error.message)
      const chat = profileBy?.get(uid)?.telegram_chat_id
      const URG = new Set(['live_stop_crossed', 'live_gone', 'live_error', 'live_not_found', 'live_filled'])
      if (chat) await notifyLines(sb, { userId: uid, chatId: chat, title: 'Trade Smart · Schwab LIVE', lines: alerts.map((x) => ({ text: `${x.title}. ${x.message}`, urgent: URG.has(x.kind) })) }).catch(() => null)
    }
  } catch (err) {
    console.error('live persist', err?.message || err)
  }
}

/** Every cron tick: refresh-token expiry → reminders (48h, 12h) and expired → watch-only. */
export async function schwabHousekeeping(sb, { nowMs = Date.now() } = {}) {
  const { data, error } = await sb.from('broker_connections').select('user_id, status, refresh_expires_at, live_enabled, data').eq('broker', 'schwab').eq('status', 'connected')
  if (error) return { error: error.message }
  let reminders = 0
  let expired = 0
  for (const c of data || []) {
    const r = remindersDue({ refreshExpiresAt: c.refresh_expires_at, sent: c.data?.reminders || {}, nowMs })
    let alert = null
    const patch = {}
    if (r.expired) {
      expired += 1
      patch.status = 'expired'
      alert = { kind: 'schwab_expired', title: 'Schwab connection expired', message: `The bot is back to watch-only for your Schwab stops until you reconnect (My Bot → Stocks → Reconnect). Stop orders already at Schwab stay in place.` }
    } else if (r.due.length) {
      reminders += 1
      const h = r.due[0]
      patch.data = { ...(c.data || {}), reminders: { ...(c.data?.reminders || {}), ...Object.fromEntries(LIVE_RULES.reminderHours.filter((x) => x >= h).map((x) => [`h${x}`, true])) } }
      const left = r.leftMs / 3600_000
      alert = { kind: 'schwab_reconnect', title: `Reconnect Schwab within ${left >= 24 ? `${Math.floor(left / 24)} day${left >= 48 ? 's' : ''}` : `${Math.max(1, Math.floor(left))} h`}`, message: `Schwab's 7-day login ends ${new Date(c.refresh_expires_at).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', hour: 'numeric', minute: '2-digit' })} PT. Tap Reconnect on My Bot → Stocks so live stops keep updating.` }
    }
    if (!alert) continue
    await sb.from('broker_connections').update({ ...patch, updated_at: new Date().toISOString() }).eq('user_id', c.user_id).eq('broker', 'schwab')
    await sb.from('stock_alert_log').insert({ user_id: c.user_id, symbol: 'SCHWAB', fired_at: new Date(nowMs).toISOString(), ...alert })
    const { data: prof } = await sb.from('profiles').select('telegram_chat_id').eq('id', c.user_id).maybeSingle()
    if (prof?.telegram_chat_id) await notify(sb, { userId: c.user_id, chatId: prof.telegram_chat_id, text: `Trade Smart · ${alert.title}. ${alert.message}` }).catch(() => null)
  }
  return { reminders, expired }
}
