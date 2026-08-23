import { existsSync } from 'node:fs'
import { defineConfig } from '@playwright/test'

/**
 * Playwright 配置
 * E2E 数据源：scripts/mock-server.mjs + dev server proxy 指向它；
 * 调试截图：设 E2E_SHOT=1 输出到 test-results/shots/（默认关闭）
 * 端口可用 MOCK_PORT/DEV_PORT 环境变量覆盖；浏览器通道降级链：
 * PLAYWRIGHT_CHANNEL env → 系统 Chrome → 系统 Edge → 内置 chromium
 */
const MOCK_PORT = Number(process.env.MOCK_PORT) || 5198
const DEV_PORT = Number(process.env.DEV_PORT) || 5199

const CHANNEL_CANDIDATES = [
  ['chrome', ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium']],
  ['msedge', ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', '/usr/bin/microsoft-edge']],
]

function resolveChannel(): string | undefined {
  if (process.env.PLAYWRIGHT_CHANNEL) return process.env.PLAYWRIGHT_CHANNEL
  for (const [channel, paths] of CHANNEL_CANDIDATES) {
    if (paths.some((p) => existsSync(p))) return channel
  }
  return undefined // 无系统浏览器 → Playwright 内置 chromium
}

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
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
      command: 'node scripts/mock-server.mjs',
      url: `http://localhost:${MOCK_PORT}/api/v1/overview`,
      reuseExistingServer: true,
      timeout: 30_000,
      env: { MOCK_PORT: String(MOCK_PORT) },
    },
    {
      command: `npm run dev -- --port ${DEV_PORT}`,
      url: `http://localhost:${DEV_PORT}`,
      reuseExistingServer: true,
      timeout: 60_000,
      env: { VITE_PROXY_TARGET: `http://localhost:${MOCK_PORT}` },
    },
  ],
})
