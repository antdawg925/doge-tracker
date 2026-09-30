/**
 * Watch-only stock pass (runs inside the same 5-min pg_cron → /api/bot/run call as DOGE).
 *   intraday: US market hours, every 5 min — latest quote for "near stop" / "stop hit" /
 *             intraday squeeze, stops from completed daily candles (unchanged intraday)
 *   close:    once per trading day, first tick ≥ 15 min after the close — today's daily
 *             candle is complete, so stops move and "raise/lower your Schwab stop" fires
 *   manual:   one user's positions right after they add/edit one (any time)
 * One Yahoo chart fetch per unique symbol; short interest / earnings cached 6 h in
 * stock_symbol_info. Errors are recorded per position, never fatal.
 * Never places orders (see api/_schwab.js for the future live path).
 */
import { randomUUID } from 'node:crypto'
import { fetchYahooUpstream } from './_yahooUpstream.js'
import { sendTelegram } from './_telegram.js'
import { etDate, stockPassFor } from '../shared/marketHours.js'
import { barsFromYahooChart, evaluateStockPosition, infoFromQuoteSummary } from '../shared/stockEngine.js'

const HEARTBEAT = 'STOCKS'
const INFO_TTL_MS = 6 * 3600 * 1000
const clip = (s, n = 300) => (s == null ? null : String(s).slice(0, n))
const num = (x) => (Number.isFinite(x) ? x : null)

function must({ data, error }, what) {
  if (error) throw new Error(`${what}: ${error.message}`)
  return data
}

/** Yahoo daily chart range that covers the entry date plus ~3 months of warm-up. */
export function rangeFor(entryDates, nowMs = Date.now()) {
  const oldest = entryDates.reduce((m, d) => (d < m ? d : m), etDate(nowMs))
  const days = (nowMs - Date.parse(`${oldest}T00:00:00Z`)) / 86400000
  if (days > 600) return '5y'
  if (days > 250) return '2y'
  return '1y'
}

export async function fetchDailyMarket(symbol, range = '1y') {
  const r = await fetchYahooUpstream(`v8/finance/chart/${encodeURIComponent(symbol)}`, { interval: '1d', range })
  if (r.status !== 200) throw new Error(`Yahoo chart HTTP ${r.status}`)
  const m = barsFromYahooChart(JSON.parse(r.body.toString('utf8')))
  if (!Number.isFinite(m.price)) throw new Error('No price from Yahoo')
  return m
}

async function fetchInfo(symbol) {
  const r = await fetchYahooUpstream(`v10/finance/quoteSummary/${encodeURIComponent(symbol)}`, {
    modules: 'defaultKeyStatistics,calendarEvents',
  })
  if (r.status !== 200) throw new Error(`Yahoo quoteSummary HTTP ${r.status}`)
  const result = JSON.parse(r.body.toString('utf8'))?.quoteSummary?.result?.[0]
  if (!result) throw new Error('quoteSummary empty')
  return infoFromQuoteSummary(result)
}

/** Short interest + earnings, cached in stock_symbol_info (server-only table). */
export async function symbolInfo(sb, symbols, nowMs = Date.now()) {
  const out = new Map()
  if (!symbols.length) return out
  const { data } = await sb.from('stock_symbol_info').select('symbol, data, error, fetched_at').in('symbol', symbols)
  const cached = new Map((data || []).map((r) => [r.symbol, r]))
  await Promise.all(
    symbols.map(async (sym) => {
      const c = cached.get(sym)
      if (c && nowMs - Date.parse(c.fetched_at) < INFO_TTL_MS) {
        out.set(sym, c.error ? null : c.data)
        return
      }
      try {
        const info = await fetchInfo(sym)
        out.set(sym, info)
        await sb.from('stock_symbol_info').upsert({ symbol: sym, data: info, error: null, fetched_at: new Date(nowMs).toISOString() })
      } catch (err) {
        out.set(sym, c?.data && !c.error ? c.data : null) // keep the last good copy
        await sb.from('stock_symbol_info').upsert({
          symbol: sym,
          data: c?.data || {},
          error: clip(err?.message || err),
          fetched_at: new Date(nowMs).toISOString(),
        })
      }
    }),
  )
  return out
}

async function pool(items, n, fn) {
  const out = new Array(items.length)
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++
        out[k] = await fn(items[k])
      }
    }),
  )
  return out
}

/**
 * @param sb service-role client
 * @param {object} opts
 * @param {'cron'|'manual'} [opts.source]
 * @param {string[]} [opts.userIds]  limit to these users (manual refresh)
 * @param {boolean}  [opts.force]    run regardless of market hours (manual refresh)
 */
export async function runStocks(sb, { source = 'cron', userIds = null, force = false, nowMs = Date.now() } = {}) {
  const started = Date.now()
  let pass = 'manual'
  if (!force) {
    const { data: hb } = await sb.from('bot_heartbeat').select('last_run_at, last_source').eq('symbol', HEARTBEAT).maybeSingle()
    const lastClose = hb?.last_source === 'close' && hb.last_run_at ? etDate(Date.parse(hb.last_run_at)) : null
    pass = stockPassFor(nowMs, lastClose)
    if (!pass) return { skipped: true, reason: 'market closed', ranAt: new Date(nowMs).toISOString() }
  }
  const runId = randomUUID()

  let q = sb.from('profiles').select('id, role, bot_access, telegram_chat_id').or('bot_access.eq.true,role.eq.owner')
  if (userIds?.length) q = q.in('id', userIds)
  const profiles = must(await q, 'profiles')
  const profileBy = new Map(profiles.map((p) => [p.id, p]))
  const positions = profiles.length
    ? must(
        await sb.from('stock_positions').select('*').eq('status', 'active').in('user_id', profiles.map((p) => p.id)),
        'stock_positions',
      )
    : []

  const symbols = [...new Set(positions.map((p) => p.symbol))]
  const markets = new Map()
  const range = rangeFor(positions.map((p) => p.entry_date), nowMs)
  await pool(symbols, 4, async (sym) => {
    try {
      markets.set(sym, { ok: true, ...(await fetchDailyMarket(sym, range)) })
    } catch (err) {
      markets.set(sym, { ok: false, error: clip(err?.message || err) })
    }
  })
  const infos = await symbolInfo(sb, symbols.filter((s) => markets.get(s)?.ok && positions.some((p) => p.symbol === s)), nowMs).catch(() => new Map())

  const ids = positions.map((p) => p.id)
  const [stops, alerts] = ids.length
    ? await Promise.all([
        sb.from('stock_stops').select('*').in('position_id', ids),
        sb.from('stock_alert_state').select('position_id, data').in('position_id', ids),
      ]).then((rs) => rs.map((r, i) => must(r, ['stock_stops', 'stock_alert_state'][i])))
    : [[], []]
  const stopBy = new Map(stops.map((r) => [r.position_id, r]))
  const alertBy = new Map(alerts.map((r) => [r.position_id, r.data]))

  const results = []
  const firedByUser = new Map()
  for (const p of positions) {
    const t0 = Date.now()
    const iso = new Date(nowMs).toISOString()
    const row = { run_id: runId, user_id: p.user_id, position_id: p.id, symbol: p.symbol, side: p.side, ran_at: iso, source, pass }
    try {
      const m = markets.get(p.symbol)
      if (!m?.ok) throw new Error(`Market data unavailable: ${m?.error || 'unknown'}`)
      const r = evaluateStockPosition({
        position: p,
        market: m,
        info: infos.get(p.symbol) ?? null,
        stopRow: stopBy.get(p.id) ?? null,
        alertState: alertBy.get(p.id) ?? null,
        nowMs,
        pass,
      })
      must(
        await sb.from('stock_stops').upsert({
          position_id: p.id,
          user_id: p.user_id,
          symbol: p.symbol,
          side: p.side,
          ...r.stopRowNext,
          updated_at: iso,
        }),
        'stock_stops',
      )
      must(await sb.from('stock_alert_state').upsert({ position_id: p.id, user_id: p.user_id, data: r.alertStateNext, updated_at: iso }), 'stock_alert_state')
      if (r.fired.length) {
        must(
          await sb.from('stock_alert_log').insert(
            r.fired.map((f) => ({
              user_id: p.user_id,
              position_id: p.id,
              symbol: p.symbol,
              fired_at: iso,
              kind: f.kind,
              level: num(f.level),
              price: num(f.price),
              title: f.title,
              message: f.body,
            })),
          ),
          'stock_alert_log',
        )
        if (!firedByUser.has(p.user_id)) firedByUser.set(p.user_id, [])
        firedByUser.get(p.user_id).push(...r.fired)
      }
      const s = r.snapshot
      Object.assign(row, {
        price: num(s.price),
        atr: num(s.atr),
        stop: num(s.stop),
        prev_stop: num(r.prevStop),
        decision: r.decision,
        reason: clip(r.reason, 500),
        details: {
          fired: r.fired.map((f) => f.kind),
          mult: s.mult,
          initialStop: num(s.initialStop),
          trail: num(s.trail),
          lastBar: s.lastBar,
          flags: s.flags,
          size: s.size,
          infoMissing: !s.flags.infoAvailable,
        },
      })
    } catch (err) {
      Object.assign(row, { decision: 'error', error: clip(err?.message || err) })
    }
    row.duration_ms = Date.now() - t0
    const ins = await sb.from('stock_runs').insert(row)
    if (ins.error) row.error = clip(`${row.error ? `${row.error}; ` : ''}stock_runs: ${ins.error.message}`)
    results.push({ positionId: p.id, userId: p.user_id, symbol: p.symbol, decision: row.decision, error: row.error || null })
  }

  // Optional Telegram (no-op unless TELEGRAM_BOT_TOKEN + profiles.telegram_chat_id exist).
  for (const [uid, fired] of firedByUser) {
    const chat = profileBy.get(uid)?.telegram_chat_id
    if (chat) await sendTelegram(chat, ['Trade Smart · Stocks (watch-only)', ...fired.map((f) => `${f.title}. ${f.body}`)].join('\n'))
  }

  const errors = results.filter((r) => r.decision === 'error').length
  const summary = {
    runId,
    source,
    pass,
    ranAt: new Date(nowMs).toISOString(),
    positions: results.length,
    symbols: symbols.length,
    errors,
    durationMs: Date.now() - started,
    results: results.map(({ symbol, decision, error }) => ({ symbol, decision, error: error ? 'yes' : null })),
  }
  if (!userIds?.length && !force) {
    const hb = await sb.from('bot_heartbeat').upsert({
      symbol: HEARTBEAT,
      last_run_at: summary.ranAt,
      last_source: pass,
      run_id: runId,
      users_processed: new Set(positions.map((p) => p.user_id)).size,
      errors,
      last_error: clip(results.find((r) => r.error)?.error || null),
      duration_ms: summary.durationMs,
      updated_at: new Date().toISOString(),
    })
    if (hb.error) summary.heartbeatError = hb.error.message
  }
  return summary
}
