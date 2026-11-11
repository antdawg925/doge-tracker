/**
 * PUBLIC, read-only paper day-trade competition routes (paper money only).
 *
 *   GET /api/paper/feed     -> sanitized competition feed (public/paper/feed.json)
 *   GET /api/paper/summary  -> small scoreboard summary derived from the same feed
 *   GET /api/paper/health   -> { ok, generated_at_pt, synced_at }
 *
 * Isolation (intentional): this file imports ONLY node:fs / node:path and fetches only the public feed URL below. It must never import
 * Schwab, Kraken, order, stop, Telegram, bot, Supabase or auth helpers, and it reads no env vars.
 * The feed is produced offline by scripts/paper-sync.mjs (allow-listed fields + deny-pattern check)
 * and committed to public/paper/feed.json.
 *
 * Freshness: the committed feed on GitHub main (public repo) is read first, so publishing a new
 * feed is just commit + push (no redeploy). Falls back to the copy bundled in this deployment.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const FEED_PATH = join(process.cwd(), 'public', 'paper', 'feed.json')
const FEED_URL = 'https://raw.githubusercontent.com/antdawg925/doge-tracker/main/public/paper/feed.json'
const TTL_MS = 60_000
let cache = { at: 0, feed: null, source: null }

const isFeed = (f) => f && typeof f === 'object' && f.feed_version === 'paper-feed-v1' && f.accounts && Array.isArray(f.decisions)

async function loadFeed() {
  if (cache.feed && Date.now() - cache.at < TTL_MS) return cache
  try {
    const r = await fetch(FEED_URL, { signal: AbortSignal.timeout(4000), headers: { Accept: 'application/json' } })
    if (r.ok) {
      const feed = await r.json()
      if (isFeed(feed)) {
        cache = { at: Date.now(), feed, source: 'github-main' }
        return cache
      }
    }
  } catch {
    /* fall back to the bundled copy */
  }
  const feed = JSON.parse(readFileSync(FEED_PATH, 'utf8'))
  if (!isFeed(feed)) throw new Error('bad bundled feed')
  cache = { at: Date.now(), feed, source: 'bundled' }
  return cache
}

function routeOf(req) {
  let r = req.query?.route
  if (Array.isArray(r)) r = r.join('/')
  if (!r && req.url) {
    const segs = new URL(req.url, 'http://localhost').pathname.split('/').filter(Boolean)
    r = segs.slice(2).join('/') // /api/paper/<route>
  }
  return String(r || 'feed').replace(/^\/+|\/+$/g, '')
}

function summarize(feed) {
  const bots = {}
  for (const [key, a] of Object.entries(feed.accounts || {})) {
    const trips = a.completed_round_trips || []
    const wins = trips.filter((t) => Number(t.net_pnl) > 0).length
    const positions = Array.isArray(a.positions) ? a.positions : Object.values(a.positions || {})
    bots[key] = {
      trades: trips.length,
      open_positions: positions.length,
      realized_pnl: a.realized_pnl ?? '0',
      win_rate: trips.length ? Math.round((wins / trips.length) * 100) : null,
      settled_cash: a.settled_cash ?? null,
      unsettled_cash: a.unsettled_cash ?? null,
    }
  }
  return {
    experiment_id: feed.experiment_id,
    generated_at_pt: feed.generated_at_pt,
    synced_at: feed.synced_at,
    paper_only: true,
    disclaimer: feed.disclaimer,
    latest_probe: feed.latest_probe
      ? { observed_at: feed.latest_probe.observed_at, passed: feed.latest_probe.passed, eligible_fresh_count: feed.latest_probe.eligible_fresh_count }
      : null,
    decisions: (feed.decisions || []).length,
    fills: (feed.fills || []).filter((f) => !f.rejected).length,
    bots,
  }
}

function send(res, status, body, cache = 'public, max-age=0, s-maxage=60, stale-while-revalidate=300') {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', cache)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.end(JSON.stringify(body))
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD')
    return send(res, 405, { error: 'method_not_allowed' }, 'no-store')
  }
  const route = routeOf(req)
  let feed
  let source
  try {
    ;({ feed, source } = await loadFeed())
  } catch {
    return send(res, 503, { error: 'paper_feed_unavailable' }, 'no-store')
  }
  if (route === 'feed') return send(res, 200, feed)
  if (route === 'summary') return send(res, 200, summarize(feed))
  if (route === 'health') return send(res, 200, { ok: true, paper_only: true, source, generated_at_pt: feed.generated_at_pt, synced_at: feed.synced_at }, 'no-store')
  return send(res, 404, { error: 'not_found', routes: ['/api/paper/feed', '/api/paper/summary', '/api/paper/health'] }, 'no-store')
}
