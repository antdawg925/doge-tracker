import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const YAHOO_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

function withYahooHeaders(proxy) {
  proxy.on('proxyReq', (proxyReq) => {
    proxyReq.setHeader('User-Agent', YAHOO_UA)
    proxyReq.setHeader('Accept', 'application/json,text/plain,*/*')
  })
}

// CoinGecko: /api/coingecko/* -> https://api.coingecko.com/api/v3/*
// Kraken:    /api/kraken/*    -> https://api.kraken.com/*
// Yahoo:     /api/yahoo/*     -> https://query1.finance.yahoo.com/*
//            /api/yahoo-search/* -> https://query2.finance.yahoo.com/*
export default defineConfig({
  plugins: [react()],
  server: {
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
      '/api/yahoo': {
        target: 'https://query1.finance.yahoo.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/yahoo/, ''),
        configure: withYahooHeaders,
      },
    },
  },
})
