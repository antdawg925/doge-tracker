/**
 * Telegram delivery with per-user quiet hours (notify_prefs; default 21:00–06:00
 * America/Los_Angeles, on). During quiet hours non-urgent messages are queued in
 * notify_queue and sent as ONE digest on the first cron run after quiet hours end (~6 AM).
 * Urgent messages always go now: stop filled/sold, stop missing / cancelled outside the bot /
 * re-placed, price below the stop, order errors, kill switch / pause, DOGE −8% in 1h, price
 * within 1% of a stop. Command replies never use this (they always go straight out).
 */
import { sendTelegram } from './_telegram.js'

export const DEFAULT_QUIET = Object.freeze({ quiet_enabled: true, quiet_start: 21, quiet_end: 6, tz: 'America/Los_Angeles' })

export function localHour(nowMs, tz = DEFAULT_QUIET.tz) {
  const h = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date(nowMs))
  return Number(h) % 24
}

/** Is `nowMs` inside the quiet window [start, end) (wraps midnight)? */
export function inQuiet(prefs, nowMs = Date.now()) {
  const p = { ...DEFAULT_QUIET, ...(prefs || {}) }
  if (!p.quiet_enabled) return false
  const s = Number(p.quiet_start)
  const e = Number(p.quiet_end)
  if (!Number.isFinite(s) || !Number.isFinite(e) || s === e) return false
  const h = localHour(nowMs, p.tz)
  return s < e ? h >= s && h < e : h >= s || h < e
}

const prefsCache = new Map()
export async function quietPrefs(sb, userId) {
  if (prefsCache.has(userId)) return prefsCache.get(userId)
  const { data } = await sb.from('notify_prefs').select('quiet_enabled, quiet_start, quiet_end, tz').eq('user_id', userId).maybeSingle()
  const p = { ...DEFAULT_QUIET, ...(data || {}) }
  prefsCache.set(userId, p)
  setTimeout(() => prefsCache.delete(userId), 30000).unref?.()
  return p
}

/**
 * Send (or hold) one message.
 * @param urgent true → always now
 * @returns { sent?, queued? }
 */
export async function notify(sb, { userId, chatId, text, urgent = false, nowMs = Date.now(), send = sendTelegram }) {
  if (!chatId || !text) return { skipped: true }
  if (!urgent && userId && inQuiet(await quietPrefs(sb, userId), nowMs)) {
    const r = await sb.from('notify_queue').insert({ user_id: userId, text: String(text).slice(0, 3500), created_at: new Date(nowMs).toISOString() })
    if (!r.error) return { queued: true }
  }
  await send(chatId, text)
  return { sent: true }
}

/** Several lines, each { text, urgent }: urgent ones go now (with the title), the rest follow the rules. */
export async function notifyLines(sb, { userId, chatId, title, lines, nowMs = Date.now(), send = sendTelegram }) {
  if (!chatId || !lines?.length) return { skipped: true }
  const urgent = lines.filter((l) => l.urgent).map((l) => l.text)
  const normal = lines.filter((l) => !l.urgent).map((l) => l.text)
  const quiet = userId ? inQuiet(await quietPrefs(sb, userId), nowMs) : false
  if (!quiet) {
    await send(chatId, [title, ...urgent, ...normal].filter(Boolean).join('\n'))
    return { sent: true }
  }
  if (urgent.length) await send(chatId, [title, ...urgent].filter(Boolean).join('\n'))
  if (normal.length) await notify(sb, { userId, chatId, text: [title, ...normal].filter(Boolean).join('\n'), nowMs, send })
  return { sent: urgent.length > 0, queued: normal.length > 0 }
}

/** Morning digest: everything held during quiet hours, one message per user. */
export async function flushDigests(sb, { nowMs = Date.now(), send = sendTelegram } = {}) {
  const { data: rows } = await sb.from('notify_queue').select('id, user_id, text, created_at').is('sent_at', null).order('created_at', { ascending: true }).limit(500)
  if (!rows?.length) return { users: 0 }
  const byUser = new Map()
  for (const r of rows) byUser.set(r.user_id, [...(byUser.get(r.user_id) || []), r])
  let users = 0
  for (const [userId, list] of byUser) {
    if (inQuiet(await quietPrefs(sb, userId), nowMs)) continue
    const { data: prof } = await sb.from('profiles').select('telegram_chat_id').eq('id', userId).maybeSingle()
    const ids = list.map((r) => r.id)
    if (prof?.telegram_chat_id) {
      const t = (iso) => new Date(iso).toLocaleTimeString('en-US', { timeZone: DEFAULT_QUIET.tz, hour: 'numeric', minute: '2-digit' })
      const body = list.map((r) => `• ${t(r.created_at)}: ${r.text.replace(/\n/g, ' · ')}`).join('\n')
      await send(prof.telegram_chat_id, `🌅 Overnight digest (${list.length} held during quiet hours)\n${body}`.slice(0, 3900))
      users += 1
    }
    await sb.from('notify_queue').update({ sent_at: new Date(nowMs).toISOString() }).in('id', ids)
  }
  return { users }
}
