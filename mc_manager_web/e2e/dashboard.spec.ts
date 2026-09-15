import path from 'node:path'
import { test, expect, type Locator, type Page } from '@playwright/test'

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

  test('标题层级与关键数字档：数据卡标签 14px/w500/muted、区块卡标题 18px/w600/default、卡级大数 30px', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/dashboard')
    const styleOf = (locator: Locator, prop: string) =>
      locator.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop)
    const fontSizeOf = (locator: Locator) => styleOf(locator, 'font-size')
    // 同屏两级标题可辨：数据卡（KPI）标签行留正文档，真区块标题占标题档
    await expect(page.getByRole('heading', { name: '资源使用' })).toBeVisible()
    await expect(page.getByRole('heading', { name: '最近备份' })).toBeVisible()
    const label = page.getByRole('heading', { name: '资源使用' })
    const heading = page.getByRole('heading', { name: '最近备份' })
    expect(await fontSizeOf(label)).toBe('14px')
    expect(await fontSizeOf(heading)).toBe('18px')
    // 配方不止字号：字重与文字色也算一档（body 文字色即 --mcs-text-default）
    const bodyColor = await styleOf(page.locator('body'), 'color')
    expect(await styleOf(heading, 'font-weight')).toBe('600')
    expect(await styleOf(heading, 'color')).toBe(bodyColor)
    // 数据卡标签必须弱于同卡数值：字重更轻、文字色走 muted 而非正文档
    expect(await styleOf(label, 'font-weight')).toBe('500')
    expect(await styleOf(label, 'color')).not.toBe(bodyColor)
    // 关键数字走数字档 display（30px），单位/后缀留在小档
    expect(await fontSizeOf(page.getByText('20.0'))).toBe('30px')
    expect(await fontSizeOf(page.getByText('2h 0m'))).toBe('30px')
    expect(await fontSizeOf(page.getByText('TPS', { exact: true }))).toBe('18px')
  })

  test('最近备份卡：渲染备份行 + 旧格式徽章，「全部」跳转设置页备份子路由', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/dashboard')
    // 精确匹配（非子串）：夹具名一旦重新内嵌日期，这里必须变红
    await expect(page.getByText('手动备份', { exact: true })).toBeVisible()
    await expect(page.getByText('旧格式压缩包', { exact: true })).toBeVisible()
    await expect(page.getByText('旧格式', { exact: true })).toBeVisible()
    // 入口必须落在真实子路由 /settings/backup（历史上曾指向不存在的 /settings/backups）
    await page.getByRole('button', { name: '查看全部备份' }).click()
    await expect(page).toHaveURL(/\/settings\/backup$/)
    await expect(page.getByText('备份管理').first()).toBeVisible()
  })

  test('MC 时钟·世界控制：天气/时间按钮点击即发命令', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/dashboard')
    // 天气/时间是互斥单选组（role=radio + aria-checked），非按钮
    await expect(page.getByRole('radio', { name: '晴天' })).toHaveAttribute('aria-checked', 'true')
    // 成功反馈已静默（终端回显为反馈源），以命令请求实际发出为断言信号
    const rainReq = page.waitForRequest(
      (r) => r.url().includes('/command') && String(r.postDataJSON()?.command).includes('weather rain'),
    )
    await page.getByRole('radio', { name: '雨天' }).click()
    await rainReq
    await expect(page.getByRole('radio', { name: '雨天' })).toHaveAttribute('aria-checked', 'true')
    const nightReq = page.waitForRequest(
      (r) => r.url().includes('/command') && String(r.postDataJSON()?.command).includes('time set night'),
    )
    await page.getByRole('radio', { name: '夜晚' }).click()
    await nightReq
    await expect(page.getByRole('radio', { name: '夜晚' })).toHaveAttribute('aria-checked', 'true')
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

  test('系统资源查询失败：横幅可见，重试后恢复（真实终端子树下的失败渲染路径）', async ({ page }) => {
    await setupConnection(page)
    // 拦截优先于代理：让 /system-stats 先 500，再放行真实 mock 后端
    let failing = true
    await page.route('**/api/v1/system-stats', (route) => {
      if (!failing) return route.continue()
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'error',
          code: 50000,
          message: 'Internal error',
          data: null,
          timestamp: new Date().toISOString(),
        }),
      })
    })
    await page.goto('/dashboard')

    // 出口可见且点名失败来源（此前该失败完全静默，资源卡只会停在「暂无数据」）
    await expect(page.getByText('系统资源获取失败')).toBeVisible()
    await expect(page.getByText('服务器状态获取失败')).toHaveCount(0)

    failing = false
    await page.getByRole('button', { name: '重试' }).click()
    await expect(page.getByText(/获取失败/)).toHaveCount(0)
    // 正向断言：资源行真的回填了数据（只看横幅消失，别的渲染分支调整也能蒙对）
    await expect(page.getByText('暂无数据', { exact: true })).toHaveCount(0)
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
