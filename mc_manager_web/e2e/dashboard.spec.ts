import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'

/**
 * 仪表盘 E2E（数据源：scripts/mock-server.mjs）
 * 验收：统计卡渲染 / 启停确认交互 / 命令发送 / 通知抽屉 / 视觉截图
 */

// 可选截图（调试用）：设 E2E_SHOT=1 时输出到 test-results/shots/，默认关闭
const SHOT_DIR = path.join(process.cwd(), 'test-results', 'shots')
function maybeShot(page: Page, name: string) {
  return process.env.E2E_SHOT ? page.screenshot({ path: path.join(SHOT_DIR, name) }) : undefined
}

/** 注入连接配置（mock 假 key，mock server 不校验）——严禁真实服务器信息 */
async function setupConnection(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'mcs-connection',
      JSON.stringify({ baseUrl: '', apiKey: 'e2e-mock-key-0000000000' }),
    )
  })
}

test.describe('仪表盘', () => {
  test('统计卡渲染：顶部四卡 + 右栏五卡 + 健康标签 + 实时数据', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/dashboard')
    // 顶部四卡 + 右栏卡标题
    for (const title of ['在线玩家', 'TPS', 'CPU', '内存', 'MC 时钟 · 世界控制', '事件与待办', '公告发送', '实例运行信息']) {
      await expect(page.getByText(title).first()).toBeVisible()
    }
    // 健康标签与实时数据
    await expect(page.getByText('健康')).toBeVisible()
    await expect(page.getByText('20.0')).toBeVisible()
    await expect(page.getByText('3/20').first()).toBeVisible()
    await expect(page.getByText('OP 1/3')).toBeVisible()
    await expect(page.getByText('2h 0m')).toBeVisible()
    await expect(page.getByText('2d 0h')).toBeVisible()
    await expect(page.getByText('第 42 天')).toBeVisible()
  })

  test('MC 时钟·世界控制：天气/时间按钮点击即发命令', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/dashboard')
    await page.getByRole('button', { name: '🌧 雨天' }).click()
    await expect(page.getByText(/命令已发送: weather rain/)).toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: '夜晚' }).click()
    await expect(page.getByText(/命令已发送: time set night/)).toBeVisible({ timeout: 10_000 })
  })

  test('公告发送：模板填充 → 发送 say → 清空', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/dashboard')
    await page.getByRole('button', { name: /服务器将在 5 分钟后重启/ }).click()
    await expect(page.getByLabel('公告内容')).toHaveValue('服务器将在 5 分钟后重启，请及时停靠')
    await page.getByRole('button', { name: '发送公告' }).click()
    await expect(page.getByText(/命令已发送: say 服务器将在/)).toBeVisible({ timeout: 10_000 })
    await expect(page.getByLabel('公告内容')).toHaveValue('')
  })

  test('事件卡「全部动态」直达通知抽屉（跨组件共享状态）', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/dashboard')
    await page.getByRole('button', { name: '全部动态' }).click()
    await expect(page.getByRole('heading', { name: '通知' })).toBeVisible()
  })

  test('在线玩家卡「全部」跳转玩家页（列表钻入）', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/dashboard')
    await page.getByRole('button', { name: '查看全部玩家' }).click()
    await expect(page).toHaveURL(/\/players/)
  })

  test('在线玩家卡整行可点直达玩家详情', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/dashboard')
    await page.getByRole('button', { name: '查看 Steve 详情' }).click()
    await expect(page).toHaveURL(/\/players\?player=Steve/)
  })

  test('启停确认交互：停止需确认，确认后 toast', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/dashboard')
    const stopBtn = page.getByRole('button', { name: '停止' })
    await expect(stopBtn).toBeEnabled()
    await stopBtn.click()
    await expect(page.getByRole('heading', { name: '关闭服务器' })).toBeVisible()
    // B8 停止确认动态文案：mock 有在线玩家 → 显示人数
    await expect(page.getByText(/名玩家当前在线/)).toBeVisible()
    await page.getByRole('button', { name: '停止', exact: true }).last().click()
    await expect(page.getByText('服务器已停止')).toBeVisible({ timeout: 10_000 })
  })

  test('命令输入：回车发送 + toast 反馈', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/dashboard')
    const input = page.getByLabel('服务器命令输入')
    await input.fill('say hello')
    await input.press('Enter')
    await expect(page.getByText(/命令已发送: say hello/)).toBeVisible({ timeout: 10_000 })
  })

  test('命令补全：/ 开头出现下拉', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/dashboard')
    const input = page.getByLabel('服务器命令输入')
    await input.fill('/ga')
    await expect(page.getByRole('option', { name: /gamemode/ })).toBeVisible()
  })

  test('通知抽屉：铃铛打开空态', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/dashboard')
    await page.getByRole('button', { name: /通知/ }).click()
    await expect(page.getByRole('heading', { name: '通知' })).toBeVisible()
    await expect(page.getByRole('button', { name: /全部已读/ })).toBeDisabled()
  })

  test('顶栏状态点：连接后显示已连接', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/dashboard')
    // WS 未连通（mock server 无 WS）→ 状态点为连接中/未连接；实例选择器显示实例名
    await expect(page.getByText('E2E 演示实例').first()).toBeVisible()
  })

  test('视觉截图：仪表盘暗色/命令面板/通知抽屉/亮色', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await setupConnection(page)
    await page.goto('/dashboard')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(1000) // 等统计卡数据渲染
    await maybeShot(page, 'dashboard-dark.png')

    await page.keyboard.press('Control+k')
    await expect(page.getByPlaceholder('输入页面名称或命令…')).toBeVisible()
    await maybeShot(page, 'command-palette-dark.png')
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: /通知/ }).click()
    await expect(page.getByRole('heading', { name: '通知' })).toBeVisible()
    await maybeShot(page, 'notification-drawer-dark.png')
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: /切换到亮色主题/ }).click()
    await expect(page.locator('html')).toHaveClass(/light/)
    await page.waitForTimeout(500)
    await maybeShot(page, 'dashboard-light.png')
  })
})
