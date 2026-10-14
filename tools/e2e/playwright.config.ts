import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { defineConfig } from '@playwright/test'

/**
 * Playwright 配置
 * E2E 数据源：同目录 mock-server.mjs（webServer 以 apps/web 为 cwd 拉起，见下）；
 * 调试截图：设 E2E_SHOT=1 输出到 test-results/shots/（默认关闭）
 * 端口可用 MOCK_PORT/DEV_PORT 环境变量覆盖；浏览器通道降级链：
 * PLAYWRIGHT_CHANNEL env → 系统 Chrome → 系统 Edge → 内置 chromium
 *
 * 位置约定：本配置住 tools/e2e/（工具链），被测前端在 apps/web/——两者不同层。
 * 因此 testDir 与 webServer 的 cwd 必须分别显式给出，不能靠配置所在目录推。
 */
const E2E_DIR = import.meta.dirname
const WEB_DIR = resolve(E2E_DIR, '..', '..', 'apps', 'web')

const MOCK_PORT = Number(process.env.MOCK_PORT) || 5198
const DEV_PORT = Number(process.env.DEV_PORT) || 5199

// 显式标注：不标则元组被推成 (string | string[])[][]，解构出的 channel 可能是数组
const CHANNEL_CANDIDATES: [string, string[]][] = [
  [
    'chrome',
    [
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
    ],
  ],
  [
    'msedge',
    [
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
      '/usr/bin/microsoft-edge',
    ],
  ],
]

function resolveChannel(): string | undefined {
  if (process.env.PLAYWRIGHT_CHANNEL) return process.env.PLAYWRIGHT_CHANNEL
  for (const [channel, paths] of CHANNEL_CANDIDATES) {
    if (paths.some((p) => existsSync(p))) return channel
  }
  return undefined // 无系统浏览器 → Playwright 内置 chromium
}

export default defineConfig({
  // spec 与本配置同目录（工具链）；被测应用在 WEB_DIR
  testDir: E2E_DIR,
  // 产物目录锚在工具层：apps/web 只留产品源码与单测，测试产物不再落进包内
  outputDir: join(E2E_DIR, 'test-results'),
  fullyParallel: false,
  // CI 上必需检查一票否决合并，网络抖动偶发红会硬性卡住 PR，故重试 2 次；
  // 本地保持 0 快速失败
  retries: process.env.CI ? 2 : 0,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: join(E2E_DIR, 'playwright-report') }],
  ],
  // M6 起路由级 lazy：dev 下首访页面触发 chunk 编译（Monaco 等大 chunk 较慢），
  // 默认 5s 在并行 worker 竞争下偶发超时——放宽到 15s（生产构建无编译延迟）
  expect: { timeout: 15_000 },
  use: {
    baseURL: `http://localhost:${DEV_PORT}`,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium', channel: resolveChannel() },
    },
  ],
  webServer: [
    {
      // mock 后端与本配置同目录；cwd 无关（它只用 node: 内置模块）
      command: `node ${join(E2E_DIR, 'mock-server.mjs')}`,
      url: `http://localhost:${MOCK_PORT}/api/v1/overview`,
      reuseExistingServer: true,
      timeout: 30_000,
      env: { MOCK_PORT: String(MOCK_PORT) },
    },
    // E2E_SERVER=preview 时服务构建产物（vite preview，页面加载无编译延迟，
    // CI 用）；默认 dev（本地改代码即测）
    // cwd 必须是 apps/web：vite 按 cwd 找 vite.config.ts 与 index.html，
    // 从 tools/e2e 起会找不到应用根
    process.env.E2E_SERVER === 'preview'
      ? {
          command: `npm run preview -- --port ${DEV_PORT} --strictPort`,
          cwd: WEB_DIR,
          url: `http://localhost:${DEV_PORT}`,
          reuseExistingServer: true,
          timeout: 30_000,
          env: { VITE_PROXY_TARGET: `http://localhost:${MOCK_PORT}` },
        }
      : {
          command: `npm run dev -- --port ${DEV_PORT}`,
          cwd: WEB_DIR,
          url: `http://localhost:${DEV_PORT}`,
          reuseExistingServer: true,
          timeout: 60_000,
          env: { VITE_PROXY_TARGET: `http://localhost:${MOCK_PORT}` },
        },
  ],
})
