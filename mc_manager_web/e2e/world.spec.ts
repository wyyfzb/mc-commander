import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'

/**
 * 世界页 E2E（数据源：scripts/mock-server.mjs，世界/属性数据为结构占位虚构内容）
 * 验收：左栏世界信息卡+维度卡 / 属性 Tab 编辑保存 / gamerule Tab 查询+行级编辑 / 视觉截图
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

test.describe('世界页', () => {
  test('左栏世界信息卡 + 维度卡渲染', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/world')
    // 世界信息卡：名称/种子/天数
    await expect(page.getByRole('heading', { name: '世界信息' })).toBeVisible()
    // 手写 h3 与 mcs/card 基座 heading 必须同配方（18px / w600 / text-default），
    // 否则「同一个 lg 档」存在两套观感，后续迁入基座就不再是零视觉变化
    const infoTitle = page.getByRole('heading', { name: '世界信息' })
    const infoStyle = (prop: string) =>
      infoTitle.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop)
    expect(await infoStyle('font-size')).toBe('18px')
    expect(await infoStyle('font-weight')).toBe('600')
    expect(await infoStyle('color')).toBe(
      await page.locator('body').evaluate((el) => getComputedStyle(el).color),
    )
    await expect(page.getByText('演示世界')).toBeVisible()
    await expect(page.getByText('887654321')).toBeVisible()
    await expect(page.getByText('42 天')).toBeVisible()
    // 难度/游戏模式 PillBadge（normal → 普通；survival → 生存）
    await expect(page.getByText('普通')).toBeVisible()
    await expect(page.getByText('生存', { exact: true })).toBeVisible()
    // 维度卡 3 张
    for (const name of ['主世界', '下界', '末地']) {
      await expect(page.getByText(name)).toBeVisible()
    }
    await maybeShot(page, 'world-info-dark.png')
  })

  /**
   * 主从分栏阈值为容器档 @3xl=768px（左栏 320 + 列距 16 + 右栏最小 432）。
   * jsdom 不评估容器查询，阈值只能在这里锁。两条各锁一头：
   * - 1023 视口展开侧栏内容 784px：改前差 1px 未达 lg 仍上下堆叠，现在必须分栏
   * - 900 视口展开侧栏内容 660px：分栏会把右栏压到 324px，必须继续堆叠
   */
  test('主从分栏按容器宽切档：1023 视口分栏、900 视口堆叠', async ({ page }) => {
    await setupConnection(page)

    // 分栏：左栏与右栏同一行（left 相差 >10px 且 top 对齐）
    await page.setViewportSize({ width: 1023, height: 900 })
    await page.goto('/world')
    await expect(page.getByRole('heading', { name: '世界信息' })).toBeVisible()
    const split = await page.evaluate(() => {
      const left = document.querySelector('main .overflow-y-auto')!
      const right = document.querySelector('main .flex.min-h-0.min-w-0')!
      const l = left.getBoundingClientRect()
      const r = right.getBoundingClientRect()
      return {
        sameRow: Math.abs(l.top - r.top) < 4,
        rightOfLeft: r.left > l.left + 10,
        leftW: l.width,
      }
    })
    expect(split.sameRow).toBe(true)
    expect(split.rightOfLeft).toBe(true)
    expect(split.leftW).toBe(320)

    // 堆叠：右栏落到左栏下方
    await page.setViewportSize({ width: 900, height: 900 })
    await expect(page.getByRole('heading', { name: '世界信息' })).toBeVisible()
    const stacked = await page.evaluate(() => {
      const left = document.querySelector('main .overflow-y-auto')!
      const right = document.querySelector('main .flex.min-h-0.min-w-0')!
      const l = left.getBoundingClientRect()
      const r = right.getBoundingClientRect()
      return { below: r.top >= l.bottom - 1, fullWidth: Math.abs(r.width - l.width) < 2 }
    })
    expect(stacked.below).toBe(true)
    expect(stacked.fullWidth).toBe(true)

    // 两态都不得横向溢出
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBe(0)
  })

  test('属性 Tab：默认渲染 + 编辑保存流程', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/world')
    // 默认属性 Tab：motd 键（mono）与占位值可见；敏感键锁定占位
    await expect(page.getByText('motd', { exact: true })).toBeVisible()
    // motd 为 Input 控件（值在 value 属性，非文本节点）
    await expect(page.getByLabel('MOTD 输入')).toHaveValue('E2E 演示服务器')
    await expect(page.getByText('********').first()).toBeVisible()
    // 进入编辑 → 提示条出现
    await page.getByRole('button', { name: '编辑' }).click()
    await expect(
      page.getByText('编辑模式已开启 — 你可以修改服务器属性，完成后点击「保存」或「取消」'),
    ).toBeVisible()
    // 切 pvp 开关并保存 → PUT /properties（mock 返回 restartRequired: []）
    await page.getByRole('switch', { name: 'PvP 开关' }).click()
    await page.getByRole('button', { name: '保存' }).click()
    await expect(page.getByText('规则已保存到服务器')).toBeVisible()
    await maybeShot(page, 'world-properties-dark.png')
  })

  test('游戏规则 Tab：查询渲染 + 行级编辑保存', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/world')
    await page.getByRole('tab', { name: '游戏规则' }).click()
    // URL 深链接（设计文档 §3.3）：Tab 状态写入 ?tab=
    await expect(page).toHaveURL(/tab=gamerule/)
    // 版本徽章（mcVersion 1.21.4 → 旧版规则集）
    await expect(page.getByText('旧版规则')).toBeVisible()
    // 查询返回 20 条规则解析成功（≥1/3 阈值）；首行与已查到值的规则可见
    await expect(page.getByText('allowEnteringNetherUsingPortals')).toBeVisible()
    await expect(page.getByText('doMobSpawning')).toBeVisible()
    // 行级编辑：切首行 switch（true → false）→ 行尾保存 → 成功 toast
    await page.getByRole('switch', { name: 'allowEnteringNetherUsingPortals 开关' }).click()
    await page.getByRole('button', { name: '保存' }).click()
    await expect(page.getByText('已更新规则 allowEnteringNetherUsingPortals = false')).toBeVisible()
    await maybeShot(page, 'world-gamerules-dark.png')
  })

  test('属性面板窄屏（375px）：键名与值上下堆叠，全部键名不再被裁', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await setupConnection(page)
    await page.goto('/world')
    await expect(page.getByRole('heading', { name: '世界信息' })).toBeVisible()

    const rows = page.locator('[data-prop]')
    // 属性清单来自 GET /properties，等首行落定再量（空集合会让下面两条断言空转）
    await expect(rows.first()).toBeVisible()
    const rowCount = await rows.count()
    expect(rowCount).toBeGreaterThan(0)

    // xs（30rem=480px）以下改为纵向堆叠：行内 176px 固定值列会把长键名裁到 2-3 字可见
    const directions = await rows.evaluateAll((els) =>
      els.map((el) => getComputedStyle(el).flexDirection),
    )
    expect(new Set(directions)).toEqual(new Set(['column']))

    // 堆叠后键名拿到整行宽度：逐行量「截断溢出量」，任何一行 > 0 都算回归
    const overflow = await rows.evaluateAll((els) =>
      els.map((row) => {
        const name = row.querySelector('[data-prop-name]')
        return name ? name.scrollWidth - name.clientWidth : -1
      }),
    )
    expect(overflow.filter((n) => n !== 0)).toEqual([])
    // 页面级不横向溢出（堆叠不能把内容撑破视口）
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
    expect(scrollWidth).toBeLessThanOrEqual(375)
    await maybeShot(page, 'world-properties-375.png')
  })
})
