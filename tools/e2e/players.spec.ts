import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'

/**
 * 玩家页 E2E（数据源：同目录 mock-server.mjs，玩家数据为结构占位虚构名）
 * 验收：表格渲染 / 搜索筛选 / 详情面板 / 行内操作 / 给予对话框命令预览 / 批量操作 / 深链接 / 视觉截图
 */

// 可选截图（调试用）：设 E2E_SHOT=1 时输出到 test-results/shots/，默认关闭
const SHOT_DIR = path.join(import.meta.dirname, 'test-results', 'shots')
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

test.describe('玩家页', () => {
  test('玩家列表渲染：在线优先排序 + 徽章 + 封禁标记', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/players')
    // 5 名占位玩家全部可见
    for (const name of ['Steve', 'Alex', 'Bob', 'Charlie', 'Bot_farm1']) {
      await expect(page.getByText(name).first()).toBeVisible()
    }
    // 封禁徽章（Charlie 临时封禁剩 1 天）
    await expect(page.getByText(/封禁·剩/)).toBeVisible()
    // 白名单徽章（Bob）
    await expect(page.getByText('白名单').first()).toBeVisible()
    // 筛选栏与计数
    await expect(page.getByPlaceholder('搜索玩家名或 UUID…')).toBeVisible()
    await expect(page.getByText('5 / 5 名玩家')).toBeVisible()
    await maybeShot(page, 'players-table-dark.png')
  })

  test('搜索筛选：名字过滤 + 计数联动 + 无匹配空态', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/players')
    const search = page.getByPlaceholder('搜索玩家名或 UUID…')
    await search.fill('charlie')
    await expect(page.getByText('1 / 5 名玩家')).toBeVisible()
    await expect(page.getByText('Steve').first()).toBeHidden()
    await search.fill('zzz-not-exist')
    await expect(page.getByText('没有匹配的玩家')).toBeVisible()
    // 重置按钮恢复
    await page.getByRole('button', { name: '重置' }).click()
    await expect(page.getByText('5 / 5 名玩家')).toBeVisible()
  })

  test('点击行打开详情弹窗：概览操作组 + 基本信息 + ‹ › 换人 + 关闭', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/players')
    await page.getByText('Steve').first().click()
    const dialog = page.getByRole('dialog', { name: /Steve 详情/ })
    await expect(dialog).toBeVisible()
    // 概览 Tab：OP 操作按钮（Steve 是 OP → 取消 OP）+ 基本信息
    await expect(page.getByRole('button', { name: /取消 OP/ })).toBeVisible()
    await expect(page.getByText('基本信息')).toBeVisible()
    await expect(page.getByRole('heading', { name: '封禁记录' })).toBeVisible()
    // ‹ › 换人：按表格排序换到下一位，仍是同一个弹窗
    await page.getByRole('button', { name: '下一个玩家' }).click()
    await expect(page.getByRole('dialog', { name: /Alex 详情/ })).toBeVisible()
    // 关闭面板
    await page.getByRole('button', { name: '关闭详情面板' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByText('基本信息')).toBeHidden()
    await maybeShot(page, 'detail-overview-dark.png')
  })

  test('行内菜单：踢出直执（无逆操作 → 不弹确认，直接下发 + 回执）', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/players')
    await page.getByRole('button', { name: 'Steve 操作菜单' }).click()
    await page.getByText('踢出').click()
    // 口径：只有不可逆操作才走后果清单确认；踢出无逆操作 → 直执
    await expect(page.getByRole('heading', { name: '确认踢出' })).toHaveCount(0)
    await expect(page.getByText('已成功踢出 1 名玩家')).toBeVisible({ timeout: 10_000 })
  })

  test('行内菜单：OP 切换直执 + 5s 撤销（可逆操作不留确认弹窗）', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/players')
    await page.getByRole('button', { name: 'Alex 操作菜单' }).click()
    await page.getByRole('menuitem', { name: '设为 OP' }).click()
    await expect(page.getByRole('heading', { name: '确认设为 OP' })).toHaveCount(0)
    await expect(page.getByText('已设置 Alex 为 OP')).toBeVisible({ timeout: 10_000 })
    // 撤销入口在回执上（5s 窗口），点击后下发逆操作并回执
    await page.getByRole('button', { name: '撤销' }).click()
    await expect(page.getByText('已取消 Alex 的 OP')).toBeVisible({ timeout: 10_000 })
  })

  /**
   * 目录按实例 mcVersion（mock 为 1.21.4）过滤：26.x 物品不进货架，搜索也只给出版本原因。
   * 这条锁的是「面板知道版本就替用户判掉」，而不是把判断留到点击后的 toast。
   */
  test('给予目录按实例版本过滤：1.21.4 下 26.x 物品不出现、搜索给出版本原因', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/players')
    await page.getByText('Steve').first().click()
    await page.getByRole('tab', { name: '给予物品' }).click()
    await expect(page.getByTestId('item-cell-diamond')).toBeVisible()
    await expect(page.getByTestId('item-cell-sulfur')).toHaveCount(0)
    await expect(page.getByTestId('item-cell-golden_dandelion')).toHaveCount(0)
    // 结果行说明被版本挡掉的件数（不是静默少 20 件）
    await expect(page.getByText(/件（\d+ 件需更高版本）/)).toBeVisible()
    // 搜索 26.x 物品名：空态说明原因，而不是「没有找到匹配的物品」
    await page.getByPlaceholder(/搜索物品/).fill('硫磺')
    await expect(page.getByText('该版本没有匹配的物品')).toBeVisible()
    await expect(page.getByText(/需要比 MC 1\.21\.4 更新的版本/)).toBeVisible()
  })

  test('给予物品：选择物品 → 清单行 + 命令预览实时生成（NBT 1.21.4 直接映射）', async ({
    page,
  }) => {
    await setupConnection(page)
    await page.goto('/players')
    await page.getByText('Steve').first().click()
    await page.getByRole('tab', { name: '给予物品' }).click()
    // 搜索钻石剑 → 点目录格子
    await page.getByPlaceholder(/搜索物品/).fill('钻石剑')
    await page.getByTestId('item-cell-diamond_sword').click()
    // 清单出一行 + 命令预览（mock mcVersion 1.21.4）
    await expect(page.getByTestId('give-line-diamond_sword')).toBeVisible()
    await expect(page.getByTestId('give-command-preview')).toHaveText(
      /give Steve minecraft:diamond_sword 1/,
    )
    // 数量调整 +1 → 命令更新
    await page.getByRole('button', { name: '增加 钻石剑 数量' }).click()
    await expect(page.getByTestId('give-command-preview')).toHaveText(
      /give Steve minecraft:diamond_sword 2/,
    )
    // 行内附魔面板
    await page.getByRole('button', { name: '钻石剑 附魔设置' }).click()
    await expect(page.getByText('附魔 · 钻石剑')).toBeVisible()
    await expect(page.getByText('锋利')).toBeVisible()
    await maybeShot(page, 'give-dialog-dark.png')
  })

  /**
   * 给予工作台按**容器实宽**切形态（@container 在详情弹窗内容壳上）。
   * jsdom 不评估容器查询，阈值只能在这里锁：≥760px 双栏（目录 + 清单），<760px 清单收成
   * 底部抽屉 + 购物车条。两条各锁一头。
   */
  test('给予工作台按容器实宽切档：960 弹窗双栏、768 视口收成抽屉', async ({ page }) => {
    await setupConnection(page)

    // 1440 视口 ⇒ 详情弹窗 960px ⇒ 双栏：目录栅格 6 列（每格 ≥88px）
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/players')
    await page.getByText('Steve').first().click()
    await page.getByRole('tab', { name: '给予物品' }).click()
    const grid = page.getByTestId('give-item-grid')
    await expect(grid).toBeVisible()
    const wide = await grid.evaluate((el) => ({
      cols: getComputedStyle(el).gridTemplateColumns.split(' ').length,
      cellW: Math.round(el.firstElementChild!.getBoundingClientRect().width),
      panelW: Math.round(el.closest('[role="dialog"]')!.getBoundingClientRect().width),
    }))
    expect(wide.panelW).toBe(960)
    expect(wide.cols).toBe(6)
    expect(wide.cellW).toBeGreaterThanOrEqual(88)
    // 双栏：清单与目录同屏
    await expect(page.getByTestId('give-ticket')).toBeVisible()
    await expect(page.getByRole('button', { name: '查看清单' })).toHaveCount(0)

    // 768 视口 ⇒ 弹窗 736px（两侧各留 1rem）⇒ 清单收成底部抽屉
    await page.setViewportSize({ width: 768, height: 900 })
    await expect(page.getByRole('dialog', { name: /Steve 详情/ })).toBeVisible()
    await expect(page.getByTestId('give-ticket')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '查看清单' })).toBeVisible()
    // 抽屉未打开时清单行不在 DOM；打开后可见
    await page.getByTestId('item-cell-diamond_sword').click()
    await page.getByRole('button', { name: '查看清单' }).click()
    await expect(page.getByTestId('give-line-diamond_sword')).toBeVisible()
  })

  /**
   * Tab 条按**容器实宽**在「3 列网格（2 行）」与「单行 flex」之间切档，阈值 420px。
   * 弹窗宽随视口与滚动条变化，故不钉死某个视口，而是扫几档视口、按量到的容器宽
   * 两侧各取一头：<420 必两行、≥420 必单行。jsdom 不评估容器查询，只能在这里锁。
   */
  test('详情 Tab 条按弹窗实宽切档：<420 两行、≥420 单行', async ({ page }) => {
    await setupConnection(page)
    /** 行数 = 各 tab 顶边去重后的数量（折行时 3 列排成 2 行） */
    const measure = async () =>
      page.getByTestId('player-detail-shell').evaluate((el) => {
        const tabs = [...el.querySelectorAll('[role="tab"]')] as HTMLElement[]
        return {
          rows: new Set(tabs.map((t) => Math.round(t.getBoundingClientRect().top))).size,
          container: el.getBoundingClientRect().width,
        }
      })

    await page.setViewportSize({ width: 440, height: 900 })
    await page.goto('/players')
    await page.getByText('Steve').first().click()
    await expect(page.getByRole('tablist')).toBeVisible()

    const samples: Array<{ container: number; rows: number }> = []
    for (const width of [440, 448, 452, 456, 480]) {
      await page.setViewportSize({ width, height: 900 })
      await page.waitForTimeout(120)
      samples.push(await measure())
    }

    expect(samples.filter((s) => s.container < 420).every((s) => s.rows === 2)).toBe(true)
    expect(samples.filter((s) => s.container >= 420).every((s) => s.rows === 1)).toBe(true)
    // 两侧都取到样本，否则这条测试什么也没锁住
    expect(samples.some((s) => s.container < 420)).toBe(true)
    expect(samples.some((s) => s.container >= 420)).toBe(true)
  })

  test('批量选择：底部浮动操作条 + 批量传送走详情批量模式', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/players')
    await page.getByRole('checkbox', { name: '选择 Steve' }).check()
    await page.getByRole('checkbox', { name: '选择 Alex' }).check()
    await expect(page.getByText('已选择 2 名玩家')).toBeVisible()
    // 批量传送 → 详情批量模式（弹窗内隐藏概览等 Tab，仅传送/给予/操作）
    await page.getByRole('button', { name: '传送' }).click()
    const dialog = page.getByRole('dialog', { name: /批量操作 2 名玩家/ })
    await expect(dialog).toBeVisible()
    await expect(page.getByText('已选择 2 名玩家').first()).toBeVisible()
    await expect(page.getByRole('tab', { name: '概览' })).toHaveCount(0)
    await maybeShot(page, 'batch-bar-dark.png')
  })

  test('深链接：?player=Steve 直达详情弹窗', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/players?player=Steve')
    await expect(page.getByRole('dialog', { name: /Steve 详情/ })).toBeVisible()
    await expect(page.getByText('基本信息')).toBeVisible()
    // URL 含 player 参数
    expect(page.url()).toContain('player=Steve')
  })

  test('封禁记录弹窗：全量列表 + 解封确认', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/players')
    // 筛选栏入口打开弹窗
    await page.getByRole('button', { name: '封禁记录' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('Charlie')).toBeVisible()
    await expect(dialog.getByText('Ghost')).toBeVisible()
    // 生效中记录解封（确认 → 成功 toast）
    await dialog.getByRole('button', { name: '解封' }).click()
    await expect(page.getByText('确定要解封 Charlie 吗？解封后对方可重新连接。')).toBeVisible()
    await page.getByRole('button', { name: '确认解封' }).click()
    await expect(page.getByText('已解封 Charlie')).toBeVisible({ timeout: 10_000 })
  })

  test('视觉截图：玩家页暗色/亮色/详情/给予', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await setupConnection(page)
    await page.goto('/players')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(1000) // 等玩家数据渲染
    await maybeShot(page, 'players-full-dark.png')

    // 详情面板
    await page.getByText('Steve').first().click()
    await page.waitForTimeout(400)
    await maybeShot(page, 'detail-full-dark.png')

    // 给予 Tab
    await page.getByRole('tab', { name: '给予物品' }).click()
    await page.waitForTimeout(400)
    await maybeShot(page, 'give-full-dark.png')

    // 亮色主题（详情已改模态弹窗，背景 inert ⇒ 先关闭再切主题）
    await page.getByRole('button', { name: '关闭详情面板' }).click()
    await page.getByRole('button', { name: /切换到亮色主题/ }).click()
    await expect(page.locator('html')).toHaveClass(/light/)
    await maybeShot(page, 'players-full-light.png')
    await page.getByText('Steve').first().click()
    await page.waitForTimeout(300)
    await maybeShot(page, 'detail-full-light.png')
  })
})
