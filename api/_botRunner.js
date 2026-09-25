/**
 * Server bot run (watch-only). One market fetch per symbol, then per eligible user:
 * staged stop (server owns stop_memory), alert crossings (alert_state/alert_log),
 * paper trading step, optional read-only Kraken snapshot (owner), one bot_runs row.
 * Never places orders.
 */
import { randomUUID } from 'node:crypto'
import { BOT_SYMBOLS, dogeFromKrakenBalance, evaluateUserRun } from '../shared/botEngine.js'
import { PAPER_DEFAULT_UNITS } from '../shared/paper.js'
import { fetchKrakenAccount, fetchMarket, krakenCredsFor } from './_kraken.js'
import { botMessage, sendTelegram } from './_telegram.js'

const SYMBOL = 'DOGE'

function must({ data, error }, what) {
  if (error) throw new Error(`${what}: ${error.message}`)
  return data
}

const clip = (s, n = 500) => (s == null ? null : String(s).slice(0, n))
const num = (x) => (Number.isFinite(x) ? x : null)

/**
 * @param sb  service-role Supabase client
 * @param {object} opts
 * @param {'cron'|'manual'|'paper_restart'} [opts.source]
 * @param {string[]} [opts.userIds]      limit to these users (paper restart)
 * @param {string}   [opts.resetPaperFor] user id whose paper book restarts this run
 */
export async function runBot(sb, { source = 'cron', userIds = null, resetPaperFor = null } = {}) {
  const started = Date.now()
  const runId = randomUUID()
  const cfg = BOT_SYMBOLS[SYMBOL]

  let q = sb.from('profiles').select('id, email, role, bot_access, telegram_chat_id').or('bot_access.eq.true,role.eq.owner')
  if (userIds?.length) q = q.in('id', userIds)
  const profiles = must(await q, 'profiles')
  const ids = profiles.map((p) => p.id)
  const plans = ids.length ? must(await sb.from('doge_plans').select('user_id, plan').in('user_id', ids), 'doge_plans') : []
  const planBy = new Map(plans.map((p) => [p.user_id, p.plan]))
  const users = profiles.filter((p) => planBy.has(p.id))

  let market = null
  let marketError = null
  if (users.length) {
    try {
      market = await fetchMarket(cfg)
    } catch (err) {
      marketError = String(err?.message || err)
    }
  }

  const krakenCache = new Map()
  const results = []
  for (const profile of users) {
    results.push(
      await runUser(sb, {
        runId,
        source,
        profile,
        planRaw: planBy.get(profile.id),
        market,
        marketError,
        krakenCache,
        resetPaper: resetPaperFor === profile.id,
      }),
    )
  }

  const errors = results.filter((r) => r.error).length
  const durationMs = Date.now() - started
  const summary = {
    runId,
    source,
    symbol: SYMBOL,
    ranAt: new Date(started).toISOString(),
    usersProcessed: results.length,
    usersWithoutPlan: profiles.length - users.length,
    errors,
    durationMs,
    price: market?.price ?? null,
    marketError,
    results: results.map(({ userId, decision, error }) => ({ userId, decision, error: error ? 'yes' : null })),
  }

  if (!userIds?.length) {
    const hb = await sb.from('bot_heartbeat').upsert({
      symbol: SYMBOL,
      last_run_at: summary.ranAt,
      last_source: source,
      run_id: runId,
      users_processed: results.length,
      errors,
      last_error: clip(marketError || results.find((r) => r.error)?.error || null, 300),
      duration_ms: durationMs,
      updated_at: new Date().toISOString(),
    })
    if (hb.error) summary.heartbeatError = hb.error.message
  }
  return summary
}

async function runUser(sb, { runId, source, profile, planRaw, market, marketError, krakenCache, resetPaper }) {
  const t0 = Date.now()
  const userId = profile.id
  const row = { run_id: runId, user_id: userId, symbol: SYMBOL, source, ran_at: new Date(t0).toISOString() }
  const warnings = []
  let result = null
  try {
    if (!market) throw new Error(`Market data unavailable: ${marketError || 'unknown'}`)

    if (resetPaper) {
      must(await sb.from('paper_trades').delete().eq('user_id', userId).eq('symbol', SYMBOL), 'paper_trades reset')
      must(await sb.from('paper_state').delete().eq('user_id', userId).eq('symbol', SYMBOL), 'paper_state reset')
    }

    const [stopRow, alertRow, paperRow, posRow] = await Promise.all([
      sb.from('stop_memory').select('version, data').eq('user_id', userId).maybeSingle(),
      sb.from('alert_state').select('data').eq('user_id', userId).maybeSingle(),
      sb.from('paper_state').select('*').eq('user_id', userId).eq('symbol', SYMBOL).maybeSingle(),
      sb.from('positions').select('shares').eq('user_id', userId).eq('symbol', SYMBOL).maybeSingle(),
    ]).then((rs) => rs.map((r, i) => must(r, ['stop_memory', 'alert_state', 'paper_state', 'positions'][i])))

    // Read-only Kraken snapshot (owner key today; per-user keys plug into krakenCredsFor).
    let kraken = null
    let dogeBal = null
    const creds = krakenCredsFor(profile)
    if (creds) {
      if (!krakenCache.has(creds.key)) krakenCache.set(creds.key, fetchKrakenAccount(creds))
      kraken = await krakenCache.get(creds.key)
      if (kraken.balances) dogeBal = dogeFromKrakenBalance(kraken.balances, BOT_SYMBOLS[SYMBOL].krakenAssets)
      if (kraken.errors.length) warnings.push(...kraken.errors)
    }

    const shares = Number(posRow?.shares)
    let notionalUnits = PAPER_DEFAULT_UNITS
    let unitsSource = 'default'
    if (Number.isFinite(shares) && shares > 0) {
      notionalUnits = shares
      unitsSource = 'positions'
    } else if (dogeBal?.total > 0) {
      notionalUnits = dogeBal.total
      unitsSource = 'kraken'
    }

    const nowMs = Date.now()
    result = evaluateUserRun({
      planRaw,
      stopRow,
      alertState: alertRow?.data ?? null,
      paper: paperRow,
      bars: market.bars,
      price: market.price,
      nowMs,
      notionalUnits,
      unitsSource,
      symbol: SYMBOL,
    })
    const nowIso = new Date(nowMs).toISOString()
    const s = result.snapshot

    // --- persist (server is the source of truth for stop memory + alert state)
    if (result.stopRowNext) {
      must(
        await sb.from('stop_memory').upsert({ user_id: userId, ...result.stopRowNext, updated_at: nowIso }),
        'stop_memory',
      )
    }
    if (result.alertsChanged || result.fired.length) {
      must(await sb.from('alert_state').upsert({ user_id: userId, data: result.alertStateNext, updated_at: nowIso }), 'alert_state')
    }
    if (result.fired.length) {
      must(
        await sb.from('alert_log').insert(
          result.fired.map((f) => ({
            user_id: userId,
            fired_at: nowIso,
            kind: f.ruleId,
            level: num(f.level),
            price: num(f.price),
            title: f.title,
            message: f.body,
          })),
        ),
        'alert_log',
      )
    }

    // Paper book: insert on first run; afterwards update only when a paper trade happens,
    // guarded on updated_at so two overlapping runs can't double-fill.
    let paperWritten = true
    const p = result.paperNext
    const paperCols = {
      started_at: p.started_at,
      start_price: p.start_price,
      core_units: p.core_units,
      slice_units: p.slice_units,
      cash: p.cash,
      last_action_at: p.last_action_at,
      data: p.data,
      updated_at: nowIso,
    }
    if (result.paperInit) {
      const ins = await sb.from('paper_state').insert({ user_id: userId, symbol: SYMBOL, ...paperCols }).select('user_id')
      if (ins.error) {
        paperWritten = false
        warnings.push(ins.error.code === '23505' ? 'paper book created by a concurrent run' : `paper_state: ${ins.error.message}`)
      }
    } else if (result.paperTrades.length) {
      const up = must(
        await sb
          .from('paper_state')
          .update(paperCols)
          .eq('user_id', userId)
          .eq('symbol', SYMBOL)
          .eq('updated_at', paperRow.updated_at)
          .select('user_id'),
        'paper_state',
      )
      if (!up.length) {
        paperWritten = false
        warnings.push('paper book changed by a concurrent run; skipped')
      }
    }
    if (paperWritten && result.paperTrades.length) {
      must(
        await sb.from('paper_trades').insert(
          result.paperTrades.map((t) => ({ user_id: userId, symbol: SYMBOL, at: nowIso, ...t })),
        ),
        'paper_trades',
      )
    }

    Object.assign(row, {
      price: num(s.price),
      atr: num(s.atr),
      atr_pct: num(s.atrPct),
      stage: s.stage,
      effective_stop: num(s.effectiveStop),
      trail_level: num(s.trail),
      floor: num(s.stageFloor),
      highest_high: num(s.highestHigh),
      decision: result.decision,
      reason: clip(result.reason),
      kraken_balance: kraken ? num(dogeBal?.total) : null,
      open_orders: kraken ? (Number.isInteger(kraken.openOrders) ? kraken.openOrders : null) : null,
      error: warnings.length ? clip(warnings.join('; '), 300) : null,
      details: {
        priceSource: market.priceSource,
        stopSource: s.stopSource,
        prevStop: result.prevStop,
        mult: s.mult,
        tightened: s.tightened,
        previewTrail: num(s.previewTrail),
        breakoutAt: s.breakoutAt,
        lastBarAt: s.lastBarAt,
        fired: result.fired.map((f) => f.ruleId),
        paper: {
          init: result.paperInit,
          events: result.paperEvents,
          value: num(result.paperValues?.paperValue),
          hold: num(result.paperValues?.holdValue),
          diffPct: num(result.paperValues?.diffPct),
          unitsSource: p.data?.units_source,
        },
        ...(kraken ? { kraken: { parts: dogeBal?.parts ?? null, dogeOpenOrders: kraken.dogeOpenOrders } } : {}),
      },
    })
  } catch (err) {
    Object.assign(row, { decision: 'error', reason: null, error: clip(err?.message || err, 300) })
  }
  row.duration_ms = Date.now() - t0
  const ins = await sb.from('bot_runs').insert(row)
  if (ins.error) row.error = clip(`${row.error ? `${row.error}; ` : ''}bot_runs: ${ins.error.message}`, 300)

  // Optional Telegram (skips silently unless token + chat id exist).
  if (result && profile.telegram_chat_id) {
    const text = botMessage({ symbol: SYMBOL, decision: result.decision, reason: result.reason, fired: result.fired, price: row.price })
    if (text) await sendTelegram(profile.telegram_chat_id, text)
  }

  return { userId, decision: row.decision, error: row.decision === 'error' ? row.error : null }
}
