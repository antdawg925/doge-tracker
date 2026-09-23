const YAHOO_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

function buildTargetUrl(base, pathParts, query) {
  const path = (Array.isArray(pathParts) ? pathParts : pathParts ? [pathParts] : [])
    .map((p) => encodeURIComponent(String(p)))
    .join('/')
  // Yahoo paths need slashes preserved but segments encoded carefully —
  // finance paths use unencoded slashes; re-join without over-encoding.
  const rawPath = (Array.isArray(pathParts) ? pathParts : pathParts ? [pathParts] : [])
    .map(String)
    .join('/')
  const qs = new URLSearchParams()
  if (query && typeof query === 'object') {
    for (const [k, v] of Object.entries(query)) {
      if (k === 'path') continue
      if (Array.isArray(v)) v.forEach((item) => qs.append(k, String(item)))
      else if (v != null) qs.set(k, String(v))
    }
  }
  const q = qs.toString()
  return `${base.replace(/\/$/, '')}/${rawPath}${q ? `?${q}` : ''}`
}

async function proxyGet(req, res, { base, withYahooHeaders = false }) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405
    res.setHeader('Allow', 'GET, HEAD')
    res.end('Method Not Allowed')
    return
  }

  const url = buildTargetUrl(base, req.query.path, req.query)
  const headers = {
    Accept: 'application/json,text/plain,*/*',
  }
  if (withYahooHeaders) {
    headers['User-Agent'] = YAHOO_UA
  }

  try {
    const upstream = await fetch(url, { headers, method: req.method })
    const contentType = upstream.headers.get('content-type') || 'application/json'
    res.statusCode = upstream.status
    res.setHeader('Content-Type', contentType)
    res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60')
    // Avoid caching errors aggressively
    if (upstream.status >= 400) {
      res.setHeader('Cache-Control', 'no-store')
    }
    const body = Buffer.from(await upstream.arrayBuffer())
    res.end(body)
  } catch (err) {
    res.statusCode = 502
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ error: 'Upstream fetch failed', detail: String(err?.message || err) }))
  }
}

module.exports = { proxyGet, buildTargetUrl }
