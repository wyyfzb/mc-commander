/// <reference types="vitest/config" />
import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import pkg from './package.json' with { type: 'json' }

// dev proxy 目标：服务端默认同机 25566（可用 VITE_PROXY_TARGET 覆盖）
// 服务端 CORS 默认仅同源（middleware/cors.js origin:false），
// 开发期经 proxy 转发规避跨域；生产 M7 由 Express 同源托管
const proxyTarget = process.env.VITE_PROXY_TARGET || 'http://localhost:25566'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // PWA（M6 决策 D13）：Workbox 生成 manifest + service worker。
    // 开发环境禁用（devOptions.enabled=false 仍可测试 SW 逻辑）；API/WS 不缓存。
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'MC Commander',
        short_name: 'MC Commander',
        description: '自托管 Minecraft 服务器管理面板',
        theme_color: '#0A0E1A',
        background_color: '#0A0E1A',
        display: 'standalone',
        // PWA 主屏直达紧急视图（移动端处置场景；routes.tsx 同款注释的兑现）
        start_url: '/emergency',
        // 图标用相对路径：随 base 解析（根部署 /pwa-icon.svg；子路径部署
        // 如 /app/ 下为 /app/pwa-icon.svg），manifest 相对 URL 以 manifest
        // 所在目录为基准，两种部署形态均正确
        icons: [
          { src: './pwa-icon.svg', sizes: '512x512', type: 'image/svg+xml' },
          { src: './pwa-maskable.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
      workbox: {
        // API/WS 请求不缓存（管理面板数据必须实时；本地审查发现 NetworkFirst
        // 会静默回退陈旧数据造成「假实时」误导干预决策，且跨服务器缓存串用
        // ——管理面板离线场景应显式报错而非展示过期状态）
        navigateFallbackDenylist: [/^\/api\//, /^\/ws/],
        // Monaco 的 ts.worker/editor.api 是文件页懒加载 chunk（打开 .ts 才用），
        // 超 2MiB precache 默认上限（否则 build 失败），且不应进首屏 precache
        // 清单（6.9MB worker 全量 precache 违背离线快取初衷）。如需离线打开
        // 文件编辑器，后续可给这两类加 runtimeCaching CacheFirst
        globIgnores: ['**/ts.worker-*.js', '**/editor.api-*.js'],
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
      '@mc-commander/schemas': path.resolve(import.meta.dirname, '../mc-schemas/src/index.ts'),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: proxyTarget,
        changeOrigin: true,
      },
      '/ws': {
        target: proxyTarget,
        ws: true,
        changeOrigin: true,
      },
    },
  },
  // preview（e2e 用）：代理配置与 dev 一致，构建产物直出无编译延迟
  preview: {
    proxy: {
      '/api': {
        target: proxyTarget,
        changeOrigin: true,
      },
      '/ws': {
        target: proxyTarget,
        ws: true,
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['e2e/**', 'node_modules/**'],
    css: false, // 组件测试不解析 CSS（token 校验走独立脚本/测试）
    pool: 'threads', // 全量测试 107s → 64s（2026-08-20 实测；Windows 上 threads 显著快于默认 forks）
  },
  define: {
    // 应用版本（package.json 同步；关于页展示，避免硬编码失真）
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    rollupOptions: {
      output: {
        // 分包（M6 方案）：框架/路由/查询库 vendor 拆分 + 页面 route-level lazy 已覆盖主体积。
        // 函数形式而非对象字面量：Vite 8.2 的 manualChunks 类型仅认可函数签名，
        // 对象形式触发 TS2769 使 npm run build 的 tsc -b 失败
        manualChunks(id) {
          if (
            id.includes('/node_modules/react/') ||
            id.includes('/node_modules/react-dom/') ||
            id.includes('/node_modules/react-router/')
          ) {
            return 'vendor-react'
          }
          if (id.includes('/node_modules/@tanstack/react-query/')) {
            return 'vendor-query'
          }
          if (id.includes('/node_modules/lucide-react/') || id.includes('/node_modules/sonner/')) {
            return 'vendor-ui'
          }
        },
      },
    },
  },
})
