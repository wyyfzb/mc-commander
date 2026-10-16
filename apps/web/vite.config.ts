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

// 纯逻辑用例（不碰 DOM/RTL，且**传递依赖**也不碰）：改跑 `node` 环境，省下每文件的 jsdom 构建
// 与 jest-dom/RTL setup 导入 —— jsdom 环境构建是全量耗时大头（2026-09-15 实测环境累计 ~1046s、
// setup ~306s）。维护规则：新增纯逻辑用例把路径加进来；若在 node 下报「x is not defined」就把它
// 移回 dom 项目（失败是**明确报错**，不会静默跳过）。stores 域的 3 个用例暂不放入
// （其 persist/localStorage 依赖经 jsdom 才成立）。
const NODE_ENV_TESTS = [
  'tests/unit/token-integrity.test.ts',
  // 字体子集覆盖：只读 woff2 字节（自带 cmap 解析），不碰 DOM
  'tests/unit/font-subset.test.ts',
  'tests/unit/api/errors.test.ts',
  // 注意：`tests/unit/api/{audit,files,files-enhanced}` **不能**放这里 —— 它们用相对 URL
  // （`/api/v1/...`）调 fetch，需要 jsdom 提供的 base URL，在 node 下会报
  // `TypeError: Failed to parse URL from /api/...`（2026-09-15 实测，已移回 dom 项目）。
  'tests/unit/api/players.test.ts',
  'tests/unit/api/tasks.test.ts',
  'tests/unit/api/world.test.ts',
  'tests/unit/components/mcs/tone.test.ts',
  'tests/unit/features/audit/time-range.test.ts',
  'tests/unit/features/files/path-utils.test.ts',
  'tests/unit/features/instances/components/deploy/utils.test.ts',
  'tests/unit/features/players/player-pagination.test.ts',
  'tests/unit/features/webhooks/webhook-api.test.ts',
  'tests/unit/lib/format.test.ts',
  'tests/unit/lib/mc-backup.test.ts',
  'tests/unit/lib/mc-ban.test.ts',
  'tests/unit/lib/mc-batch.test.ts',
  'tests/unit/lib/mc-calendar.test.ts',
  'tests/unit/lib/mc-commands.test.ts',
  'tests/unit/lib/mc-cron.test.ts',
  'tests/unit/lib/mc-deploy.test.ts',
  'tests/unit/lib/mc-enchantments.test.ts',
  'tests/unit/lib/mc-entities.test.ts',
  'tests/unit/lib/mc-files.test.ts',
  'tests/unit/lib/mc-gamerules.test.ts',
  'tests/unit/lib/mc-properties.test.ts',
  'tests/unit/lib/mc-teleport.test.ts',
  'tests/unit/lib/notifications.test.ts',
  'tests/unit/lib/password-strength.test.ts',
  'tests/unit/lib/radio-group.test.ts',
  'tests/unit/lib/second-factor.test.ts',
  'tests/unit/lib/tailwind-merge.test.ts',
  'tests/unit/lib/terminal-log.test.ts',
  'tests/unit/support/fixtures.test.ts',
]
const DOM_EXCLUDE = ['e2e/**', 'node_modules/**']

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
        // PWA 主屏直达完整面板
        start_url: '/dashboard',
        // 图标用相对路径：随 base 解析（根部署 /pwa-icon.svg；子路径部署
        // 如 /app/ 下为 /app/pwa-icon.svg），manifest 相对 URL 以 manifest
        // 所在目录为基准，两种部署形态均正确
        icons: [
          { src: './pwa-icon.svg', sizes: '512x512', type: 'image/svg+xml' },
          {
            src: './pwa-maskable.svg',
            sizes: '512x512',
            type: 'image/svg+xml',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // API/WS 请求不缓存（管理面板数据必须实时；本地审查发现 NetworkFirst
        // 会静默回退陈旧数据造成「假实时」误导干预决策，且跨服务器缓存串用
        // ——管理面板离线场景应显式报错而非展示过期状态）
        navigateFallbackDenylist: [/^\/api\//, /^\/ws/],
        // 编辑器子树整体不进 precache：files-page chunk（含 Monaco 核心，约 2.8MB，超
        // 2MiB 上限即 build 失败）、json 语言服务（jsonMode）与两个 worker 都只服务文件页，
        // 页面本身不预缓存时它们离线也用不上——共省下约 4.5MB 安装体积。其余路由仍可离线。
        // 若将来要离线编辑，改为给这几个 chunk 加 runtimeCaching CacheFirst。
        globIgnores: ['**/files-page-*.js', '**/jsonMode-*.js', '**/*.worker-*.js'],
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
      '@tests': path.resolve(import.meta.dirname, './tests'),
      '@docs': path.resolve(import.meta.dirname, '../../docs'),
      '@mc-commander/schemas': path.resolve(import.meta.dirname, '../schemas/src/index.ts'),
      // 契约包按源码直读（改契约立即可见，不必先 build）；其内部的裸 import（zod）
      // 由 node 解析链从文件所在目录逐级上溯取用——workspace 下依赖统一提升到仓库根，
      // 故**不钉**任何 node_modules 相对路径（曾钉 apps/web/node_modules/zod，提升后即失效）。
      // 将来若真出现实例分裂，用 resolve.dedupe: ['zod']，不要写路径别名。
    },
  },
  server: {
    // dev 要读本包之外的文件（帮助页 `?raw` 直读 docs/user-guide.md、契约包直读
    // apps/schemas/src）：未放行时报 403「outside of Vite serving allow list」——
    // 默认值就是包根，显式声明后不再并入。放行到**工作区根**而非逐目录列举：
    // 新增跨包读取点不必再改这里。构建期 Rollup 直接走 fs，不受此限（只影响 dev）；
    // deny 默认项（.env / .npmrc / .git）不受 allow 变更影响。
    fs: {
      allow: [path.resolve(import.meta.dirname, '../..')],
    },
    // 忽略 Mimosa 钩子运行时状态目录：其文件被锁定时 watch 报 EBUSY 导致 dev server 崩溃
    watch: {
      ignored: ['**/.mimosa/**'],
    },
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
    css: false, // 组件测试不解析 CSS（token 校验走独立脚本/测试）
    pool: 'threads', // 全量测试 107s → 64s（2026-08-20 实测；Windows 上 threads 显著快于默认 forks）
    // 单例超时（默认 5s）必须大于 setup.ts 的异步查询上限，否则失败时先被 vitest
    // 掐断、报「test timed out」而不是 RTL 的「找不到元素」——诊断信息会退化。
    // 各 describe 里本地的 { timeout: 15000 } 与此同值，保留作兜底（全局若调低仍保 15s）
    testTimeout: 15_000,
    // 测试环境拆分（2026-09-15）：见 NODE_ENV_TESTS 上方说明。两个 project 各自声明环境与 setup，
    // 纯逻辑用例不再付 jsdom + jest-dom/RTL 的构建代价。
    projects: [
      // extends: true —— inline project 默认**不继承**根配置（plugins/resolve.alias 都会丢，
      // 实测表现为 `Failed to resolve import "@/lib/utils"`），必须显式继承。
      { extends: true, test: { name: 'unit-node', environment: 'node', include: NODE_ENV_TESTS } },
      {
        extends: true,
        test: {
          name: 'unit-dom',
          environment: 'jsdom',
          setupFiles: ['./tests/support/setup.ts'],
          include: ['tests/unit/**/*.test.{ts,tsx}'],
          exclude: [...DOM_EXCLUDE, ...NODE_ENV_TESTS],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['json', 'text'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['tests/**'],
      // 阈值由本包自己判，不做跨包合计——合计判阈值会让一个包掉到 30%、
      // 另一个 95% 也照样通过
      thresholds: {
        statements: 70,
      },
    },
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
          // Monaco 刻意不单独成块：manualChunks 会把它变成「共享块」，rolldown 随后从入口
          // 静态引用它（实测首屏闭包 +978KB gzip、玩家页/审计页也各带一份），编辑器就退化成
          // 全站必载。保持它随 files-page 懒加载 chunk 走，并从 precache 清单按名排除即可。
        },
      },
    },
  },
})
