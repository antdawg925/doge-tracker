import { fetchYahooUpstream } from './_yahooUpstream.js'
/** Read-only research signals (paper only). No orders. */
const UNIVERSE = ['V','MA','AXP','PYPL','JPM','BAC','C','WFC','GS','MS','USB','PNC','PG','CL','KO','PEP','KMB','MDLZ','GIS','WMT','COST','XOM','CVX','COP','EOG','SLB','OXY','NVDA','AMD','INTC','QCOM','TXN','MU','AVGO','AAPL','MSFT','GOOGL','META','ORCL','CSCO','IBM','NEE','DUK','SO','D','AEP','EXC','JNJ','PFE','MRK','ABBV','BMY','LLY','UNH','CVS','HD','LOW','TGT','TJX','MCD','SBUX','NKE','CAT','DE','HON','GE','MMM','UPS','FDX','UNP','CSX','NSC','T','VZ','CMCSA']
const SECTORS = ['XLK','XLF','XLE','XLV','XLI','XLP','XLY','XLU','XLB']
let cache = { at: 0, data: null }

async function bars(sym) {
  const r = await fetchYahooUpstream(`v8/finance/chart/${sym}`, { range: '2y', interval: '1d' })
  if (r.status !== 200) return null
  const j = JSON.parse(r.body.toString())
  const res = j?.chart?.result?.[0]
  const q = res?.indicators?.quote?.[0]
  const adj = res?.indicators?.adjclose?.[0]?.adjclose
  if (!q) return null
  const out = []
  res.timestamp.forEach((t, i) => {
    const c = q.close[i]
    if (c == null || q.high[i] == null || q.low[i] == null) return
    out.push({ t, c, h: q.high[i], l: q.low[i], v: q.volume[i] || 0, a: adj?.[i] ?? c })
  })
  return out
}
function rsi2(cl) {
  let up = 0, dn = 0, init = false
  for (let i = 1; i < cl.length; i++) {
    const d = cl[i] - cl[i - 1], u = Math.max(d, 0), w = Math.max(-d, 0)
    if (!init) { up = u; dn = w; init = true } else { up = up / 2 + u / 2; dn = dn / 2 + w / 2 }
  }
  return dn === 0 ? 100 : 100 - 100 / (1 + up / dn)
}
async function pool(list, fn, n = 8) {
  const out = {}; let i = 0
  await Promise.all(Array.from({ length: n }, async () => { while (i < list.length) { const s = list[i++]; try { out[s] = await fn(s) } catch { out[s] = null } } }))
  return out
}
export async function computeEdges() {
  if (cache.data && Date.now() - cache.at < 15 * 60 * 1000) return cache.data
  const all = await pool(['SPY', 'QQQ', ...SECTORS, ...UNIVERSE], bars)
  const idx = {}
  for (const s of ['SPY', 'QQQ']) {
    const b = all[s]; if (!b || b.length < 210) { idx[s] = null; continue }
    const last = b[b.length - 1], cl = b.map((x) => x.a)
    const sma200 = cl.slice(-200).reduce((a, x) => a + x, 0) / 200
    const ibs = last.h > last.l ? (last.c - last.l) / (last.h - last.l) : 0.5
    const r = rsi2(cl), above = cl[cl.length - 1] > sma200
    idx[s] = { date: new Date(last.t * 1000).toISOString().slice(0, 10), close: last.c, ibs, rsi2: r, above200: above,
      ibsTrigger: ibs < 0.2, rsiTrigger: r < 10 && above }
  }
  const mom = []
  for (const s of UNIVERSE) {
    const b = all[s]; if (!b || b.length < 253) continue
    const n = b.length, a = b.map((x) => x.a)
    const last60 = b.slice(-60), dv = last60.reduce((x, y) => x + y.c * y.v, 0) / 60, sh = last60.reduce((x, y) => x + y.v, 0) / 60
    if (dv < 1e7 || sh < 1e6) continue
    mom.push({ symbol: s, m3: a[n - 1] / a[n - 64] - 1, m121: a[n - 22] / a[n - 253] - 1 })
  }
  const sec = SECTORS.map((s) => { const b = all[s]; if (!b || b.length < 200) return null; const a = b.map((x) => x.a), n = a.length
    return { symbol: s, m3: a[n - 1] / a[n - 64] - 1, above200: a[n - 1] > a.slice(-200).reduce((x, y) => x + y, 0) / 200 } }).filter(Boolean)
  const data = {
    asOf: new Date().toISOString(), index: idx,
    mom3: [...mom].sort((x, y) => y.m3 - x.m3).slice(0, 10),
    mom121: [...mom].sort((x, y) => y.m121 - x.m121).slice(0, 10),
    sectors: sec.sort((x, y) => y.m3 - x.m3).slice(0, 3),
    universeSize: mom.length,
  }
  cache = { at: Date.now(), data }
  return data
}
