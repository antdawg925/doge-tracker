import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
// CoinGecko usually allows browser CORS. If blocked, the hook falls back to
// this proxy: /api/coingecko/* -> https://api.coingecko.com/api/v3/*
// Kraken OHLC fallback: /api/kraken/* -> https://api.kraken.com/*
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
    },
  },
})
