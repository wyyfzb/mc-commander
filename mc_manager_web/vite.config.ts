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
  // 门禁脚本内核（scripts/lib/design-token-rules.mjs）的纯逻辑用例：只处理源码字符串、不读 fs
  'scripts/__tests__/design-token-rules.test.mjs',
  'src/__tests__/token-integrity.test.ts',
  // 字体子集覆盖：只读 woff2 字节（自带 cmap 解析），不碰 DOM
  'src/__tests__/font-subset.test.ts',
  'src/api/__tests__/errors.test.ts',
  // 注意：`api/__tests__/{audit,files,files-enhanced}` **不能**放这里 —— 它们用相对 URL
  // （`/api/v1/...`）调 fetch，需要 jsdom 提供的 base URL，在 node 下会报
  // `TypeError: Failed to parse URL from /api/...`（2026-09-15 实测，已移回 dom 项目）。
  'src/api/__tests__/players.test.ts',
  'src/api/__tests__/tasks.test.ts',
  'src/api/__tests__/world.test.ts',
  'src/components/mcs/__tests__/tone.test.ts',
  'src/features/audit/__tests__/time-range.test.ts',
  'src/features/files/__tests__/path-utils.test.ts',
  'src/features/instances/components/deploy/__tests__/utils.test.ts',
  'src/features/players/__tests__/player-pagination.test.ts',
  'src/features/webhooks/__tests__/webhook-api.test.ts',
  'src/lib/__tests__/format.test.ts',
  'src/lib/__tests__/mc-backup.test.ts',
  'src/lib/__tests__/mc-ban.test.ts',
  'src/lib/__tests__/mc-batch.test.ts',
  'src/lib/__tests__/mc-calendar.test.ts',
  'src/lib/__tests__/mc-commands.test.ts',
  'src/lib/__tests__/mc-cron.test.ts',
  'src/lib/__tests__/mc-deploy.test.ts',
  'src/lib/__tests__/mc-enchantments.test.ts',
  'src/lib/__tests__/mc-entities.test.ts',
  'src/lib/__tests__/mc-files.test.ts',
  'src/lib/__tests__/mc-gamerules.test.ts',
  'src/lib/__tests__/mc-properties.test.ts',
  'src/lib/__tests__/mc-teleport.test.ts',
  'src/lib/__tests__/notifications.test.ts',
  'src/lib/__tests__/password-strength.test.ts',
  'src/lib/__tests__/radio-group.test.ts',
  'src/lib/__tests__/second-factor.test.ts',
  'src/lib/__tests__/tailwind-merge.test.ts',
  'src/lib/__tests__/terminal-log.test.ts',
  'src/test/mocks/__tests__/fixtures.test.ts',
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
        // PWA 主屏直达完整面板（原为 /emergency 移动端处置页，该页已移除）
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
      // mc-schemas 位于本包 node_modules 之外，其内部 import 'zod' 无法按目录链解析到
      // 本包依赖，统一钉到显式声明的 zod 副本（与 tsconfig.app.json paths 映射对齐）
      zod: path.resolve(import.meta.dirname, './node_modules/zod'),
    },
  },
  server: {
    // 站内帮助页 `?raw` 直读仓库根 docs/user-guide.md（单一事实源，不在包内复制副本）：
    // 该文件在包根之外，而 Vite 默认只放行包根（allow 未声明时 = [workspaceRoot]，
    // 实测 dev 下裸 import 报 403「outside of Vite serving allow list」）。
    // 显式声明时默认值**不再并入**，故必须带上包根本身；构建期 Rollup 直接走 fs、不受此限，
    // 故本条只影响 dev。deny 默认项（.env / .npmrc / .git）不受 allow 变更影响。
    fs: {
      allow: [path.resolve(import.meta.dirname), path.resolve(import.meta.dirname, '../docs')],
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
          setupFiles: ['./src/test/setup.ts'],
          include: ['src/**/*.test.{ts,tsx}'],
          exclude: [...DOM_EXCLUDE, ...NODE_ENV_TESTS],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['json', 'text'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/**/__tests__/**'],
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
        },
      },
    },
  },
})
