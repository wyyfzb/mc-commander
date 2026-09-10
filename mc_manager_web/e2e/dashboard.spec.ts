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
  test('统计卡渲染：顶部三卡 + 右栏三卡 + 健康标签 + 实时数据', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/dashboard')
    // 顶部三卡 + 右栏卡标题
    for (const title of [
      '在线玩家',
      '资源使用',
      '实例信息',
      'MC 时钟 · 世界控制',
      '最近备份',
      '公告发送',
    ]) {
      await expect(page.getByText(title).first()).toBeVisible()
    }
    // 健康标签与实时数据
    await expect(page.getByText('健康')).toBeVisible()
    await expect(page.getByText('20.0')).toBeVisible()
    // v2 大数/小数分层：外层 span 完整文本为「在线/上限」整体，断言合并串
    await expect(page.getByText('3/20', { exact: true })).toBeVisible()
    await expect(page.getByText('OP 1/3')).toBeVisible()
    await expect(page.getByText('2h 0m')).toBeVisible()
    await expect(page.getByText('2d 0h')).toBeVisible()
    await expect(page.getByText('第 42 天')).toBeVisible()
  })

  test('最近备份卡：渲染备份行 + 旧格式徽章，「全部」跳转设置页备份子路由', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/dashboard')
    await expect(page.getByText('手动备份 2026-08-14')).toBeVisible()
    await expect(page.getByText('旧格式压缩包')).toBeVisible()
    await expect(page.getByText('旧格式', { exact: true })).toBeVisible()
    // 入口必须落在真实子路由 /settings/backup（历史上曾指向不存在的 /settings/backups）
    await page.getByRole('button', { name: '查看全部备份' }).click()
    await expect(page).toHaveURL(/\/settings\/backup$/)
    await expect(page.getByText('备份管理').first()).toBeVisible()
  })

  test('MC 时钟·世界控制：天气/时间按钮点击即发命令', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/dashboard')
    // 成功反馈已静默（终端回显为反馈源），以命令请求实际发出为断言信号
    const rainReq = page.waitForRequest(
      (r) => r.url().includes('/command') && String(r.postDataJSON()?.command).includes('weather rain'),
    )
    await page.getByRole('button', { name: '雨天' }).click()
    await rainReq
    const nightReq = page.waitForRequest(
      (r) => r.url().includes('/command') && String(r.postDataJSON()?.command).includes('time set night'),
    )
    await page.getByRole('button', { name: '夜晚' }).click()
    await nightReq
  })

  test('公告发送：预设胶囊填充 → 发送 → 二次确认 → say → 清空', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/dashboard')
    // 胶囊显示预设名（同名还有编辑/删除按钮，exact 避免子串匹配）
    await page.getByRole('button', { name: '重启预告', exact: true }).click()
    await expect(page.getByLabel('公告内容')).toHaveValue('服务器将在 5 分钟后重启，请及时停靠')
    const sayReq = page.waitForRequest(
      (r) => r.url().includes('/command') && String(r.postDataJSON()?.command).includes('say 服务器将在'),
    )
    await page.getByRole('button', { name: '发送公告' }).click()
    // 二次确认弹窗
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await sayReq
    await expect(page.getByLabel('公告内容')).toHaveValue('')
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
    // 停止收敛共享 mutation（issue 334）：指令发送即 toast（服务端异步确认走 WS status 事件）
    await expect(page.getByText('停止指令已发送')).toBeVisible({ timeout: 10_000 })
  })

  test('命令输入：回车发送（成功静默，终端回显为反馈源）', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/dashboard')
    const input = page.getByLabel('服务器命令输入')
    const cmdReq = page.waitForRequest(
      (r) => r.url().includes('/command') && String(r.postDataJSON()?.command).includes('say hello'),
    )
    await input.fill('say hello')
    await input.press('Enter')
    await cmdReq
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

  test('顶栏状态点：WS 连接后显示已连接', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/dashboard')
    // mock server 提供 /ws 端点（握手鉴权 + 订阅快照）→ 状态点应为已连接
    await expect(page.getByText('已连接').first()).toBeVisible({ timeout: 10_000 })
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
