/**
 * Stock Bot PAPER LAB API (paper money only; never touches brokers, DOGE, orders or Telegram).
 *   POST /api/bot/paper-lab/ingest  header x-paper-lab-secret: <PAPER_LAB_INGEST_SECRET>
 *        body { mode, status?, trades?[], signals?[], daily?[] } -> idempotent upserts by id.
 *   GET  /api/bot/paper-lab/view?mode=prospective|retrospective_replay  (bot tier or owner)
 */
import { timingSafeEqual, createHash } from 'node:crypto'
import { getAdminClient, readJsonBody, requireUser, sendJson } from './_supabase.js'

const MODES = new Set(['prospective', 'retrospective_replay'])
const TABLES = { trades: 'paper_lab_trades', signals: 'paper_lab_signals', daily: 'paper_lab_daily' }

function secretOk(given) {
  const expected = process.env.PAPER_LAB_INGEST_SECRET
  if (!expected || !given) return false
  const a = createHash('sha256').update(String(given)).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

const missingTable = (e) => /relation .* does not exist|Could not find the table|schema cache/i.test(String(e?.message || e))

async function upsert(sb, table, rows) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await sb.from(table).upsert(rows.slice(i, i + 500), { onConflict: 'id' })
    if (error) throw error
  }
}

export async function handlePaperLab(route, req, res) {
  const sb = getAdminClient()
  if (!sb) return sendJson(res, 500, { error: 'Not configured on the server.' })
  try {
    if (route === 'paper-lab/ingest') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only.' })
      if (!secretOk(req.headers?.['x-paper-lab-secret'])) return sendJson(res, 401, { error: 'Bad secret.' })
      const body = await readJsonBody(req)
      const mode = MODES.has(body?.mode) ? body.mode : 'prospective'
      const counts = {}
      for (const [k, table] of Object.entries(TABLES)) {
        const rows = Array.isArray(body?.[k]) ? body[k].filter((r) => r && typeof r.id === 'string').map((r) => ({ ...r, mode })) : []
        if (rows.length) await upsert(sb, table, rows)
        counts[k] = rows.length
      }
      if (body?.status && typeof body.status === 'object') {
        const s = body.status
        const { error } = await sb.from('paper_lab_status').upsert({
          mode, ticked_at: s.ticked_at, regime: s.regime ?? null, accounts: s.accounts ?? null, counts: s.counts ?? null,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'mode' })
        if (error) throw error
      }
      return sendJson(res, 200, { ok: true, mode, counts })
    }
    if (route === 'paper-lab/view') {
      const who = await requireUser(req, res, { bot: true })
      if (!who) return
      const url = new URL(req.url || '/', 'http://localhost')
      const mode = MODES.has(url.searchParams.get('mode')) ? url.searchParams.get('mode') : 'prospective'
      const [st, tr, dl] = await Promise.all([
        sb.from('paper_lab_status').select('*').eq('mode', mode).maybeSingle(),
        sb.from('paper_lab_trades').select('id,strategy_id,version,symbol,side,horizon,status,entry_at,exit_at,entry,exit,stop,target,shares,pnl,r,exit_reason,reason,regime,vix')
          .eq('mode', mode).order('entry_at', { ascending: false }).limit(5000),
        sb.from('paper_lab_daily').select('day,strategy_id,equity,realized,pnl_total,open_count').eq('mode', mode).order('day', { ascending: false }).limit(400),
      ])
      for (const r of [st, tr, dl]) if (r.error) throw r.error
      return sendJson(res, 200, { mode, status: st.data, trades: tr.data || [], daily: dl.data || [] })
    }
    return sendJson(res, 404, { error: 'Unknown paper-lab route.' })
  } catch (err) {
    if (missingTable(err)) return sendJson(res, 503, { error: 'Paper Lab tables are not created yet (migration 20261117120000_paper_lab.sql).' })
    return sendJson(res, 500, { error: String(err?.message || err).slice(0, 300) })
  }
}
