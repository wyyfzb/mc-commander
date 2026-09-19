import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'

/**
 * 登录 E2E（安全主线；数据源：scripts/mock-server.mjs，凭据为结构占位虚构内容）
 * 验收：无凭据访问 → 重定向登录页 / 登录模式输错密码报错 / 正确密码登录进入面板 /
 *       会话持久化（刷新不掉线）/ 设密向导（?fresh=1）/ 顶栏用户菜单登出
 */

// 可选截图（调试用）：设 E2E_SHOT=1 时输出到 test-results/shots/，默认关闭
const SHOT_DIR = path.join(process.cwd(), 'test-results', 'shots')
function maybeShot(page: Page, name: string) {
  return process.env.E2E_SHOT ? page.screenshot({ path: path.join(SHOT_DIR, name) }) : undefined
}

/** 清空所有凭据（未登录场景；幂等一次性：sessionStorage 标记防 vite dep 优化 full-reload 后重复清空登录态） */
async function clearCredentials(page: Page) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('__mcsCredsCleared')) return
    sessionStorage.setItem('__mcsCredsCleared', '1')
    localStorage.removeItem('mcs-connection')
    localStorage.removeItem('mcs-session')
  })
}

/** 模拟未设密后端（首访设密向导；page.route 拦截优先于代理，不依赖页面 URL 参数透传） */
async function mockFreshBackend(page: Page) {
  await page.route('**/api/v1/auth/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ok',
        code: 0,
        message: 'Success',
        data: { hasPassword: false },
        timestamp: new Date().toISOString(),
      }),
    }),
  )
}

test.describe('登录页', () => {
  test('无凭据访问仪表盘 → 重定向登录页（登录模式，mock 默认已设密）', async ({ page }) => {
    await clearCredentials(page)
    await page.goto('/dashboard')
    await expect(page).toHaveURL(/\/login/)
    await expect(page.getByRole('heading', { name: '管理员登录' })).toBeVisible()
    await maybeShot(page, 'login-mode.png')
  })

  test('密码错误 → 服务端 40102 友好文案，停留在登录页', async ({ page }) => {
    await clearCredentials(page)
    await page.goto('/login')
    const passwordInput = page.getByLabel('管理员密码')
    await expect(passwordInput).toBeVisible()
    await passwordInput.fill('totally-wrong')
    await page.getByRole('button', { name: /登录/ }).click()
    await expect(page.getByRole('alert')).toContainText('密码错误')
    await expect(page).toHaveURL(/\/login/)
  })

  test('正确密码登录 → 进入仪表盘 + 会话持久化（刷新不掉线）', async ({ page }) => {
    await clearCredentials(page)
    await page.goto('/login')
    await page.getByLabel('管理员密码').fill('e2e-correct-pass')
    await page.getByRole('button', { name: /登录/ }).click()
    await expect(page).toHaveURL(/\/dashboard/)
    // 顶栏用户菜单显示管理员身份
    await expect(page.getByRole('button', { name: '管理员菜单' })).toBeVisible()
    await maybeShot(page, 'login-success.png')

    // 刷新：会话从 localStorage 恢复，不再回登录页
    await page.reload()
    await expect(page).toHaveURL(/\/dashboard/)
    await expect(page.getByRole('button', { name: '管理员菜单' })).toBeVisible()
  })

  test('首访设密向导：输入两次密码 → 登录成功', async ({ page }) => {
    await clearCredentials(page)
    await mockFreshBackend(page)
    await page.goto('/login')
    await expect(page.getByRole('heading', { name: '设置管理员密码' })).toBeVisible()
    await page.getByLabel('管理员密码', { exact: true }).fill('e2e-correct-pass')
    // 输入非空后强度条渲染
    await expect(page.getByText(/密码强度/)).toBeVisible()
    await page.getByLabel('确认密码').fill('e2e-correct-pass')
    await page.getByRole('button', { name: /设置密码并登录/ }).click()
    await expect(page).toHaveURL(/\/dashboard/)
    await maybeShot(page, 'login-setup.png')
  })

  test('顶栏用户菜单：登出 → 回登录页（凭据清除）', async ({ page }) => {
    await clearCredentials(page)
    await page.goto('/login')
    await page.getByLabel('管理员密码').fill('e2e-correct-pass')
    await page.getByRole('button', { name: /登录/ }).click()
    await expect(page).toHaveURL(/\/dashboard/)

    await page.getByRole('button', { name: '管理员菜单' }).click()
    await page.getByRole('menuitem', { name: '退出登录' }).click()
    await expect(page).toHaveURL(/\/login/)
  })

  test('顶栏登出：本机残留 API Key 时也能真正退出（会话 + Key 一并清除）', async ({ page }) => {
    await clearCredentials(page)
    await page.goto('/login')
    await page.getByLabel('管理员密码').fill('e2e-correct-pass')
    await page.getByRole('button', { name: /登录/ }).click()
    await expect(page).toHaveURL(/\/dashboard/)

    // 造「会话 + 残留 API Key」的双凭据浏览器（只清会话时凭据仍在 → /login 被守卫弹回、人留在面板里）
    await page.evaluate(() => {
      const raw = localStorage.getItem('mcs-connection')
      const cfg = raw ? (JSON.parse(raw) as { baseUrl?: string }) : {}
      localStorage.setItem(
        'mcs-connection',
        JSON.stringify({ baseUrl: cfg.baseUrl ?? '', apiKey: 'e2e-mock-key-0000000000' }),
      )
    })
    await page.reload()
    await expect(page).toHaveURL(/\/dashboard/)

    await page.getByRole('button', { name: '管理员菜单' }).click()
    await page.getByRole('menuitem', { name: '退出登录' }).click()
    // 凭据全清 → requireUnconfigured 放行，真正落在登录页而不是被弹回仪表盘
    await expect(page).toHaveURL(/\/login/)
    await expect(page.getByRole('heading', { name: '管理员登录' })).toBeVisible()
    expect(await page.evaluate(() => localStorage.getItem('mcs-connection'))).not.toContain(
      'e2e-mock-key',
    )
  })

  test('账号与安全面板：会话列表 + 本机徽章 + 改密表单', async ({ page }) => {
    await clearCredentials(page)
    await page.goto('/login')
    await page.getByLabel('管理员密码').fill('e2e-correct-pass')
    await page.getByRole('button', { name: /登录/ }).click()
    await expect(page).toHaveURL(/\/dashboard/)

    await page.goto('/settings/account')
    await expect(page.getByRole('heading', { name: '账号与安全', level: 2 })).toBeVisible()
    // 会话徽章 + 会话列表（mock UA 无浏览器指纹 → describeUserAgent 显示「未知浏览器」+ 本机徽章）
    await expect(page.getByText('管理员会话').first()).toBeVisible()
    await expect(page.getByText('未知浏览器')).toBeVisible()
    await expect(page.getByText('本机')).toBeVisible()
    // 改密表单存在
    await expect(page.getByLabel('当前密码')).toBeVisible()
    await maybeShot(page, 'account-panel.png')
  })
})
