/**
 * DOGE signals logger (hourly, called from /api/bot/run). Read-only public sources, no alerts sent.
 * - Futures: OKX public (funding, OI, long/short, liquidations) + Kraken Futures PF_DOGEUSD.
 * - Hype: X API v2 recent tweet counts if X_BEARER_TOKEN is set; otherwise logs a "needs token" row.
 * - Whales: Blockchair free API, DOGE txs >= $1M.
 */
const UA = { 'User-Agent': 'Mozilla/5.0 TradeSmart' }
async function j(url, headers = {}) {
  const r = await fetch(url, { headers: { ...UA, ...headers }, signal: AbortSignal.timeout(10000) })
  if (!r.ok) throw new Error(`${r.status} ${url.split('?')[0]}`)
  return r.json()
}
const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v))

async function futures() {
  const out = { raw: {} }
  const tasks = [
    j('https://futures.kraken.com/derivatives/api/v3/tickers/PF_DOGEUSD').then((d) => {
      out.price = num(d.ticker?.markPrice); out.kraken_funding_rate = num(d.ticker?.fundingRate); out.kraken_oi_doge = num(d.ticker?.openInterest)
    }),
    j('https://www.okx.com/api/v5/public/funding-rate?instId=DOGE-USDT-SWAP').then((d) => {
      const f = num(d.data?.[0]?.fundingRate); out.okx_funding_pct = f == null ? null : f * 100
    }),
    j('https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=DOGE-USDT-SWAP').then((d) => { out.okx_oi_usd = num(d.data?.[0]?.oiUsd) }),
    j('https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=DOGE&period=1H').then((d) => { out.long_short_ratio = num(d.data?.[0]?.[1]) }),
    j('https://www.okx.com/api/v5/public/liquidation-orders?instType=SWAP&uly=DOGE-USDT&state=filled&limit=100').then((d) => {
      const cut = Date.now() - 4 * 3600e3; let lo = 0, sh = 0
      for (const x of d.data?.[0]?.details || []) {
        if (Number(x.ts) < cut) continue
        const usd = Number(x.sz) * 1000 * Number(x.bkPx) // DOGE-USDT-SWAP: 1 contract = 1000 DOGE
        if (x.posSide === 'long') lo += usd; else sh += usd
      }
      out.liq_long_usd_4h = Math.round(lo); out.liq_short_usd_4h = Math.round(sh)
    }),
  ]
  const res = await Promise.allSettled(tasks)
  out.raw.errors = res.filter((r) => r.status === 'rejected').map((r) => String(r.reason?.message || r.reason).slice(0, 120))
  return out
}

async function hype() {
  const token = process.env.X_BEARER_TOKEN
  if (!token) return { source: 'x', note: 'needs X_BEARER_TOKEN (X API Basic+ for tweet counts)' }
  const q = encodeURIComponent('(dogecoin OR $DOGE OR #doge) -is:retweet')
  const d = await j(`https://api.x.com/2/tweets/counts/recent?query=${q}&granularity=hour`, { Authorization: `Bearer ${token}` })
  const rows = d.data || []
  const last24 = rows.slice(-24).reduce((s, r) => s + (r.tweet_count || 0), 0)
  return { source: 'x', post_count_1h: rows.at(-2)?.tweet_count ?? null, post_count_24h: last24, note: 'counts only; sentiment not scored yet', raw: { total: d.meta?.total_tweet_count } }
}

async function whales() {
  const d = await j('https://api.blockchair.com/dogecoin/transactions?q=output_total_usd(1000000..)&s=time(desc)&limit=25')
  return (d.data || []).map((t) => ({
    tx_hash: t.hash, tx_time: new Date(t.time.replace(' ', 'T') + 'Z').toISOString(),
    amount_doge: Number(t.output_total) / 1e8, amount_usd: num(t.output_total_usd), output_count: t.output_count, source: 'blockchair',
  }))
}

export async function logDogeSignals(sb, { force = false } = {}) {
  const { data: last } = await sb.from('doge_futures_snapshots').select('taken_at').order('taken_at', { ascending: false }).limit(1)
  if (!force && last?.[0] && Date.now() - new Date(last[0].taken_at).getTime() < 55 * 60e3) return { skipped: 'hourly' }
  const out = {}
  try { const f = await futures(); await sb.from('doge_futures_snapshots').insert(f); out.futures = f.raw.errors.length ? f.raw.errors : 'ok' } catch (e) { out.futures = String(e.message || e) }
  try { const h = await hype(); await sb.from('doge_hype_snapshots').insert(h); out.hype = h.note || 'ok' } catch (e) { out.hype = String(e.message || e).slice(0, 120) }
  try { const w = await whales(); if (w.length) await sb.from('doge_whale_moves').upsert(w, { onConflict: 'tx_hash', ignoreDuplicates: true }); out.whales = w.length } catch (e) { out.whales = String(e.message || e).slice(0, 120) }
  return out
}
