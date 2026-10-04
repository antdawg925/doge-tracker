/**
 * Inbound Telegram commands for @TradeSmartAlerts_bot (webhook).
 *   POST /api/telegram/webhook  — Telegram only. Verified by X-Telegram-Bot-Api-Secret-Token
 *   (env TELEGRAM_WEBHOOK_SECRET). Acts ONLY on chats that match a profiles.telegram_chat_id;
 *   everything else is ignored silently (still 200, so Telegram doesn't retry).
 * Commands: /status, /stop <price>, /pause (+ "/pause yes"), /resume (+ "/resume yes"), /help.
 * Dedupe by update_id (telegram_updates). Never logs the token or the secret.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { getAdminClient, readJsonBody, sendJson } from './_supabase.js'
import { sendTelegram } from './_telegram.js'
import { changeDogeStop, setDogeKill } from './_dogeActions.js'
import { fetchLiveMarket } from './_dogeLive.js'

const px = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : `$${Number(v).toFixed(4)}`)
const q0 = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : Math.round(Number(v)).toLocaleString('en-US'))
const usd = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : `$${Math.round(Number(v)).toLocaleString('en-US')}`)
const pt = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' PT' : '—')

export const HELP = [
  'Trade Smart commands:',
  '/status: DOGE price, bottom stop, distance, DOGE covered, mode, lock, your open buys, last raise',
  '/stop 0.092: raise the bottom stop (only up; must be below the market)',
  '/pause: kill switch: cancels the bot\'s orders INCLUDING the protective stop (asks to confirm)',
  '/resume: turn the bot back on (asks to confirm)',
  '/help: this list',
].join('\n')

function secretOk(given) {
  const want = process.env.TELEGRAM_WEBHOOK_SECRET
  if (!want || typeof given !== 'string' || !given) return false
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(want).digest()
  return timingSafeEqual(a, b)
}

/** Parse a message text → { cmd, arg }. Accepts "/stop .092", "stop 0.092", "/stop@Bot 0.092". */
export function parseCommand(text) {
  const t = String(text || '').trim().replace(/^\/(\w+)@\w+/, '/$1')
  const m = t.match(/^\/?(status|stop|pause|resume|help|start)\b\s*(.*)$/i)
  if (!m) return null
  return { cmd: m[1].toLowerCase(), arg: m[2].trim() }
}

export function parsePrice(arg) {
  const m = String(arg || '').replace(/^\$/, '').match(/^(\d*\.?\d+)$/)
  return m ? Number(m[1]) : null
}

/** Free text about setting / moving a stop (without a usable price)? */
export function isStopIntent(text) {
  const t = String(text || '').toLowerCase()
  if (/\bstop[\s-]*loss\b/.test(t)) return true
  return /\b(set|setting|move|moving|raise|raising|change|changing|place|placing|put|update|adjust|tighten)\b[\s\S]*\bstop/.test(t) || /^\/?stop\b/.test(t.trim())
}

/** % the stop sits below the price, as a share of the price. */
export const pctBelow = (price, stop) => (price > 0 && stop > 0 ? ((price - stop) / price) * 100 : null)

export function stopPromptText({ stop, price }) {
  const d = pctBelow(price, stop)
  return `Current stop: ${px(stop)} (price ${px(price)}${d != null ? `, ${d.toFixed(1)}% below` : ''}). Give me your stop price as: /stop 0.____`
}

export function statusText({ plan, price }) {
  if (!plan) return 'No DOGE plan yet. Open My Bot → DOGE to set your bottom stop.'
  const s = plan.snapshot || {}
  const st = plan.state || {}
  const stop = st.stopPx ?? s.bottom?.price ?? null
  const p = price ?? s.price
  const dist = stop && p ? pctBelow(p, stop).toFixed(1) : null
  const mode = s.mode === 'live' ? 'LIVE' : 'dry-run'
  const buys = (s.userBuys || []).map((o) => `${q0(o.qty)} @ ${px(o.price)} (${o.distPct >= 0 ? '+' : ''}${Number(o.distPct).toFixed(1)}%)`)
  const lines = [
    `DOGE ${px(p)} · ${mode}${plan.kill_switch ? ' · ⛔ PAUSED (kill switch: no stop order)' : ''}${plan.status === 'stopped' ? ' · stop FILLED (waiting)' : ''}`,
    `Bottom stop ${px(stop)}${dist != null ? ` (${dist}% below price)` : ''}`,
    `Covers ${s.stop ? `${q0(s.stop.qty)} DOGE` : '— (no stop order right now)'}`,
    `Lock ${s.lockActive ? usd(s.lock) : `inactive (activates at ${usd(s.lockActivatesAt)})`}`,
    `Open buys: ${buys.length ? buys.join(', ') : 'none'}`,
    `Last set: ${pt(st.stopSetAt)}${st.stopReason ? ` · ${st.stopReason}` : ''}`,
  ]
  return lines.join('\n')
}

/** Handle one update. Returns { handled, reply?, ignored? } (exported for tests). */
export async function handleUpdate(sb, update, { send = sendTelegram } = {}) {
  const msg = update?.message || update?.edited_message
  const chatId = msg?.chat?.id
  if (!msg || chatId == null || typeof msg.text !== 'string') return { ignored: 'no text message' }
  const { data: prof } = await sb.from('profiles').select('id, role, bot_access, telegram_chat_id').eq('telegram_chat_id', String(chatId)).maybeSingle()
  if (!prof || !(prof.bot_access || prof.role === 'owner')) return { ignored: 'unknown chat' }
  // dedupe (Telegram retries until 200)
  if (update.update_id != null) {
    const ins = await sb.from('telegram_updates').insert({ update_id: update.update_id, chat_id: String(chatId), user_id: prof.id, text: msg.text.slice(0, 200) })
    if (ins.error) return { ignored: 'duplicate' }
  }
  const reply = async (text) => {
    await send(chatId, text)
    return { handled: true, reply: text }
  }
  const c = parseCommand(msg.text)
  const userId = prof.id
  const isOwner = prof.role === 'owner'
  const promptStop = async () => {
    const [{ data: plan }, m] = await Promise.all([
      sb.from('doge_live_plans').select('snapshot, state').eq('user_id', userId).maybeSingle(),
      fetchLiveMarket().catch(() => null),
    ])
    return reply(stopPromptText({ stop: plan?.state?.stopPx ?? plan?.snapshot?.bottom?.price ?? null, price: m?.price ?? plan?.snapshot?.price ?? null }))
  }
  if (!c) return isStopIntent(msg.text) ? promptStop() : reply(HELP)

  if (c.cmd === 'help' || c.cmd === 'start') return reply(HELP)

  if (c.cmd === 'status') {
    const [{ data: plan }, m] = await Promise.all([
      sb.from('doge_live_plans').select('snapshot, state, status, kill_switch, live_enabled').eq('user_id', userId).maybeSingle(),
      fetchLiveMarket().catch(() => null),
    ])
    return reply(statusText({ plan, price: m?.price ?? null }))
  }

  if (c.cmd === 'stop') {
    const price = parsePrice(c.arg)
    if (price == null) return promptStop()
    const r = await changeDogeStop(sb, { userId, isOwner, price, source: 'telegram', notify: false })
    if (!r.ok) return reply(`Not changed: ${r.error}`)
    const s = r.plan?.snapshot || {}
    const live = s.mode === 'live'
    const placed = r.plan?.state?.orders?.stop
    const busy = r.run?.skipped === 'busy'
    return reply(
      `✅ Stop raised ${px(r.from)} → ${px(r.to)}${live ? '' : ' (dry-run)'}.` +
        (live ? (busy ? ' Kraken order updates on the next run (≤5 min).' : placed?.id && Math.abs(placed.price - r.to) < 1e-9 ? ` Kraken stop-loss now ${px(placed.price)} for ${q0(placed.qty)} DOGE.` : ' Check the panel: the Kraken order did not confirm yet.') : ` Covers ${q0(s.stop?.qty)} DOGE.`),
    )
  }

  if (c.cmd === 'pause') {
    if (c.arg.toLowerCase() !== 'yes') return reply('⚠️ Pausing turns on the kill switch: the bot CANCELS its orders, including your protective stop-loss, and places nothing until /resume. Your DOGE is then unprotected.\nReply "/pause yes" to confirm.')
    const r = await setDogeKill(sb, { userId, on: true, source: 'telegram' })
    return reply(r.ok ? '⛔ Paused (kill switch ON). Bot orders cancelled; NO protective stop is in place. /resume to turn it back on.' : `Not paused: ${r.error}`)
  }

  if (c.cmd === 'resume') {
    if (c.arg.toLowerCase() !== 'yes') return reply('Resume the bot? It re-places the bottom stop under your DOGE (and resumes raises). Reply "/resume yes" to confirm.')
    const r = await setDogeKill(sb, { userId, on: false, source: 'telegram' })
    const s = r.plan?.snapshot || {}
    return reply(r.ok ? `▶️ Resumed. Bottom stop ${px(r.plan?.state?.stopPx)}${s.stop ? ` for ${q0(s.stop.qty)} DOGE` : ''}${s.mode === 'live' ? '' : ' (dry-run)'}.` : `Not resumed: ${r.error}`)
  }
  return reply(HELP)
}

export default async function handler(req, res) {
  const route = String(req.query?.route || '')
  if (route !== 'webhook') return sendJson(res, 404, { error: 'Not found.' })
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed.' })
  if (!secretOk(req.headers?.['x-telegram-bot-api-secret-token'])) return sendJson(res, 401, { error: 'Unauthorized.' })
  const sb = getAdminClient()
  if (!sb) return sendJson(res, 200, { ok: true })
  let update
  try {
    update = await readJsonBody(req)
  } catch {
    return sendJson(res, 200, { ok: true })
  }
  try {
    const r = await handleUpdate(sb, update)
    return sendJson(res, 200, { ok: true, handled: Boolean(r.handled) })
  } catch (err) {
    console.error('telegram webhook', String(err?.message || err).slice(0, 200))
    return sendJson(res, 200, { ok: true }) // never make Telegram retry a failing command forever
  }
}
