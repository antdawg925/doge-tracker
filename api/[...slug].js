const YAHOO_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const PROVIDERS = {
  yahoo: {
    base: 'https://query1.finance.yahoo.com',
    yahooHeaders: true,
  },
  'yahoo-search': {
    base: 'https://query2.finance.yahoo.com',
    yahooHeaders: true,
  },
  coingecko: {
    base: 'https://api.coingecko.com/api/v3',
  },
  kraken: {
    base: 'https://api.kraken.com',
  },
}

function slugParts(query, reqUrl) {
  let raw = query?.slug ?? query?.path
  if ((raw == null || (Array.isArray(raw) && raw.length === 0)) && reqUrl) {
    try {
      const u = new URL(reqUrl, 'http://localhost')
      // /api/yahoo/v8/... → drop leading "api"
      const segs = u.pathname.split('/').filter(Boolean)
      if (segs[0] === 'api') segs.shift()
      raw = segs
    } catch {
      raw = null
    }
  }
  const list = Array.isArray(raw) ? raw : raw != null ? [raw] : []
  return list
    .flatMap((s) => String(s).split('/'))
    .map((s) => s.trim())
    .filter(Boolean)
}

function buildUrl(base, restPath, query) {
  const qs = new URLSearchParams()
  if (query && typeof query === 'object') {
    for (const [k, v] of Object.entries(query)) {
      if (k === 'slug' || k === 'path') continue
      if (Array.isArray(v)) v.forEach((item) => qs.append(k, String(item)))
      else if (v != null) qs.set(k, String(v))
    }
  }
  const q = qs.toString()
  const path = restPath.replace(/^\/+/, '')
  return `${base.replace(/\/$/, '')}/${path}${q ? `?${q}` : ''}`
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405
      res.setHeader('Allow', 'GET, HEAD')
      res.end('Method Not Allowed')
      return
    }

    const parts = slugParts(req.query, req.url)
    if (parts.length === 0) {
      res.statusCode = 404
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: 'Missing provider path' }))
      return
    }

    const provider = parts[0]
    const rest = parts.slice(1).join('/')
    const cfg = PROVIDERS[provider]
    if (!cfg) {
      res.statusCode = 404
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: `Unknown provider: ${provider}` }))
      return
    }
    if (!rest) {
      res.statusCode = 400
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: 'Missing upstream path' }))
      return
    }

    const url = buildUrl(cfg.base, rest, req.query)
    const headers = { Accept: 'application/json,text/plain,*/*' }
    if (cfg.yahooHeaders) headers['User-Agent'] = YAHOO_UA

    const upstream = await fetch(url, { headers, method: req.method })
    const contentType = upstream.headers.get('content-type') || 'application/json'
    const body = Buffer.from(await upstream.arrayBuffer())

    res.statusCode = upstream.status
    res.setHeader('Content-Type', contentType)
    res.setHeader(
      'Cache-Control',
      upstream.status >= 400
        ? 'no-store'
        : 'public, s-maxage=30, stale-while-revalidate=60',
    )
    res.end(body)
  } catch (err) {
    res.statusCode = 502
    res.setHeader('Content-Type', 'application/json')
    res.end(
      JSON.stringify({
        error: 'Upstream fetch failed',
        detail: String(err?.message || err),
      }),
    )
  }
}
