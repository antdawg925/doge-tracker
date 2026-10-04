/**
 * DOGE plan actions shared by the panel routes (api/bot.js) and Telegram commands
 * (api/telegram.js): one code path, the same checks.
 */
import { fetchLiveMarket, runDogeLive } from './_dogeLive.js'
import { setStop } from '../shared/dogeLive.js'
import { sendTelegram } from './_telegram.js'
import { tradeKeyConfigured } from './_krakenTrade.js'

const fmt = (v) => (v == null ? '—' : `$${Number(v).toFixed(4)}`)

async function logRow(sb, row, userId, fields) {
  const live = row?.live_enabled && tradeKeyConfigured()
  await sb.from('doge_live_log').insert({ user_id: userId, plan_id: row?.state?.planId ?? null, at: new Date().toISOString(), mode: live ? 'live' : 'dry', role: 'plan', ...fields })
}

/** Run the plan now for this user (places / amends the real order when Live). */
export async function rerunPlan(sb, userId, source = 'manual') {
  const r = await runDogeLive(sb, { source, userIds: [userId] }).catch((e) => ({ error: e.message }))
  const { data } = await sb.from('doge_live_plans').select('snapshot, status, live_enabled, kill_switch, config, state').eq('user_id', userId).maybeSingle()
  return { run: r?.results?.[0] ?? r, plan: data }
}

/**
 * Raise (or, owner + confirm 'LOWER', lower) the bottom stop.
 * @returns { ok, status, error?, from, to, plan?, run? }
 */
export async function changeDogeStop(sb, { userId, isOwner, price, lower = false, confirm = null, source = 'manual', notify = true }) {
  const { data: row, error } = await sb.from('doge_live_plans').select('*').eq('user_id', userId).maybeSingle()
  if (error) return { ok: false, status: 500, error: 'Could not read your plan.' }
  if (!row) return { ok: false, status: 400, error: 'No DOGE plan yet.' }
  const n = Number(price)
  if (!(n > 0) || n > 10) return { ok: false, status: 400, error: 'Enter a stop price in USD per DOGE.' }
  const st = row.state || {}
  const cur = Number.isFinite(Number(st.stopPx)) ? Number(st.stopPx) : null
  const p = Math.round(n * 1e7) / 1e7
  if (row.status === 'stopped' || row.status === 'ended') return { ok: false, status: 400, error: 'The bottom stop already filled; start a new plan first.' }
  if (lower) {
    if (!isOwner) return { ok: false, status: 403, error: 'Only the owner can lower the stop.' }
    if (confirm !== 'LOWER') return { ok: false, status: 400, error: 'Type LOWER to confirm lowering the stop.' }
    if (cur != null && !(p < cur)) return { ok: false, status: 400, error: `That is not lower than the current stop ${fmt(cur)}.` }
  } else if (cur != null && !(p > cur)) {
    return { ok: false, status: 400, error: `The stop only moves up: ${fmt(p)} is not above the current stop ${fmt(cur)}. Lowering needs "Lower stop" with confirmation in the app.` }
  }
  const m = await fetchLiveMarket().catch(() => null)
  if (!m) return { ok: false, status: 502, error: 'Kraken price unavailable; try again.' }
  if (p >= m.bid) return { ok: false, status: 400, error: `A stop at ${fmt(p)} is at/above the market (bid ${fmt(m.bid)}); it would sell at once.` }
  const nowIso = new Date().toISOString()
  const state = structuredClone(st)
  const reason = lower ? 'Lowered by you (confirmed)' : source === 'telegram' ? 'Raised by you (Telegram)' : 'Raised by you'
  setStop(state, p, { by: 'user', reason, nowIso })
  const config = { ...(row.config || {}), bottomStop: p }
  const u = await sb.from('doge_live_plans').update({ state, config, updated_at: nowIso }).eq('user_id', userId)
  if (u.error) return { ok: false, status: 500, error: 'Could not save the stop.' }
  await logRow(sb, row, userId, { action: 'stop', status: lower ? 'stop_lowered' : 'stop_raised', price: p, reason: `${reason}: ${cur ?? '—'} → ${p}` })
  if (notify) {
    const { data: tp } = await sb.from('profiles').select('telegram_chat_id').eq('id', userId).maybeSingle()
    if (tp?.telegram_chat_id) await sendTelegram(tp.telegram_chat_id, `DOGE stop: ${lower ? '⚠️ Stop LOWERED' : 'Stop raised'} ${fmt(cur)} → ${fmt(p)}: ${reason.toLowerCase()}.`).catch(() => null)
  }
  return { ok: true, status: 200, from: cur, to: p, ...(await rerunPlan(sb, userId, source)) }
}

/** Kill switch on/off (cancels bot orders on the next run, which runs right away). */
export async function setDogeKill(sb, { userId, on, source = 'manual' }) {
  const { data: row } = await sb.from('doge_live_plans').select('*').eq('user_id', userId).maybeSingle()
  if (!row) return { ok: false, status: 400, error: 'No DOGE plan yet.' }
  const nowIso = new Date().toISOString()
  const r = await sb.from('doge_live_plans').update({ kill_switch: on, kill_switch_at: on ? nowIso : null, updated_at: nowIso }).eq('user_id', userId)
  if (r.error) return { ok: false, status: 500, error: 'Could not update.' }
  await logRow(sb, row, userId, { action: 'kill', status: on ? 'kill_on' : 'kill_off', reason: `${on ? 'Kill switch ON: cancel bot orders, place nothing' : 'Kill switch off'}${source === 'telegram' ? ' (Telegram)' : ''}` })
  return { ok: true, status: 200, ...(await rerunPlan(sb, userId, source)) }
}
