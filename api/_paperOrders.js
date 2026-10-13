/**
 * Server pass for paper limit orders (paper_ideas): pending → filled when price trades through the
 * limit; open + auto_exit → closed at target (win) or stop (loss). Yahoo intraday bars, regular
 * hours only. Paper only: never touches Schwab / Kraken. TSLA excluded.
 */
import { fetchYahooUpstream } from './_yahooUpstream.js'
import { PAPER_EXCLUDES, paperStep } from '../shared/paperOrders.js'

async function intradayBars(symbol, sinceMs, nowMs) {
  const days = (nowMs - sinceMs) / 86400000
  const [interval, range] = days <= 25 ? ['30m', '1mo'] : days <= 85 ? ['60m', '3mo'] : ['1d', '2y']
  const r = await fetchYahooUpstream(`v8/finance/chart/${encodeURIComponent(symbol)}`, { interval, range })
  if (r.status !== 200) throw new Error(`Yahoo chart HTTP ${r.status}`)
  const res = JSON.parse(r.body.toString('utf8'))?.chart?.result?.[0]
  const ts = res?.timestamp || []
  const q = res?.indicators?.quote?.[0] || {}
  const out = []
  for (let i = 0; i < ts.length; i += 1) {
    if (![q.high?.[i], q.low?.[i]].every(Number.isFinite)) continue
    out.push({ t: ts[i] * 1000, open: q.open?.[i], high: q.high[i], low: q.low[i], close: q.close?.[i] })
  }
  return out
}

export async function runPaperOrders(sb, { nowMs = Date.now(), barsFor = intradayBars } = {}) {
  const summary = { checked: 0, filled: 0, closed: 0, errors: 0 }
  const { data: ideas, error } = await sb.from('paper_ideas').select('*').eq('asset_type', 'stock').or('status.eq.pending,and(status.eq.open,auto_exit.eq.true)').limit(500)
  if (error) return { error: error.message }
  if (!ideas?.length) return summary
  const bySym = new Map()
  for (const i of ideas) {
    const s = String(i.symbol).toUpperCase()
    if (PAPER_EXCLUDES.has(s)) continue
    if (!bySym.has(s)) bySym.set(s, [])
    bySym.get(s).push(i)
  }
  for (const [sym, list] of bySym) {
    const since = Math.min(...list.map((i) => Date.parse(i.placed_at || i.created_at)))
    let bars
    try {
      bars = await barsFor(sym, since, nowMs)
    } catch {
      summary.errors += 1
      continue
    }
    for (const idea of list) {
      summary.checked += 1
      const step = paperStep(idea, bars, { nowMs })
      const now = new Date(nowMs).toISOString()
      const patch = {}
      if (step.fill) Object.assign(patch, { status: 'open', entry_price: step.fill.price, filled_at: new Date(step.fill.t).toISOString(), opened_at: new Date(step.fill.t).toISOString() })
      if (step.exit) Object.assign(patch, { status: 'closed', exit_price: step.exit.price, closed_at: new Date(step.exit.t).toISOString(), exit_reason: step.exit.reason, realized_pnl: Number(step.exit.pnl.toFixed(2)) })
      if (!Object.keys(patch).length) continue
      const { error: e } = await sb.from('paper_ideas').update({ ...patch, updated_at: now }).eq('id', idea.id).eq('status', idea.status)
      if (e) summary.errors += 1
      else {
        if (step.fill) summary.filled += 1
        if (step.exit) summary.closed += 1
      }
    }
  }
  return summary
}
