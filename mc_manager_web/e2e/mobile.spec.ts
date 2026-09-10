import { test, expect, type Page } from '@playwright/test'

/**
 * 移动端 E2E（viewport 375×812）
 * 验收：紧急视图（TPS 大字/4 按钮/底部 Tab/停止确认在线数）/ 侧栏抽屉（汉堡开关/导航关闭）
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

test.describe('移动端紧急视图', () => {
  test.use({ viewport: { width: 375, height: 812 } })

  test('紧急视图：TPS 大字 + 状态 chip + 四按钮 + 迷你终端', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/emergency')
    // 顶栏实例名 + 健康 chip
    await expect(page.getByText('E2E 演示实例')).toBeVisible()
    await expect(page.getByText('健康')).toBeVisible()
    // TPS 大字（mock 20.0）
    await expect(page.getByText('20.0')).toBeVisible()
    // 四按钮（玩家操作为导航，存档为处置黄金位动作）
    for (const label of ['重启', '停止', '存档', '玩家操作']) {
      await expect(page.getByRole('button', { name: label })).toBeVisible()
    }
    // 迷你终端
    await expect(page.getByText('SERVER CONSOLE').first()).toBeVisible()
  })

  test('底部 Tab 切换：玩家列表可见 + 控制台输入发送', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/emergency')
    await page.getByRole('button', { name: '玩家', exact: true }).click()
    // mock 在线玩家 Steve/Alex/Bob
    await expect(page.getByText('Steve').first()).toBeVisible()
    await expect(page.getByRole('button', { name: '踢出' }).first()).toBeVisible()
    // 控制台 Tab
    await page.getByRole('button', { name: '控制台' }).click()
    await page.getByLabel('终端命令输入').fill('say 移动端测试')
    await page.getByRole('button', { name: '发送' }).click()
    await expect(page.getByText(/已执行：say 移动端测试/)).toBeVisible()
  })

  test('停止确认显示在线玩家数（B8）', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/emergency')
    await page.getByRole('button', { name: '停止' }).click()
    // mock 3 名在线玩家
    await expect(page.getByText(/3 名玩家当前在线/)).toBeVisible()
    await expect(page.getByRole('button', { name: '存档并停止' })).toBeVisible()
  })

  test('更多 Tab：主题切换', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/emergency')
    await page.getByRole('button', { name: '更多' }).click()
    await page.getByRole('button', { name: /切换到亮色主题/ }).click()
    await expect(page.getByRole('button', { name: /切换到深色主题/ })).toBeVisible()
  })
})

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

  test('紧急页桌面宽度下收窄为手机列（不再被拉伸成整屏）', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/emergency')
    // 顶栏是这个全高列的整宽子元素：量它即量到列宽（不耦合类名）
    const header = page.locator('header').first()
    await expect(header).toBeVisible()
    const box = await header.boundingBox()
    expect(box?.width ?? 0).toBeLessThanOrEqual(448)
    // 上限落在容器自身的 max-w-md (448px) 上；窄视口按 w-full 收缩，行为不变
    expect(await header.locator('..').evaluate((el) => getComputedStyle(el).maxWidth)).toBe('448px')
  })
})
