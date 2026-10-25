/**
 * Sunday weekly DOGE recap (daytime only: Sundays 10 AM–7:59 PM PT, outside 9 PM–6 AM quiet hours).
 * Sent once per Sunday per user from the 5-min cron (notify_cooldowns key doge:weekly:<date>).
 * Read-only: never touches orders or the plan.
 */
import { notify, localHour, DEFAULT_QUIET } from './_notify.js'
import { cooldownOk } from './_dogeLive.js'
import { ladderLine } from '../shared/levels.js'

const f4 = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : `$${Number(v).toFixed(4)}`)
const fu = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : `$${Math.round(Number(v)).toLocaleString('en-US')}`)
const fq = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : Math.round(Number(v)).toLocaleString('en-US'))

export function ptParts(nowMs, tz = DEFAULT_QUIET.tz) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(new Date(nowMs))
  const g = (t) => p.find((x) => x.type === t)?.value
  return { date: `${g('year')}-${g('month')}-${g('day')}`, weekday: g('weekday'), hour: localHour(nowMs, tz) }
}

export const recapWindow = (nowMs) => {
  const t = ptParts(nowMs)
  return t.weekday === 'Sun' && t.hour >= 10 && t.hour < 20
}

export function weeklyRecapText({ state, snapshot, config, nowMs }) {
  const s = snapshot || {}
  const weekAgo = nowMs - 7 * 86400000
  const hist = (state?.stopHist || []).filter((h) => Date.parse(h.at) > weekAgo)
  const stop = state?.stopPx ?? null
  const from = hist.length ? hist[0].from : stop
  const doge = s.book?.doge ?? null
  const umax = state?.umax || null
  const lines = [`📊 DOGE weekly recap (${s.mode === 'live' ? 'LIVE' : 'dry-run'})`]
  lines.push(`Stop ${f4(stop)}${hist.length ? ` (was ${f4(from)} a week ago; ${hist.length} move${hist.length > 1 ? 's' : ''})` : ' (no moves this week)'} · ${s.bottom?.distPct != null ? `${s.bottom.distPct.toFixed(1)}% under price` : ''}`)
  const ll = ladderLine(s.price)
  if (ll) lines.push(ll)
  if (doge != null) lines.push(`Holding ${fq(doge)} DOGE${umax ? ` (${Math.round((doge / umax) * 100)}% of max ${fq(umax)})` : ''} + ${fu(s.book?.usd)} cash`)
  if (s.account != null) lines.push(`Account ${fu(s.account)} vs start ${fu(config?.startValue)} · high ${fu(s.hwm)}${s.lockActive ? ` · locked ${fu(s.lock)}` : ''}`)
  if (s.stop?.qty != null && doge != null) lines.push(s.stop.qty + 1 >= doge ? '✅ Stop covers all DOGE' : `⚠️ Stop covers ${fq(s.stop.qty)} of ${fq(doge)} DOGE`)
  return lines.join('\n')
}

export async function weeklyRecap(sb, { userId, chatId, state, snapshot, config, nowMs = Date.now() }) {
  if (!chatId || !recapWindow(nowMs)) return { skipped: true }
  const { date } = ptParts(nowMs)
  if (!(await cooldownOk(sb, userId, `doge:weekly:${date}`, 6 * 86400000, nowMs))) return { skipped: 'sent' }
  return notify(sb, { userId, chatId, text: weeklyRecapText({ state, snapshot, config, nowMs }), nowMs })
}
