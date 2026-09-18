import { test, expect } from '@playwright/test'

/**
 * 审计页多页形态（375×812）：分页栏渲染、翻页链路与窄屏不溢出
 *
 * 缺口：`scripts/mock-server.mjs` 审计日志只有 5 条、命令历史只有 4 条，
 * pageSize=20 下 totalPages 恒为 1 ⇒ 分页栏（prev-next 按钮 + 「第 x/y 页」文案）
 * 在既有 e2e 里结构性不可达，窄屏分页的折行/溢出从未被实测。
 *
 * 夹具策略：在路由层接管列表响应、复制成多页规模，**不改 mock-server 的数据规模**——
 * 改 mock 会连带影响 audit/mobile 等既有 spec 的条数与计数断言。
 * 分页栏在 375 下的防折行配方（flex-wrap + 文案 whitespace-nowrap）由本文件实测锁定。
 */

const TOTAL_AUDIT = 60
const TOTAL_CMD = 45
const AUDIT_ACTIONS = ['INSTANCE_START', 'PLAYER_OP', 'CONFIG_CHANGE', 'BACKUP_CREATE', 'PLAYER_KICK']

/** 注入连接配置（mock 假 key，mock server 不校验）——严禁真实服务器信息 */
async function setupConnection(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'mcs-connection',
      JSON.stringify({ baseUrl: '', apiKey: 'e2e-mock-key-0000000000' }),
    )
  })
}

/** 与 mock-server 同口径：UTC「YYYY-MM-DD HH:MM:SS」（无 T 分隔，对齐真服务端） */
function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 3600000).toISOString().replace('T', ' ').slice(0, 19)
}

/** 分页信封（对齐 audit-logs / command-history 的响应契约） */
function envelope(data: unknown[], total: number, page: number, pageSize: number) {
  return {
    status: 'ok', code: 0, message: 'Success', data,
    pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) },
    timestamp: new Date().toISOString(),
  }
}

/** 路由层把审计日志放大成 TOTAL_AUDIT 条（倒序 id=1 最先） */
async function inflateAuditLogs(page: import('@playwright/test').Page) {
  await page.route('**/api/v1/audit-logs**', async (route) => {
    const q = new URL(route.request().url()).searchParams
    const p = Math.max(1, parseInt(q.get('page') || '1') || 1)
    const pageSize = Math.min(200, Math.max(1, parseInt(q.get('pageSize') || '20') || 20))
    const rows = Array.from({ length: TOTAL_AUDIT }, (_, i) => ({
      id: i + 1,
      instanceId: 'e2e-demo',
      action: AUDIT_ACTIONS[i % AUDIT_ACTIONS.length],
      targetType: 'instance',
      targetId: 'e2e-demo',
      detail: { reason: `批量夹具 ${i + 1}` },
      source: 'web',
      createdAt: hoursAgo(i + 1),
    }))
    const start = (p - 1) * pageSize
    await route.fulfill({ json: envelope(rows.slice(start, start + pageSize), TOTAL_AUDIT, p, pageSize) })
  })
}

/** 路由层把命令历史放大成 TOTAL_CMD 条 */
async function inflateCommandHistory(page: import('@playwright/test').Page) {
  await page.route('**/api/v1/command-history**', async (route) => {
    const q = new URL(route.request().url()).searchParams
    const p = Math.max(1, parseInt(q.get('page') || '1') || 1)
    const pageSize = Math.min(200, Math.max(1, parseInt(q.get('pageSize') || '20') || 20))
    const rows = Array.from({ length: TOTAL_CMD }, (_, i) => ({
      id: i + 1,
      instanceId: 'e2e-demo',
      command: `say 夹具命令 ${i + 1}`,
      source: 'web',
      success: true,
      response: null,
      durationMs: 10 + i,
      createdAt: hoursAgo(i + 1),
    }))
    const start = (p - 1) * pageSize
    await route.fulfill({ json: envelope(rows.slice(start, start + pageSize), TOTAL_CMD, p, pageSize) })
  })
}

test.describe('审计页多页形态（375px）', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
  })

  test('审计日志：分页栏可见、翻页改 URL 与内容、边界页按钮禁用', async ({ page }) => {
    await inflateAuditLogs(page)
    await setupConnection(page)
    await page.goto('/audit')

    // 单页形态（totalPages=1）不渲染翻页按钮：多页下必须出现
    await expect(page.getByText(/共 60 条 · 第 1\/3 页/)).toBeVisible()
    const prev = page.getByRole('button', { name: '上一页' })
    const next = page.getByRole('button', { name: '下一页' })
    await expect(prev).toBeDisabled()
    await expect(next).toBeEnabled()

    // 翻到第 2 页：URL 持久化 + 内容实际更新（第 2 页首行 = id 21）
    await next.click()
    await expect(page.getByText(/第 2\/3 页/)).toBeVisible()
    await expect(page).toHaveURL(/page=2/)
    await expect(page.getByText('批量夹具 21')).toBeVisible()
    await expect(prev).toBeEnabled()

    // 末页边界：下一页禁用
    await next.click()
    await expect(page.getByText(/第 3\/3 页/)).toBeVisible()
    await expect(next).toBeDisabled()

    // 窄屏分页不把页面撑出横向溢出（document 与 main 双口径，同 mobile.spec 惯例）
    const doc = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }))
    expect(doc.scrollWidth).toBeLessThanOrEqual(doc.clientWidth)
    const mainOverflow = await page.locator('#main-content').evaluate((el) => el.scrollWidth - el.clientWidth)
    expect(mainOverflow).toBeLessThanOrEqual(0)
  })

  test('命令历史：多页分页栏同样可达', async ({ page }) => {
    await inflateAuditLogs(page)
    await inflateCommandHistory(page)
    await setupConnection(page)
    await page.goto('/audit')

    await page.getByRole('tab', { name: '命令历史' }).click()
    await expect(page.getByText(/共 45 条 · 第 1\/3 页/)).toBeVisible()
    await expect(page.getByRole('button', { name: '下一页' })).toBeEnabled()
  })
})
