import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'

/**
 * onboarding E2E（无配置时 /dashboard 重定向 /onboarding）
 * 验收：重定向守卫 / 部署方式二选一 / 手动部署命令展示 / 连接表单保存 → 进入面板
 */

// 可选截图（调试用）：设 E2E_SHOT=1 时输出到 test-results/shots/，默认关闭
const SHOT_DIR = path.join(process.cwd(), 'test-results', 'shots')
function maybeShot(page: Page, name: string) {
  return process.env.E2E_SHOT ? page.screenshot({ path: path.join(SHOT_DIR, name) }) : undefined
}

/** 清空连接配置（unconfigured 场景）——严禁真实服务器信息 */
async function clearConnection(page: Page) {
  await page.addInitScript(() => {
    localStorage.removeItem('mcs-connection')
  })
}

/** 注入连接配置（mock 假 key） */
async function setupConnection(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'mcs-connection',
      JSON.stringify({ baseUrl: '', apiKey: 'e2e-mock-key-0000000000' }),
    )
  })
}

test.describe('onboarding', () => {
  test('无配置：/dashboard 重定向 /login（安全主线：登录页为首访入口）', async ({ page }) => {
    await clearConnection(page)
    await page.goto('/dashboard')
    await expect(page).toHaveURL(/\/login/)
    // onboarding 变为部署引导页，可从登录页 footer 链接进入
    await page.getByRole('link', { name: '前往连接引导' }).click()
    await expect(page).toHaveURL(/\/onboarding/)
    await expect(page.getByText('欢迎使用 MC Commander')).toBeVisible()
  })

  test('已配置：/onboarding 重定向 /dashboard', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/onboarding')
    await expect(page).toHaveURL(/\/dashboard/)
  })

  test('部署方式切换（四选一）：Windows 步骤 / Docker 边界 / 手动命令 + 要点', async ({ page }) => {
    await clearConnection(page)
    await page.goto('/onboarding')
    // 四张卡片：已有服务端 / Windows 部署 / Docker / 手动
    await page.getByRole('button', { name: 'Windows 部署' }).click()
    await expect(page.getByText('Windows 手动部署（Node 22+）')).toBeVisible()
    await maybeShot(page, 'onboarding-windows-dark.png')
    await page.getByRole('button', { name: 'Docker' }).click()
    await expect(page.getByText(/不做容器化/)).toBeVisible()
    await maybeShot(page, 'onboarding-docker-dark.png')
    // 手动（Node 22+）：Linux 一键命令与要点
    await page.getByRole('button', { name: /手动（Node 22\+）/ }).click()
    await expect(page.getByText('Linux 一键部署命令')).toBeVisible()
    await expect(page.getByText(/sudo su -c "curl -fsSL/)).toBeVisible()
    await expect(
      page.getByText('脚本会自动安装 Java 17/21/25 和 Node.js 22+，无需手动准备环境'),
    ).toBeVisible()
    await expect(
      page.getByText('部署完成后，记下终端输出的「API Key」，下一步连接时需要填写。'),
    ).toBeVisible()
    // 部署命令与文档链接均指向现行 gitee 镜像（mc-commander / main 分支）
    await expect(page.getByText(/gitee\.com\/wyyfzb\/mc-commander\/raw\/main\//)).toBeVisible()
    const docLink = page.getByRole('link', { name: '查看部署文档' })
    await expect(docLink).toHaveAttribute('href', 'https://gitee.com/wyyfzb/mc-commander')
    await expect(docLink).toHaveAttribute('target', '_blank')
    await maybeShot(page, 'onboarding-manual-dark.png')
  })

  test('保存连接：onboarding 表单 → 进入面板', async ({ page }) => {
    await clearConnection(page)
    await page.goto('/onboarding')
    // 已有服务端（默认选中）→ 填表单
    // 地址走 dev server（5199）proxy 转发到 mock（与 settings.spec 一致）：
    // 保存前强制测试连接会带 X-API-Key 头直连目标，直连 5198
    // 触发 CORS preflight 而 mock-server 无 Allow-Headers 头；真实部署服务端
    // 同源托管（无跨域），开发/E2E 场景经 proxy 转发为既定模式
    await page.getByRole('textbox', { name: '面板地址' }).fill('http://localhost:5199')
    await page.getByRole('textbox', { name: 'API Key' }).fill('e2e-mock-key-0000000000')
    await page.getByRole('button', { name: '连接并进入面板' }).click()
    await expect(page.getByText('连接配置已保存')).toBeVisible()
    // 跳转面板（桌面侧栏 + 移动抽屉双渲染，取任一）
    await expect(page).toHaveURL(/\/dashboard/)
    await expect(page.getByRole('link', { name: '仪表盘' }).first()).toBeVisible()
  })
})
