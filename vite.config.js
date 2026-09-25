import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import { fetchYahooUpstream, YAHOO_UA } from './api/_yahooUpstream.js'

function withYahooHeaders(proxy) {
  proxy.on('proxyReq', (proxyReq) => {
    proxyReq.setHeader('User-Agent', YAHOO_UA)
    proxyReq.setHeader('Accept', 'application/json,text/plain,*/*')
  })
}

/**
 * Dev middleware: /api/yahoo/* uses the same crumb-aware upstream as Vercel
 * (quoteSummary HTML fallback included). Other Yahoo-search stays on http-proxy.
 */
function yahooApiPlugin() {
  return {
    name: 'yahoo-api-crumb',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        try {
          const url = req.url || ''
          if (!url.startsWith('/api/yahoo/') && url !== '/api/yahoo') {
            next()
            return
          }
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.statusCode = 405
            res.setHeader('Allow', 'GET, HEAD')
            res.end('Method Not Allowed')
            return
          }
          const u = new URL(url, 'http://localhost')
          const rest = u.pathname.replace(/^\/api\/yahoo\/?/, '')
          if (!rest) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'Missing upstream path' }))
            return
          }
          const query = Object.fromEntries(u.searchParams.entries())
          const result = await fetchYahooUpstream(rest, query, {
            method: req.method,
          })
          res.statusCode = result.status
          res.setHeader('Content-Type', result.contentType)
          res.setHeader(
            'Cache-Control',
            result.status >= 400
              ? 'no-store'
              : 'public, s-maxage=60, stale-while-revalidate=120',
          )
          if (req.method === 'HEAD') res.end()
          else res.end(result.body)
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
      })
    },
  }
}

/**
 * Dev middleware: POST /api/redeem-key runs the same handler as the Vercel function.
 * Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local (server-only, no
 * VITE_ prefix so they never reach the browser bundle). Without them redeeming
 * returns "not configured"; sign-up / sign-in work with just the VITE_ vars.
 * Node 22+ recommended (supabase-js needs a native WebSocket on the server side).
 */
function supabaseApiPlugin() {
  return {
    name: 'supabase-api',
    configureServer(server) {
      const env = loadEnv(server.config.mode, server.config.root, 'SUPABASE_')
      for (const [k, v] of Object.entries(env)) {
        if (!process.env[k]) process.env[k] = v
      }
      server.middlewares.use('/api/redeem-key', async (req, res) => {
        const { default: handler } = await import('./api/redeem-key.js')
        await handler(req, res)
      })
    },
  }
}

// CoinGecko: /api/coingecko/* -> https://api.coingecko.com/api/v3/*
// Kraken:    /api/kraken/*    -> https://api.kraken.com/*
// Yahoo:     /api/yahoo/*     -> crumb-aware middleware (see yahooApiPlugin)
//            /api/yahoo-search/* -> https://query2.finance.yahoo.com/*
export default defineConfig({
  plugins: [react(), yahooApiPlugin(), supabaseApiPlugin()],
  // SPA client-side routing: Vite's dev server already falls back to index.html
  // for unknown paths (historyApiFallback equivalent). Production hosts need the
  // same rewrite when deploying dist/ — see README.
  server: {
    // Allow phone / other devices on the same Wi‑Fi (e.g. http://10.0.0.x:5173)
    host: true,
    port: 5173,
    strictPort: true,
    proxy: {
      '/api/coingecko': {
        target: 'https://api.coingecko.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/coingecko/, '/api/v3'),
      },
      '/api/kraken': {
        target: 'https://api.kraken.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/kraken/, ''),
      },
      '/api/yahoo-search': {
        target: 'https://query2.finance.yahoo.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/yahoo-search/, ''),
        configure: withYahooHeaders,
      },
      // /api/yahoo handled by yahooApiPlugin middleware (crumb + HTML fallback)
    },
  },
})
