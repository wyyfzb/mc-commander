import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'

/**
 * 玩家页 E2E（数据源：scripts/mock-server.mjs，玩家数据为结构占位虚构名）
 * 验收：表格渲染 / 搜索筛选 / 详情面板 / 行内操作 / 给予对话框命令预览 / 批量操作 / 深链接 / 视觉截图
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

  test('点击行打开详情面板：概览操作组 + 基本信息 + 关闭', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/players')
    await page.getByText('Steve').first().click()
    // 概览 Tab：OP 操作按钮（Steve 是 OP → 取消OP）+ 基本信息
    await expect(page.getByRole('button', { name: /取消OP/ })).toBeVisible()
    await expect(page.getByText('基本信息')).toBeVisible()
    await expect(page.getByRole('heading', { name: '封禁记录' })).toBeVisible()
    // 关闭面板
    await page.getByRole('button', { name: '关闭详情面板' }).click()
    await expect(page.getByText('基本信息')).toBeHidden()
    await maybeShot(page, 'detail-overview-dark.png')
  })

  test('行内菜单：踢出直执（无逆操作 → 不弹确认，直接下发 + 回执）', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/players')
    await page.getByRole('button', { name: 'Steve 操作菜单' }).click()
    await page.getByText('踢出').click()
    // J15 口径：只有不可逆操作才走后果清单确认；踢出无逆操作 → 直执
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

  test('给予物品对话框：选择物品 → 命令预览实时生成（NBT 1.21.4 直接映射）', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/players')
    await page.getByText('Steve').first().click()
    await page.getByRole('tab', { name: '给予物品' }).click()
    // 搜索钻石剑
    await page.getByPlaceholder(/搜索物品/).fill('钻石剑')
    await page.getByText('diamond_sword').first().click()
    // 命令预览（mock mcVersion 1.21.4 → 直接映射格式）
    await expect(page.getByText(/give Steve minecraft:diamond_sword 1/)).toBeVisible()
    // 数量调整 +1 → 命令更新
    await page.getByRole('button', { name: '增加 钻石剑 数量' }).click()
    await expect(page.getByText(/give Steve minecraft:diamond_sword 2/)).toBeVisible()
    // 附魔面板
    await page.getByRole('button', { name: /附魔/ }).first().click()
    await expect(page.getByText('锋利')).toBeVisible()
    await maybeShot(page, 'give-dialog-dark.png')
  })

  test('批量选择：底部浮动操作条 + 批量传送走详情批量模式', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/players')
    await page.getByRole('checkbox', { name: '选择 Steve' }).check()
    await page.getByRole('checkbox', { name: '选择 Alex' }).check()
    await expect(page.getByText('已选择 2 名玩家')).toBeVisible()
    // 批量传送 → 详情批量模式（隐藏概览等 Tab，仅传送/给予）
    await page.getByRole('button', { name: '传送' }).click()
    await expect(page.getByText('已选择 2 名玩家').first()).toBeVisible()
    await expect(page.getByRole('tab', { name: '概览' })).toBeHidden()
    await maybeShot(page, 'batch-bar-dark.png')
  })

  test('深链接：?player=Steve 直达详情', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/players?player=Steve')
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

    // 亮色主题
    await page.getByRole('button', { name: /切换到亮色主题/ }).click()
    await expect(page.locator('html')).toHaveClass(/light/)
    await maybeShot(page, 'players-full-light.png')
    await page.getByRole('tab', { name: '概览' }).click()
    await page.waitForTimeout(300)
    await maybeShot(page, 'detail-full-light.png')
  })
})
