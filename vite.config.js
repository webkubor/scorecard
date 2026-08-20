import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { readFileSync } from 'node:fs'

// 版本号构建时注入 —— 前端只为拿个版本号发一次请求不划算，
// 而 package.json 本来就是它的真源。
const VERSION = JSON.parse(readFileSync('./package.json', 'utf8')).version

const BACKEND_PORT = process.env.SCORECARD_PORT || 54445
const FRONTEND_PORT = process.env.SCORECARD_FRONTEND_PORT || 54446

export default defineConfig({
  plugins: [vue()],
  define: { __APP_VERSION__: JSON.stringify(VERSION) },
  server: {
    host: true,
    port: FRONTEND_PORT,
    strictPort: true, // 端口被占就报错退出，别静默换端口
    open: false,
    allowedHosts: true, // cloudflared 临时隧道每次重启换域名
    // dev 时把 /api 与 /og 代理到后端；后端要先跑起来（bun run server）
    proxy: {
      '/api': { target: `http://127.0.0.1:${BACKEND_PORT}`, changeOrigin: true },
      '/og': { target: `http://127.0.0.1:${BACKEND_PORT}`, changeOrigin: true }
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
})
