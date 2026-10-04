/**
 * Telegram "buy $X DOGE" (owner chat only) + /cancel + "yes" confirmations, and the cron-side
 * buy manager (re-peg up to 3×, fills → stop resize → stop suggestion).
 *  - Plan: Kraken L2 (Depth) → post-only limit at bid (+1 tick if still under the ask), sized $X ÷
 *    price (8 dp, ≥ 50 DOGE), USD balance checked; "yes" within 2 min places it.
 *  - DRY-RUN (plan not Live): shows what would happen, places nothing. Kill switch: never buys.
 *  - Fills: the bottom stop resizes at once (plan re-run; price never lowers), Telegram confirms
 *    the fill + coverage, then suggests a stop (4h swing low / hourly ATR / bid walls); "yes"
 *    within 30 min raises it via the same path as /stop.
 */
import { BUY_RULES, analyzeDepth, buyPlanText, planBuy, repegDecision, suggestStop, suggestText } from '../shared/dogeBuy.js'
import { KRAKEN_XDGUSD, fmtPx, fmtQty } from '../shared/dogeLive.js'
import { normalizeKrakenOhlc, pickKrakenPairRows } from '../shared/kraken.js'
import { bookFromBalance, createKrakenTrader, krakenTradeCredsFor, newClOrdId } from './_krakenTrade.js'
import { fetchLiveMarket } from './_dogeLive.js'
import { changeDogeStop, rerunPlan } from './_dogeActions.js'
import { notify } from './_notify.js'

const BASE = 'https://api.kraken.com/0/public'
async function pub(fetchImpl, path) {
  const r = await fetchImpl(`${BASE}/${path}`, { signal: AbortSignal.timeout(10000) })
  const j = await r.json()
  if (j.error?.length) throw new Error(`Kraken: ${j.error.join(', ')}`)
  return j.result
}
export async function fetchBook(fetchImpl = fetch) {
  const r = await pub(fetchImpl, 'Depth?pair=XDGUSD&count=200')
  return analyzeDepth(Object.values(r || {})[0])
}
async function fetch1h(fetchImpl = fetch) {
  return normalizeKrakenOhlc(pickKrakenPairRows(await pub(fetchImpl, 'OHLC?pair=XDGUSD&interval=60'))).filter((b) => b.t + 3600000 <= Date.now())
}

async function context(sb, userId, profile, env) {
  const { data: plan } = await sb.from('doge_live_plans').select('*').eq('user_id', userId).maybeSingle()
  const creds = krakenTradeCredsFor(profile, env)
  const live = Boolean(plan?.live_enabled && creds)
  return { plan, creds, live, killed: Boolean(plan?.kill_switch) }
}

async function usdAvailable(creds, fetchImpl) {
  if (!creds) return null
  const t = createKrakenTrader({ creds, fetchImpl })
  const b = bookFromBalance(await t.balanceEx())
  return Math.max(0, b.usd - b.usdHold)
}

async function setPending(sb, userId, kind, payload, ttlMs) {
  await sb.from('telegram_pending').upsert({ user_id: userId, kind, payload, expires_at: new Date(Date.now() + ttlMs).toISOString(), created_at: new Date().toISOString() })
}

/** "buy $X" → plan + yes prompt. Returns the reply text. */
export async function startBuy(sb, { profile, usd, env = process.env, fetchImpl = fetch }) {
  if (profile.role !== 'owner') return 'Buying from Telegram is only available on the owner account.'
  if (!(usd > 0)) return 'Usage: buy $1000 DOGE (or /buy 1000)'
  if (usd > 100000) return 'That is over the $100,000 per-command limit.'
  const ctx = await context(sb, profile.id, profile, env)
  if (ctx.killed) return '⛔ Kill switch is on: no buys. /resume first.'
  const [book, avail] = await Promise.all([fetchBook(fetchImpl).catch(() => null), usdAvailable(ctx.creds, fetchImpl).catch(() => null)])
  if (!book) return 'Kraken order book unavailable; try again.'
  const plan = planBuy({ usd, book, usdAvailable: avail })
  if (!plan.ok) return `Can't buy: ${plan.error}.`
  await setPending(sb, profile.id, 'buy', { usd, price: plan.price, qty: plan.qty, dry: !ctx.live }, BUY_RULES.confirmMs)
  return buyPlanText(plan, book, { usd, dry: !ctx.live }) + (avail != null ? `\nUSD available: $${avail.toFixed(2)}` : '')
}

/** "yes" → whatever is pending (buy or stop suggestion). */
export async function confirmPending(sb, { profile, env = process.env, fetchImpl = fetch }) {
  const { data: p } = await sb.from('telegram_pending').select('*').eq('user_id', profile.id).maybeSingle()
  if (!p) return 'Nothing is waiting for a yes.'
  await sb.from('telegram_pending').delete().eq('user_id', profile.id)
  if (Date.parse(p.expires_at) < Date.now()) return p.kind === 'buy' ? 'That buy plan expired (2 min). Send buy $X again for a fresh price.' : 'That stop suggestion expired (30 min). Use /stop 0.0xx.'
  if (p.kind === 'stop_suggest') {
    const r = await changeDogeStop(sb, { userId: profile.id, isOwner: profile.role === 'owner', price: p.payload.price, source: 'telegram', notify: false })
    if (!r.ok) return `Not changed: ${r.error}`
    return `✅ Stop raised ${fmtPx(r.from)} → ${fmtPx(r.to)}${r.plan?.snapshot?.mode === 'live' ? '' : ' (dry-run)'}. Covers ${fmtQty(r.plan?.snapshot?.stop?.qty)} DOGE.`
  }
  // buy
  const ctx = await context(sb, profile.id, profile, env)
  if (profile.role !== 'owner') return 'Owner only.'
  if (ctx.killed) return '⛔ Kill switch is on: no buys.'
  const usd = Number(p.payload.usd)
  const [book, avail] = await Promise.all([fetchBook(fetchImpl).catch(() => null), usdAvailable(ctx.creds, fetchImpl).catch(() => null)])
  if (!book) return 'Kraken order book unavailable; nothing placed.'
  const plan = planBuy({ usd, book, usdAvailable: ctx.live ? avail : null })
  if (!plan.ok) return `Nothing placed: ${plan.error}.`
  const nowIso = new Date().toISOString()
  const stopPx = ctx.plan?.state?.stopPx
  if (!ctx.live) {
    await sb.from('doge_live_log').insert({ user_id: profile.id, plan_id: ctx.plan?.state?.planId ?? null, at: nowIso, mode: 'dry', role: 'buy', action: 'place', status: 'would_place', side: 'buy', ordertype: 'limit', price: plan.price, qty: plan.qty, reason: `Telegram buy $${usd} (post-only)` })
    const held = Number(ctx.plan?.snapshot?.book?.doge || 0)
    return [
      `Dry-run, nothing placed. Would place: post-only limit buy ${fmtQty(plan.qty)} DOGE @ $${plan.price.toFixed(7)} (~$${plan.cost.toFixed(2)} incl. fee).`,
      `Would re-peg to the best bid after 3 min if unfilled (up to 3×), then leave it resting.`,
      `On fill the bottom stop ${fmtPx(stopPx)} would cover ~${fmtQty(held + plan.qty)} DOGE (price never lowers), then I'd suggest a stop.`,
      avail != null ? `USD available at Kraken: $${avail.toFixed(2)}${avail < plan.cost ? ' (not enough for this live)' : ''}.` : '',
    ].filter(Boolean).join('\n')
  }
  const trader = createKrakenTrader({ creds: ctx.creds, fetchImpl, rules: KRAKEN_XDGUSD })
  const clOrdId = newClOrdId('buy')
  let txid = null
  try {
    const r = await trader.addBuyPost({ qty: plan.qty, price: plan.price, clOrdId })
    txid = r?.txid?.[0] ?? null
  } catch (e) {
    await sb.from('doge_live_log').insert({ user_id: profile.id, at: nowIso, mode: 'live', role: 'buy', action: 'place', status: 'error', side: 'buy', ordertype: 'limit', price: plan.price, qty: plan.qty, reason: String(e.message).slice(0, 300) })
    return `❗ Buy not placed: ${e.message}`
  }
  await sb.from('doge_buy_orders').insert({ user_id: profile.id, status: 'open', usd, qty: plan.qty, price: plan.price, txid, cl_ord_id: clOrdId, placed_at: nowIso })
  await sb.from('doge_live_log').insert({ user_id: profile.id, at: nowIso, mode: 'live', role: 'buy', action: 'place', status: 'placed', side: 'buy', ordertype: 'limit', price: plan.price, qty: plan.qty, txid, cl_ord_id: clOrdId, reason: `Telegram buy $${usd} (post-only)` })
  return `✅ Placed post-only buy ${fmtQty(plan.qty)} DOGE @ $${plan.price.toFixed(7)} (${txid}). I'll re-peg after 3 min if it hasn't filled (up to 3×). /cancel to cancel.`
}

/** /cancel: drop a pending buy plan and cancel the bot's open buy orders. */
export async function cancelBuys(sb, { profile, env = process.env, fetchImpl = fetch }) {
  const out = []
  const { data: p } = await sb.from('telegram_pending').select('kind').eq('user_id', profile.id).maybeSingle()
  if (p?.kind === 'buy') {
    await sb.from('telegram_pending').delete().eq('user_id', profile.id)
    out.push('Pending buy plan dropped.')
  }
  const { data: rows } = await sb.from('doge_buy_orders').select('*').eq('user_id', profile.id).in('status', ['open', 'resting'])
  const creds = krakenTradeCredsFor(profile, env)
  for (const r of rows || []) {
    try {
      if (creds && r.txid) await createKrakenTrader({ creds, fetchImpl }).cancel({ txid: r.txid })
      await sb.from('doge_buy_orders').update({ status: 'cancelled', closed_at: new Date().toISOString() }).eq('id', r.id)
      out.push(`Cancelled buy ${fmtQty(r.qty)} @ $${Number(r.price).toFixed(7)}${Number(r.filled_qty) > 0 ? ` (${fmtQty(r.filled_qty)} already filled)` : ''}.`)
    } catch (e) {
      if (/Unknown order/i.test(e.message)) await sb.from('doge_buy_orders').update({ status: 'cancelled', closed_at: new Date().toISOString() }).eq('id', r.id)
      out.push(`Could not cancel ${r.txid}: ${e.message}`)
    }
  }
  return out.length ? out.join('\n') : 'No pending or open bot buy to cancel.'
}

/** Cron: re-peg / detect fills of the bot's Telegram buys. */
export async function manageBuys(sb, { nowMs = Date.now(), env = process.env, fetchImpl = fetch } = {}) {
  const { data: rows } = await sb.from('doge_buy_orders').select('*').in('status', ['open', 'resting'])
  if (!rows?.length) return { orders: 0 }
  const users = [...new Set(rows.map((r) => r.user_id))]
  const { data: profiles } = await sb.from('profiles').select('id, role, telegram_chat_id').in('id', users)
  let book = null
  const summary = { orders: rows.length, fills: 0, repegs: 0 }
  for (const prof of profiles || []) {
    const creds = krakenTradeCredsFor(prof, env)
    if (!creds) continue
    const trader = createKrakenTrader({ creds, fetchImpl })
    const mine = rows.filter((r) => r.user_id === prof.id)
    const q = await trader.queryOrders(mine.map((r) => r.txid).filter(Boolean)).catch(() => null)
    const fills = []
    for (const r of mine) {
      const o = q?.[r.txid]
      if (!o) continue
      const exec = Number(o.vol_exec || 0)
      const avg = Number(o.price) || Number(r.price)
      const patch = {}
      if (exec > Number(r.filled_qty) + 1e-9) {
        fills.push({ r, qty: exec - Number(r.filled_qty), avg, total: exec })
        Object.assign(patch, { filled_qty: exec, avg_price: avg })
      }
      if (o.status === 'closed') Object.assign(patch, { status: 'filled', closed_at: new Date(nowMs).toISOString() })
      else if (o.status === 'canceled' || o.status === 'expired') {
        Object.assign(patch, { status: 'cancelled', closed_at: new Date(nowMs).toISOString() })
        await notify(sb, { userId: prof.id, chatId: prof.telegram_chat_id, urgent: true, text: `Your bot buy ${fmtQty(r.qty)} @ $${Number(r.price).toFixed(7)} was ${o.status} at Kraken${o.reason ? ` (${o.reason})` : ''}${exec > 0 ? `; ${fmtQty(exec)} filled` : ''}.` })
      } else if (r.status === 'open') {
        book = book || (await fetchBook(fetchImpl).catch(() => null))
        const d = repegDecision({ req: r, book, nowMs })
        if (d.action === 'repeg') {
          try {
            await trader.amend({ txid: r.txid, limitPrice: d.price, postOnly: true })
            Object.assign(patch, { price: d.price, repegs: r.repegs + 1, last_peg_at: new Date(nowMs).toISOString() })
            summary.repegs += 1
          } catch (e) {
            Object.assign(patch, { data: { ...(r.data || {}), lastError: String(e.message).slice(0, 200) } })
          }
        } else if (d.action === 'rest') {
          Object.assign(patch, { status: 'resting' })
          await notify(sb, { userId: prof.id, chatId: prof.telegram_chat_id, text: `Buy left resting at $${Number(r.price).toFixed(7)} after ${BUY_RULES.maxRepegs} re-pegs (filled ${fmtQty(exec)} of ${fmtQty(r.qty)}). /cancel to cancel.` })
        }
      }
      if (Object.keys(patch).length) await sb.from('doge_buy_orders').update(patch).eq('id', r.id)
    }
    if (!fills.length) continue
    summary.fills += fills.length
    // the bottom stop resizes NOW (price never lowers), then confirm + suggest
    const after = await rerunPlan(sb, prof.id, 'buy_fill')
    const snap = after.plan?.snapshot || {}
    const stopPx = after.plan?.state?.stopPx
    for (const f of fills) {
      await sb.from('doge_live_log').insert({ user_id: prof.id, at: new Date(nowMs).toISOString(), mode: 'live', role: 'buy', action: 'fill', status: 'filled', side: 'buy', ordertype: 'limit', price: f.avg, qty: f.qty, txid: f.r.txid, reason: 'Telegram buy filled' })
      let text = `✅ Your buy filled ${fmtQty(f.qty)} DOGE @ ${fmtPx(f.avg)}. Stop now covers ${fmtQty(snap.stop?.qty)} DOGE at ${fmtPx(stopPx)}.`
      try {
        const [m, bars1h, bk] = await Promise.all([fetchLiveMarket(fetchImpl), fetch1h(fetchImpl), fetchBook(fetchImpl)])
        const s = suggestStop({ fill: f.avg, qty: f.total, bars4h: m.bars4h, bars1h, book: bk, currentStop: stopPx })
        if (s) {
          text += `\n${suggestText(s, { fill: f.avg, currentStop: stopPx })}`
          if (!s.keep) await setPending(sb, prof.id, 'stop_suggest', { price: s.price }, BUY_RULES.suggestTtlMs)
        }
      } catch {
        /* suggestion is best-effort */
      }
      await notify(sb, { userId: prof.id, chatId: prof.telegram_chat_id, text, urgent: true })
    }
  }
  return summary
}
