import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'

/**
 * 冒烟 E2E（基本可跑 / Cmd+K 可跳转 / 主题切换）
 */

// 可选截图（调试用）：设 E2E_SHOT=1 时输出到 test-results/shots/，默认关闭
const SHOT_DIR = path.join(process.cwd(), 'test-results', 'shots')
function maybeShot(page: Page, name: string) {
  return process.env.E2E_SHOT ? page.screenshot({ path: path.join(SHOT_DIR, name) }) : undefined
}

/** 注入连接配置（无配置会重定向 /onboarding）——mock 假 key，严禁真实服务器信息 */
async function setupConnection(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'mcs-connection',
      JSON.stringify({ baseUrl: '', apiKey: 'e2e-mock-key-0000000000' }),
    )
  })
}

test.describe('冒烟', () => {
  test('页面加载：品牌、侧栏、顶栏元素可见', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/')
    // index 路由重定向到 /dashboard
    await expect(page).toHaveURL(/\/dashboard/)
    await expect(page.getByText('MC Commander').first()).toBeVisible()
    for (const label of ['仪表盘', '玩家', '世界', '文件', '任务', '实例', '设置']) {
      await expect(page.getByRole('link', { name: new RegExp(label) })).toBeVisible()
    }
    await expect(page.getByRole('button', { name: /搜索或执行命令/ })).toBeVisible()
    // 顶栏实例标识（mock 无 WS，状态点文案动态不稳，用实例名断言）。
    // mock 的实例列表恰好一个 ⇒ 选择器降级为纯展示：实例名不该挂在可点的按钮上
    // （mock 若增到多实例，这里会红——那正是「该恢复下拉」的信号，不是脆断言）
    await expect(page.getByText('E2E 演示实例').first()).toBeVisible()
    await expect(page.getByRole('button', { name: 'E2E 演示实例' })).toHaveCount(0)
  })

  test('导航跳转：点击侧栏玩家进入占位页', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/')
    await page.getByRole('link', { name: /玩家/ }).click()
    await expect(page).toHaveURL(/\/players/)
    // 玩家页：搜索框可见
    await expect(page.getByPlaceholder('搜索玩家名或 UUID…')).toBeVisible()
  })

  test('Cmd+K：打开命令面板并跳转页面', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/')
    // lazy chunk 首次编译期间键盘事件可能被吞：先等页面就绪再按键
    await expect(page.getByText('E2E 演示实例').first()).toBeVisible()
    await page.keyboard.press('Control+k')
    await expect(page.getByPlaceholder('输入页面名称或命令…')).toBeVisible()
    await page.getByRole('option', { name: /世界/ }).click()
    await expect(page).toHaveURL(/\/world/)
  })

  test('主题切换：dark ↔ light 同步 html class', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/')
    await expect(page.locator('html')).toHaveClass(/dark/)
    await page.getByRole('button', { name: /切换到亮色主题/ }).click()
    await expect(page.locator('html')).toHaveClass(/light/)
  })

  test('视觉截图：暗色仪表盘 / 命令面板 / 亮色仪表盘', async ({ page }) => {
    await setupConnection(page)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    // 就绪门：networkidle 只代表网络静默，不保证 React 已挂载——Ctrl+K 若早于
    // CommandPalette 注册 window keydown 监听就会丢键（空按），并行 worker 冷启动下偶发
    await expect(page.locator('#main-content')).toBeVisible({ timeout: 30_000 })
    await maybeShot(page, 'dashboard-dark.png')

    // 可重试的按键：Ctrl+K 是**切换**语义，丢键（早于监听注册）时重按即开——用 toPass
    // 与「监听何时注册」解耦，不再依赖某个前置可见信号恰好覆盖它
    await expect(async () => {
      await page.keyboard.press('Control+k')
      await expect(page.getByPlaceholder('输入页面名称或命令…')).toBeVisible({ timeout: 3_000 })
    }).toPass()
    await maybeShot(page, 'command-palette-dark.png')
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: /切换到亮色主题/ }).click()
    await expect(page.locator('html')).toHaveClass(/light/)
    await maybeShot(page, 'dashboard-light.png')

    // 亮色命令面板 + 键盘选中态（设计审查必须修项复审：选中态可见性）
    await page.keyboard.press('Control+k')
    await expect(page.getByPlaceholder('输入页面名称或命令…')).toBeVisible()
    await page.keyboard.press('ArrowDown') // 从默认首项移到第二项，验证选中态可见
    await maybeShot(page, 'command-palette-light.png')
  })
})
