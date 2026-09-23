import https from 'https'
import { URL as NodeURL } from 'url'
/**
 * Shared Yahoo Finance upstream fetch with crumb/cookie session.
 * Used by the Vercel catch-all and the Vite dev middleware.
 */

export const YAHOO_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const CRUMB_TTL_MS = 45 * 60 * 1000 // reuse crumb ~45m within a warm instance

let session = {
  cookie: null,
  crumb: null,
  fetchedAt: 0,
  inflight: null,
}

function needsCrumb(path) {
  const p = String(path || '')
  return (
    p.includes('/quoteSummary/') ||
    p.includes('/v7/finance/quote') ||
    p.includes('/v6/finance/quote')
  )
}

function cookieHeaderFromSetCookie(setCookieHeaders) {
  if (!setCookieHeaders) return null
  const list = Array.isArray(setCookieHeaders)
    ? setCookieHeaders
    : [setCookieHeaders]
  const parts = []
  for (const line of list) {
    const nv = String(line).split(';')[0]
    if (nv && nv.includes('=')) parts.push(nv)
  }
  return parts.length ? parts.join('; ') : null
}

function mergeCookies(existing, setCookieHeaders) {
  const map = new Map()
  for (const part of String(existing || '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const i = part.indexOf('=')
    if (i > 0) map.set(part.slice(0, i), part.slice(i + 1))
  }
  const fresh = cookieHeaderFromSetCookie(setCookieHeaders)
  if (fresh) {
    for (const part of fresh.split(';').map((s) => s.trim())) {
      const i = part.indexOf('=')
      if (i > 0) map.set(part.slice(0, i), part.slice(i + 1))
    }
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
}

function crumbLooksValid(crumb) {
  if (!crumb) return false
  const t = String(crumb).trim()
  if (!t || t.length > 80) return false
  if (/too many requests/i.test(t)) return false
  if (/\s/.test(t)) return false
  return true
}

/** HTTPS GET that tolerates Yahoo's large Set-Cookie header blocks. */
function httpsGetText(urlString, { headers = {}, maxRedirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const attempt = (target, left) => {
      let parsed
      try {
        parsed = new NodeURL(target)
      } catch (err) {
        reject(err)
        return
      }
      const req = https.request(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port || 443,
          path: parsed.pathname + parsed.search,
          method: 'GET',
          headers,
          // Yahoo quote pages send many Set-Cookie headers
          maxHeaderSize: 256 * 1024,
        },
        (res) => {
          const status = res.statusCode || 0
          const setCookie = res.headers['set-cookie']
          if (
            status >= 300 &&
            status < 400 &&
            res.headers.location &&
            left > 0
          ) {
            const next = new NodeURL(res.headers.location, target).toString()
            res.resume()
            attempt(next, left - 1)
            return
          }
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => {
            resolve({
              status,
              body: Buffer.concat(chunks).toString('utf8'),
              setCookie,
            })
          })
        },
      )
      req.on('error', reject)
      req.end()
    }
    attempt(urlString, maxRedirects)
  })
}


async function bootstrapSession({ force = false } = {}) {
  const now = Date.now()
  if (
    !force &&
    session.cookie &&
    crumbLooksValid(session.crumb) &&
    now - session.fetchedAt < CRUMB_TTL_MS
  ) {
    return session
  }
  if (session.inflight) return session.inflight

  session.inflight = (async () => {
    let cookie = ''
    // Seed cookies from finance.yahoo.com (fc.yahoo.com often 404 now)
    try {
      const home = await httpsGetText('https://finance.yahoo.com/', {
        headers: {
          'User-Agent': YAHOO_UA,
          Accept: 'text/html,application/xhtml+xml',
        },
      })
      cookie = mergeCookies(cookie, home.setCookie)
    } catch {
      /* continue — getcrumb may still set cookies */
    }

    const crumbRes = await fetch(
      'https://query1.finance.yahoo.com/v1/test/getcrumb',
      {
        headers: {
          'User-Agent': YAHOO_UA,
          Accept: '*/*',
          ...(cookie ? { Cookie: cookie } : {}),
        },
      },
    )
    const setCookies =
      crumbRes.headers.getSetCookie?.() ||
      (crumbRes.headers.get('set-cookie')
        ? [crumbRes.headers.get('set-cookie')]
        : null)
    cookie = mergeCookies(cookie, setCookies)
    const crumbText = (await crumbRes.text()).trim()

    if (crumbRes.status === 429 || !crumbLooksValid(crumbText)) {
      const err = new Error(
        crumbRes.status === 429
          ? 'Yahoo crumb rate-limited'
          : `Yahoo crumb failed (${crumbRes.status})`,
      )
      err.rateLimited = crumbRes.status === 429
      throw err
    }

    session = {
      cookie,
      crumb: crumbText,
      fetchedAt: Date.now(),
      inflight: null,
    }
    return session
  })()

  try {
    return await session.inflight
  } finally {
    session.inflight = null
  }
}

/**
 * Parse quoteSummary-shaped JSON from the Yahoo quote HTML page
 * (sveltekit dehydrated fetch body). Used when crumb auth fails.
 */
export function parseQuoteSummaryFromHtml(html) {
  if (!html || typeof html !== 'string') return null
  const scripts = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || []
  for (const tag of scripts) {
    const inner = tag.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '')
    if (!inner.includes('quoteSummary') || !inner.includes('shortPercentOfFloat')) {
      // still try scripts that have financialData / summaryProfile
      if (
        !inner.includes('quoteSummary') ||
        !(
          inner.includes('financialData') ||
          inner.includes('defaultKeyStatistics')
        )
      ) {
        continue
      }
    }
    try {
      const wrapper = JSON.parse(inner)
      const body =
        typeof wrapper?.body === 'string'
          ? JSON.parse(wrapper.body)
          : wrapper?.body || wrapper
      const result = body?.quoteSummary?.result?.[0]
      if (result && typeof result === 'object') {
        return { quoteSummary: { result: [result], error: null } }
      }
    } catch {
      /* try next script */
    }
  }
  return null
}

async function fetchQuoteSummaryHtmlFallback(symbol) {
  const sym = encodeURIComponent(String(symbol || '').toUpperCase())
  const url = `https://finance.yahoo.com/quote/${sym}/`
  const res = await httpsGetText(url, {
    headers: {
      'User-Agent': YAHOO_UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  })
  if (res.status < 200 || res.status >= 300) {
    const err = new Error(`Yahoo HTML fallback HTTP ${res.status}`)
    err.status = res.status
    throw err
  }
  const parsed = parseQuoteSummaryFromHtml(res.body)
  if (!parsed) {
    const err = new Error('Yahoo HTML fallback: no quoteSummary blob')
    err.status = 502
    throw err
  }
  return {
    status: 200,
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify(parsed)),
  }
}

function symbolFromQuoteSummaryPath(path) {
  const m = String(path || '').match(/quoteSummary\/([^/?#]+)/i)
  return m ? decodeURIComponent(m[1]) : null
}

/**
 * Fetch a Yahoo query1 path. Attaches crumb for protected endpoints.
 * quoteSummary: on crumb/401 failure, falls back to HTML page parse.
 */
export async function fetchYahooUpstream(path, query = {}, { method = 'GET' } = {}) {
  const restPath = String(path || '').replace(/^\/+/, '')
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(query || {})) {
    if (k === 'slug' || k === 'path' || k === 'crumb') continue
    if (Array.isArray(v)) v.forEach((item) => qs.append(k, String(item)))
    else if (v != null) qs.set(k, String(v))
  }

  const isQuoteSummary = restPath.includes('quoteSummary/')
  const useCrumb = needsCrumb(restPath)
  const sym = isQuoteSummary ? symbolFromQuoteSummaryPath(restPath) : null

  async function once({ forceCrumb = false } = {}) {
    // Clone query params per attempt so crumb does not stack wrongly
    const attemptQs = new URLSearchParams(qs)
    let cookie = null
    let crumb = null
    if (useCrumb) {
      const s = await bootstrapSession({ force: forceCrumb })
      cookie = s.cookie
      crumb = s.crumb
      if (crumb) attemptQs.set('crumb', crumb)
    }
    const q = attemptQs.toString()
    const url = `https://query1.finance.yahoo.com/${restPath}${q ? `?${q}` : ''}`
    const headers = {
      Accept: 'application/json,text/plain,*/*',
      'User-Agent': YAHOO_UA,
    }
    if (cookie) headers.Cookie = cookie

    const upstream = await fetch(url, { headers, method })
    const contentType =
      upstream.headers.get('content-type') || 'application/json'
    const body = Buffer.from(await upstream.arrayBuffer())
    return { status: upstream.status, contentType, body }
  }

  let apiError = null
  let result = null
  try {
    result = await once({ forceCrumb: false })
    if (useCrumb && (result.status === 401 || result.status === 403)) {
      result = await once({ forceCrumb: true })
    }
  } catch (err) {
    apiError = err
  }

  const apiBad =
    !result ||
    result.status === 401 ||
    result.status === 403 ||
    result.status === 429 ||
    result.status >= 500

  if (isQuoteSummary && sym && (apiError || apiBad)) {
    try {
      return await fetchQuoteSummaryHtmlFallback(sym)
    } catch (htmlErr) {
      if (result) return result
      throw apiError || htmlErr
    }
  }

  if (apiError) throw apiError
  return result
}
