import { test, expect, type Page } from '@playwright/test'

/**
 * 移动端 E2E（viewport 375×812）
 * 验收：侧栏抽屉（汉堡开关/导航关闭）/ 顶栏搜索按钮窄屏可访问名 / 桌面端响应式回归
 */

/** 注入连接配置（mock 假 key，mock server 不校验）——严禁真实服务器信息 */
async function setupConnection(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'mcs-connection',
      JSON.stringify({ baseUrl: '', apiKey: 'e2e-mock-key-0000000000' }),
    )
  })
}

test.describe('移动端侧栏抽屉', () => {
  test.use({ viewport: { width: 375, height: 812 } })

  test('汉堡按钮打开抽屉 → 点击导航项跳转并关闭', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/dashboard')
    // 桌面折叠按钮隐藏（md 断点），汉堡可见
    await expect(page.getByRole('button', { name: '打开导航菜单' })).toBeVisible()
    await page.getByRole('button', { name: '打开导航菜单' }).click()
    await expect(page.getByRole('complementary', { name: '主导航（移动端）' })).toBeVisible()
    await page.getByRole('link', { name: '玩家' }).click()
    await expect(page).toHaveURL(/\/players/)
    // 导航后抽屉关闭
    await expect(page.getByRole('complementary', { name: '主导航（移动端）' })).toBeHidden()
  })

  test('遮罩点击关闭抽屉', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/dashboard')
    await page.getByRole('button', { name: '打开导航菜单' }).click()
    await page.mouse.click(360, 400)
    await expect(page.getByRole('complementary', { name: '主导航（移动端）' })).toBeHidden()
  })

  test('顶栏搜索按钮在窄屏仍有可访问名（文案与 kbd 均被 xs 断点隐藏）', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/dashboard')
    // <480px 时「搜索或执行命令…」与 Ctrl K 徽标都 display:none，
    // 图标 aria-hidden → 没有 aria-label 就是无名按钮
    await expect(page.getByRole('button', { name: '搜索或执行命令', exact: true })).toBeVisible()
  })
})

test.describe('桌面端回归（B1 响应式不改桌面）', () => {
  test('桌面端侧栏常显 + 无汉堡按钮', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/dashboard')
    await expect(page.getByRole('complementary', { name: '主导航' })).toBeVisible()
    await expect(page.getByRole('button', { name: '打开导航菜单' })).toBeHidden()
  })
})
