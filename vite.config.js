import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
// CoinGecko usually allows browser CORS. If blocked, the hook falls back to
// this proxy: /api/coingecko/* -> https://api.coingecko.com/api/v3/*
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api/coingecko': {
        target: 'https://api.coingecko.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/coingecko/, '/api/v3'),
      },
    },
  },
})
