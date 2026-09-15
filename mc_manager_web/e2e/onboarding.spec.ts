import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'

/**
 * onboarding E2E（无配置时 /dashboard 重定向 /onboarding）
 * 验收：重定向守卫 / 部署方式三选一（Docker 仅一行说明）/ 手动部署命令展示 / 连接成功后三步清单 / 连接表单保存 → 进入面板
 *      / 页面级唯一 h1
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

  test('页面级唯一 h1：欢迎区是 h1，连接表单标题让位为 h2', async ({ page }) => {
    await clearConnection(page)
    await page.goto('/onboarding')
    // 同屏两个 h1 会让页面失去唯一标题（屏幕阅读器按 h1 定位主内容）；
    // 默认路径下欢迎区与连接表单同时渲染，二者必须分属不同层级
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('欢迎使用 MC Commander')
    await expect(page.getByRole('heading', { level: 2, name: '连接你的服务器' })).toBeVisible()
  })

  test('部署方式切换（三选一）：Windows 步骤 / Linux 命令 + 要点', async ({ page }) => {
    await clearConnection(page)
    await page.goto('/onboarding')
    // 三张卡片：已有服务端 / Linux 一键部署 / Windows 手动部署；Docker 只占一行说明
    await expect(page.getByRole('button', { name: 'Docker' })).toHaveCount(0)
    await expect(page.getByText(/Docker 不在支持范围内/)).toBeVisible()
    await page.getByRole('radio', { name: 'Windows 手动部署' }).click()
    await expect(page.getByText('Windows 手动部署（Node 22+）')).toBeVisible()
    // 前端产物构建是必需步骤（缺失时 :25566 只有接口没有界面）
    await expect(page.getByText(/npm run build/)).toBeVisible()
    await maybeShot(page, 'onboarding-windows-dark.png')
    // Linux 一键部署：命令与要点
    await page.getByRole('radio', { name: 'Linux 一键部署' }).click()
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

  test('部署方式是可键盘操作的单选组：方向键移动并即时选中', async ({ page }) => {
    await clearConnection(page)
    await page.goto('/onboarding')
    // jsdom 模拟不出真实的 Tab 顺序与焦点，roving tabindex 必须在真实浏览器里验
    const group = page.getByRole('radiogroup', { name: '部署方式' })
    await expect(group.getByRole('radio')).toHaveCount(3)
    const already = group.getByRole('radio', { name: '已有服务端' })
    await expect(already).toBeChecked()
    // roving tabindex：组内恰好一个 Tab 停靠点，且落在选中项上
    await expect(group.locator('[role="radio"][tabindex="0"]')).toHaveCount(1)
    await expect(already).toHaveAttribute('tabindex', '0')

    await already.focus()
    await page.keyboard.press('ArrowRight')
    await expect(group.getByRole('radio', { name: 'Linux 一键部署' })).toBeChecked()
    await expect(page.getByText('Linux 一键部署命令')).toBeVisible()
    // 焦点随选中移动：不移动的话下一次方向键仍从原项出发，键盘用户会「原地打转」
    const linux = group.getByRole('radio', { name: 'Linux 一键部署' })
    await expect(linux).toBeFocused()
    // 停靠点随选中迁移：组内仍只有一个 tabindex=0，且在 Linux 上
    await expect(group.locator('[role="radio"][tabindex="0"]')).toHaveCount(1)
    await expect(linux).toHaveAttribute('tabindex', '0')

    await page.keyboard.press('Home')
    await expect(already).toBeChecked()
  })

  test('连接成功后的三步清单：恰好三条、无「邀请」、非分步向导', async ({ page }) => {
    await clearConnection(page)
    await page.goto('/onboarding')
    const steps = page.getByRole('list', { name: '连接成功后的三步' })
    await expect(steps.getByRole('listitem')).toHaveCount(3)
    await expect(steps).toContainText('部署实例')
    await expect(steps).toContainText('确认 RCON')
    await expect(steps).toContainText('加首位白名单')
    // 原四步口径的「邀请」全仓 0 处承载 → 已砍，页面不得出现
    await expect(page.getByText(/邀请/)).toHaveCount(0)
    // 不做分步向导：默认路径（已有服务端）下连接表单与清单同屏，无步骤导航
    await expect(page.getByRole('button', { name: '连接并进入面板' })).toBeVisible()
    await expect(page.getByRole('button', { name: /下一步|上一步|跳过/ })).toHaveCount(0)
    await maybeShot(page, 'onboarding-post-connect-dark.png')
  })

  test('引导页内容超视口：顶部仍从滚动起点可见（不切顶），三步每条单行', async ({ page }) => {
    await clearConnection(page)
    await page.goto('/onboarding')
    // 等 route chunk 与字体就位再量尺寸：早量会读到未完成布局（曾量出 720 的假值）
    await page.waitForLoadState('networkidle')
    await page.evaluate(() => document.fonts.ready)
    // 720px 是 Playwright 默认视口高度；引导页内容实测 960px，确实超视口
    const contentHeight = await page.evaluate(() => document.documentElement.scrollHeight)
    expect(contentHeight).toBeGreaterThan(720)
    // 不切顶：logo 与标题的 y ≥ 0。注意这条**今天不是靠 justify-center-safe 兜住的**——
    // min-h-dvh 是「最小高度 + 高度 auto」，容器始终长到内容高，两种写法实测同为 y=24；
    // safe 是防御：将来若把高度改成显式约束（h-dvh/max-h/父级限高），它会保证顶部仍可达。
    const logoBox = await page.getByRole('img', { name: 'MC Commander Logo' }).boundingBox()
    const titleBox = await page.getByRole('heading', { name: '欢迎使用 MC Commander' }).boundingBox()
    expect(logoBox!.y).toBeGreaterThanOrEqual(0)
    expect(titleBox!.y).toBeGreaterThanOrEqual(0)
    // 三步每条 ≤1 行：12px 字 × 1.5 行高 = 18px，>20px 即折行（折行会把底部入口再推下去）
    const stepHeights = await page
      .getByRole('list', { name: '连接成功后的三步' })
      .getByRole('listitem')
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))
    for (const height of stepHeights) expect(height).toBeLessThanOrEqual(20)
  })

  test('保存连接：onboarding 表单 → 进入面板', async ({ page }) => {
    await clearConnection(page)
    await page.goto('/onboarding')
    // 已有服务端（默认选中）→ 填表单
    // 地址取当前页 origin（= dev server，端口随 MOCK_PORT/DEV_PORT 泳道变化），经其 proxy
    // 转发到 mock：保存前强制测试连接会带 X-API-Key 头直连目标，直连 mock 端口会因
    // mock-server 无 CORS Allow-Headers 头触发 preflight 失败；真实部署服务端同源托管
    // （无跨域），开发/E2E 场景经 proxy 转发为既定模式
    const devOrigin = new URL(page.url()).origin
    await page.getByRole('textbox', { name: '面板地址' }).fill(devOrigin)
    await page.getByRole('textbox', { name: 'API Key' }).fill('e2e-mock-key-0000000000')
    await page.getByRole('button', { name: '连接并进入面板' }).click()
    await expect(page.getByText('连接配置已保存')).toBeVisible()
    // 跳转面板（桌面侧栏 + 移动抽屉双渲染，取任一）
    await expect(page).toHaveURL(/\/dashboard/)
    await expect(page.getByRole('link', { name: '仪表盘' }).first()).toBeVisible()
  })
})
