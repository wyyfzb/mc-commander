import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'

/**
 * 审计页 E2E（数据源：scripts/mock-server.mjs，审计/命令历史为虚构占位数据）
 * 验收：Tab 切换 / 筛选栏渲染 / 日期键入与日历双模（打开月历 → 选日 → 回填） / 视觉截图
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

/** 本地日历日 yyyy-MM-dd（与服务端筛选口径无关，仅用于断言输入框回填） */
function todayIso(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

test.describe('审计页', () => {
  test('页面渲染：标题 + 双 Tab + 筛选栏（快捷区间 / 日期输入 / 日历入口）', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/audit')

    await expect(page.getByRole('heading', { name: '审计' })).toBeVisible()
    await expect(page.getByRole('tab', { name: '审计日志' })).toBeVisible()
    await expect(page.getByRole('tab', { name: '命令历史' })).toBeVisible()

    for (const quick of ['今天', '近 7 天', '近 30 天']) {
      await expect(page.getByRole('radio', { name: quick })).toBeVisible()
    }
    await expect(page.getByLabel('开始日期')).toBeVisible()
    await expect(page.getByLabel('结束日期')).toBeVisible()
    await expect(page.getByRole('button', { name: '打开日历' })).toHaveCount(2)

    await maybeShot(page, 'audit-list.png')
  })

  test('快捷区间是单选组：方向键移动即选中，组内恒单一 Tab 停靠点', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/audit')

    const group = page.getByRole('radiogroup', { name: '快捷时间范围' })
    const today = group.getByRole('radio', { name: '今天' })
    const week = group.getByRole('radio', { name: '近 7 天' })
    // 初始无筛选（可清空 → 无选中是合法态）：停靠点落首项但不谎报选中
    await expect(today).toHaveAttribute('aria-checked', 'false')
    await expect(today).toHaveAttribute('tabindex', '0')
    await expect(week).toHaveAttribute('tabindex', '-1')

    await today.focus()
    // 无选中态：首次方向键落在首项本身（再按一次才到第 2 项）
    await page.keyboard.press('ArrowRight')
    await expect(today).toHaveAttribute('aria-checked', 'true')
    await expect(today).toBeFocused()

    await page.keyboard.press('ArrowRight')
    await expect(week).toHaveAttribute('aria-checked', 'true')
    await expect(week).toBeFocused()
    // roving tabindex 随选中项迁移（真实浏览器的 Tab 跳过行为 jsdom 验不了）
    await expect(week).toHaveAttribute('tabindex', '0')
    await expect(today).toHaveAttribute('tabindex', '-1')
    await expect(group.locator('[tabindex="0"]')).toHaveCount(1)
    // Tab 不被吞：从选中项按一次 Tab 直接离开整组（否则键盘用户被困在组里）
    await page.keyboard.press('Tab')
    await expect(group.locator(':focus')).toHaveCount(0)
    await expect(page.getByLabel('开始日期')).not.toHaveValue('')
  })

  test('日历弹层：打开月历 → 选今天 → 回填开始日期并收起', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/audit')

    const start = page.getByLabel('开始日期')
    await expect(start).toHaveValue('')

    await page.getByRole('button', { name: '打开日历' }).first().click()
    // 弹层内查询：筛选栏的快捷区间也有「今天」选项，必须按弹层作用域定位
    const popover = page.locator('[data-slot="popover-content"]')
    const grid = popover.getByRole('grid')
    await expect(grid).toBeVisible()
    await expect(popover.getByText(/\d{4} 年 \d{1,2} 月/)).toBeVisible()

    // 今天按钮位于日历底部：选择今天后弹层收起、输入框回填 ISO 日期
    await popover.getByRole('button', { name: '今天', exact: true }).click()
    await expect(start).toHaveValue(todayIso())
    await expect(grid).toHaveCount(0)

    await maybeShot(page, 'audit-date-picked.png')
  })

  test('日历弹层：键盘可达（方向键移动焦点 + Enter 选择）', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/audit')

    const end = page.getByLabel('结束日期')
    await page.getByRole('button', { name: '打开日历' }).nth(1).click()
    const grid = page.locator('[data-slot="popover-content"]').getByRole('grid')
    await expect(grid).toBeVisible()

    // 打开时焦点落在今天；右移一天后 Enter 选中
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Enter')
    const d = new Date()
    d.setDate(d.getDate() + 1)
    const p = (n: number) => String(n).padStart(2, '0')
    const expected = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    await expect(end).toHaveValue(expected)
  })

  test('命令历史 Tab 同样具备日期日历入口', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/audit')
    await page.getByRole('tab', { name: '命令历史' }).click()
    await expect(page.getByRole('button', { name: '打开日历' }).first()).toBeVisible()
  })

  test('视觉截图：筛选栏与日历弹层（暗色/亮色）', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await setupConnection(page)
    await page.goto('/audit')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(800)
    await maybeShot(page, 'audit-filter-dark.png')

    const popover = page.locator('[data-slot="popover-content"]')
    await page.getByRole('button', { name: '打开日历' }).first().click()
    await expect(popover.getByRole('grid')).toBeVisible()
    await page.waitForTimeout(300)
    await maybeShot(page, 'audit-calendar-dark.png')

    // 弹层外点击会关闭面板，切换主题后重新打开再截亮色
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: /切换到亮色主题/ }).click()
    await expect(page.locator('html')).toHaveClass(/light/)
    await page.waitForTimeout(300)
    await maybeShot(page, 'audit-filter-light.png')
    await page.getByRole('button', { name: '打开日历' }).first().click()
    await expect(popover.getByRole('grid')).toBeVisible()
    await page.waitForTimeout(300)
    await maybeShot(page, 'audit-calendar-light.png')

    // 亮色激活态：选日回填后截图（此前「激活态仅暗色有图」的审查盲区）
    await popover.getByRole('button', { name: '今天', exact: true }).click()
    await expect(page.getByLabel('开始日期')).not.toHaveValue('')
    await page.waitForTimeout(300)
    await maybeShot(page, 'audit-date-picked-light.png')

    // 筛选器激活态（亮色为 accent 边框对比度最差场景）：操作类型下拉选中一项
    await page.getByRole('combobox', { name: '操作类型' }).click()
    await page.getByRole('option', { name: '启动实例' }).click()
    await page.waitForTimeout(300)
    await maybeShot(page, 'audit-filter-active-light.png')

    // 同场景暗色
    await page.getByRole('button', { name: /切换到深色主题/ }).click()
    await expect(page.locator('html')).toHaveClass(/dark/)
    await page.waitForTimeout(300)
    await maybeShot(page, 'audit-filter-active-dark.png')
  })

  /**
   * 表格按内容收缩（两侧括号都要锁）：
   * - 上方：行少时壳不得吃满剩余高度（曾是 235px 内容装在 618px 壳里，370+px 空面板）
   * - 下方：行多时壳必须真的被约束住并出现滚动（收过头会把表格挤出视口、滚动条消失）
   * jsdom 量不到几何，故只能在 e2e 锁。
   */
  test('表格按内容收缩：行少时壳贴合内容，行多时被约束在可用高度内且可滚动', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await setupConnection(page)
    await page.goto('/audit')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(600)

    const geometry = () =>
      page.evaluate(() => {
        const tbl = document.querySelector('main table')
        const shell = tbl?.parentElement as HTMLElement | null
        const main = document.querySelector('main')
        if (!shell || !main) return null
        const sr = shell.getBoundingClientRect()
        const tr = tbl!.getBoundingClientRect()
        return {
          shellH: Math.round(sr.height),
          contentH: Math.round(tr.height),
          mainH: Math.round(main.getBoundingClientRect().height),
          shellFitsMain: Math.round(main.getBoundingClientRect().bottom - sr.bottom),
          scrollable: shell.scrollHeight > shell.clientHeight,
          clientH: shell.clientHeight,
        }
      })

    // 上方括号：壳贴合内容（差值 ≤ 数像素的圆角/边框），且明显短于可用高度
    const small = await geometry()
    expect(small).not.toBeNull()
    expect(small!.shellH - small!.contentH).toBeLessThanOrEqual(8)
    expect(small!.shellH).toBeLessThan(small!.mainH - 100)

    // 下方括号：把行数放大到远超一屏，壳必须保持「在可用高度内」且出现滚动
    // 响应信封是 `data` 扁平数组 + 兄弟 `pagination`（见 scripts/mock-server.mjs）
    await page.route('**/api/v1/audit-logs*', async (route) => {
      const response = await route.fetch()
      const body = await response.json()
      const src: unknown[] = Array.isArray(body.data) ? body.data : []
      const one = src[0]
      if (!one) return route.fulfill({ response })
      const many = Array.from({ length: 80 }, (_, i) => ({ ...one, id: `e2e-row-${i}` }))
      await route.fulfill({
        response,
        json: {
          ...body,
          data: many,
          pagination: { total: many.length, page: 1, pageSize: 20, totalPages: 4 },
        },
      })
    })
    await page.reload()
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(800)

    const many = await geometry()
    expect(many).not.toBeNull()
    // 不被挤出视口：壳底边仍在 main 之内（允许 1px 舍入）
    expect(many!.shellFitsMain).toBeGreaterThanOrEqual(-1)
    // 且真的出现滚动——收缩不能收成「截断」
    expect(many!.scrollable).toBe(true)
  })

  /**
   * 短视口下壳不得溢出 flex 父级（下限必须可退让）。
   *
   * 缺口由来：收缩用的下限先写成固定 `min-h-40`，在可用高不足 160px 时不肯退让 ⇒
   * 卡片溢出父级、盖住其后的兄弟节点。玩家页实测「显示全部列」开关在 667x375 与
   * 812x375 由可点变**点击超时**。审计页的分页器在壳根内部（被一并推下去），只表现为
   * 「多余滚动」，故这里断 overflow 而非断点击——玩家页的点击形态由
   * `players.spec.ts` 的横屏用例覆盖（同一默认类，两处同改）。
   * jsdom 量不到几何，只能在 e2e 锁。
   */
  test('短视口（手机横屏 667x375 / 矮窗 1440x400）：壳不溢出父级', async ({ page }) => {
    await setupConnection(page)
    for (const vp of [
      { width: 667, height: 375 },
      { width: 1440, height: 400 },
    ]) {
      await page.setViewportSize(vp)
      await page.goto('/audit')
      await page.waitForLoadState('networkidle')
      await page.waitForTimeout(500)
      const overflow = await page.evaluate(() => {
        const tbl = document.querySelector('main table')
        const card = tbl?.parentElement as HTMLElement | null
        const root = card?.parentElement as HTMLElement | null
        if (!card || !root) return null
        return Math.round(card.getBoundingClientRect().bottom - root.getBoundingClientRect().bottom)
      })
      expect(overflow, `${vp.width}x${vp.height} 壳溢出父级`).not.toBeNull()
      // 允许 1px 舍入：溢出超过这个值即说明下限不肯退让
      expect(overflow!, `${vp.width}x${vp.height}`).toBeLessThanOrEqual(1)
    }
  })
})
