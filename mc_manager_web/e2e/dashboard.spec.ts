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

  test('最近备份卡：渲染备份行与状态徽章，「全部」跳转设置页备份子路由', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/dashboard')
    // 精确匹配（非子串）：夹具名一旦重新内嵌日期，这里必须变红
    await expect(page.getByText('手动备份', { exact: true })).toBeVisible()
    await expect(page.getByText('失败的备份', { exact: true })).toBeVisible()
    await expect(page.getByText('已就绪', { exact: true })).toBeVisible()
    await expect(page.getByText('失败', { exact: true })).toBeVisible()
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
    // 就绪门（冷启动竞态）：命令发送要求「实例已选中 + 运行中」，两者未就绪时
    // use-send-command 的守卫会静默丢弃（无 toast 无请求），表现为「等不到 /command」超时。
    // 顶栏出现实例名即 instanceId 已落定（单实例降级分支要求 list[0].id === instanceId），
    // 输入框可用即 isRunning 为真
    await expect(input).toBeEnabled({ timeout: 10_000 })
    await expect(page.getByRole('banner').getByText('E2E 演示实例').first()).toBeVisible()
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
    // 就绪门：输入框在实例运行态就绪前是 disabled，冷启动下直接 fill 会
    // 一直等到用例超时（实测 30s 仍 disabled），先等可用再操作
    await expect(input).toBeEnabled({ timeout: 15_000 })
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

  test('通知抽屉：带实例的条目把实例色相点放在独立左列，不与 info 文字同排', async ({ page }) => {
    await setupConnection(page)
    // 预置一条带 instanceId 的通知（store 从 localStorage 恢复；数据全虚构）
    await page.addInitScript(() => {
      localStorage.setItem(
        'mcs-notifications',
        JSON.stringify([
          {
            id: 'e2e-n-1',
            type: 'serverCrash',
            category: 'server',
            content: 'E2E 虚构通知：服务器意外退出',
            timestamp: Date.now(),
            count: 1,
            read: false,
            instanceId: 'e2e-demo',
          },
        ]),
      )
    })
    await page.goto('/dashboard')
    await page.getByRole('button', { name: /通知/ }).click()
    await expect(page.getByRole('heading', { name: '通知' })).toBeVisible()
    // 等字体就位再量几何：字体回退会让字形盒宽窄变化，几何断言会抖（0.x px 级）
    await page.evaluate(() => document.fonts.ready)
    const entry = page.getByRole('button', { name: /E2E 虚构通知/ })
    await expect(entry).toBeVisible()
    const dot = entry.locator('[data-instance-hue]')
    // 字面量槽位：e2e-demo → slot 2（与顶栏/实例卡同源）
    await expect(dot).toHaveClass(/bg-mcs-identity-2/)
    // 色点必须在独立左列，不在「查看实例」那一行内（那行整体是 info 语义色）
    await expect(entry.getByText('查看实例').locator('[data-instance-hue]')).toHaveCount(0)
    // 几何证据：① 色点在气泡内、贴左缘；② 色点整体位于 info 行**上方**（不同排）。
    // 左缘上界只是**粗检**：实测色点偏移在本机 13px、并行负载下 20px（字体度量漂移），
    // 而真实回归形态量到的是 13–29px——别指望这个上界兜回归，承载语义的是下面
    // 「info 行内不得有色点」（count 断言）与「色点底线在 info 行顶线之上」（y 带）两条。
    // 上界贴着实测值（曾写 <20）只会把亚像素抖动判成失败
    const LEFT_COLUMN_MAX_OFFSET_PX = 32
    const dotBox = (await dot.boundingBox())!
    const entryBox = (await entry.boundingBox())!
    const hintBox = (await entry.getByText('查看实例').boundingBox())!
    expect(dotBox.x).toBeGreaterThanOrEqual(entryBox.x)
    expect(dotBox.x - entryBox.x).toBeLessThan(LEFT_COLUMN_MAX_OFFSET_PX)
    expect(dotBox.y + dotBox.height).toBeLessThanOrEqual(hintBox.y)
    await maybeShot(page, 'notification-drawer-instance-dark.png')
    // 亮色下同一槽位（审查点：slot5/slot2 在亮色里最贴近语义色）
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: /切换到亮色主题/ }).click()
    await page.getByRole('button', { name: /通知/ }).click()
    await expect(entry.locator('[data-instance-hue]')).toHaveClass(/bg-mcs-identity-2/)
    await maybeShot(page, 'notification-drawer-instance-light.png')
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
