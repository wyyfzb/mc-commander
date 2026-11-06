import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'

/**
 * 设置页 E2E（数据源：同目录 mock-server.mjs，实例数据为结构占位虚构内容）
 * 验收：子导航五页 / 连接表单保存 / 界面偏好 / 通知两组开关 / 推送与记录入口 / 关于弹窗
 * 备份是侧栏一级页面，其 e2e 在 backups.spec.ts
 */

// 可选截图（调试用）：设 E2E_SHOT=1 时输出到 tools/e2e/test-results/shots/，默认关闭
const E2E_DIR = import.meta.dirname
const SHOT_DIR = path.join(E2E_DIR, 'test-results', 'shots')
function maybeShot(page: Page, name: string) {
  return process.env.E2E_SHOT ? page.screenshot({ path: path.join(SHOT_DIR, name) }) : undefined
}

// 包版本（about-panel 由 vite define 编译期注入同源值），不逐版本改断言
// 读前端包的 package.json：本 spec 住 tools/e2e/，cwd 不再是 apps/web，
// 按 cwd 找会读到仓库根（该文件无 version 字段 → 断言恒拿到 undefined）
const APP_VERSION = JSON.parse(
  fs.readFileSync(path.join(E2E_DIR, '..', '..', 'apps', 'web', 'package.json'), 'utf-8'),
).version

/** 注入连接配置（mock 假 key，mock server 不校验）——严禁真实服务器信息 */
async function setupConnection(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'mcs-connection',
      JSON.stringify({ baseUrl: '', apiKey: 'e2e-mock-key-0000000000' }),
    )
  })
}

/**
 * 把能力探测切到「API Key 通道关闭」态。
 *
 * 构造方式：mock 按请求头 `x-mock-api-key-enabled: 0` 判定（见 同目录 mock-server.mjs）。
 * 之所以不在服务端启动时定死：Playwright 的 webServer 前后端共用一轮，环境变量改不了，
 * 而同一 spec 文件里真假两态必须都能跑（false 态结构性不可达的夹具等于没有防线）。
 * 只补一个请求头，不伪造响应体——走的仍是 mock 的真实应答路径。
 */
async function mockApiKeyChannel(page: Page, enabled: boolean) {
  await page.setExtraHTTPHeaders({ 'x-mock-api-key-enabled': enabled ? '1' : '0' })
}

test.describe('设置页', () => {
  test('子导航：五子页 + 默认重定向连接与外观', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/settings')
    // /settings → 重定向 /settings/device
    await expect(page).toHaveURL(/\/settings\/device/)
    // 五项：分组判据是「换设备跟不跟过来」，不是到达频率
    for (const label of ['连接与外观', '登录与密码', '通知', '推送与记录', '数据与卸载']) {
      await expect(page.getByRole('link', { name: label })).toBeVisible()
    }
    await expect(page.getByRole('link', { name: '连接与外观' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    // 关于不在子导航里（纯静态信息，走弹窗），但入口仍在：导航末尾的按钮
    await expect(page.getByRole('button', { name: '关于' })).toBeVisible()
  })

  /**
   * 子导航「图标态 ↔ 文字态」按容器内容宽切档（@3xl=768px）。
   * jsdom 不评估容器查询，阈值只能在这里锁。768 视口展开侧栏内容仅 528px：
   * 改前视口 md 把子导航展成 200px 文字态，右表单区被压到 312px；现在必须保持
   * 图标态、把宽度让给表单。1024 视口内容 784px 才展成文字态
   */
  test('子导航按容器宽切档：768 视口保持图标态（表单不被压窄），1024 展文字态', async ({
    page,
  }) => {
    await setupConnection(page)

    const geom = () =>
      page.evaluate(() => {
        const nav = document.querySelector("nav[aria-label='设置子导航']")!
        const form = nav.nextElementSibling!
        const label = nav.querySelector('span.hidden')!
        return {
          navW: Math.round(nav.getBoundingClientRect().width),
          formW: Math.round(form.getBoundingClientRect().width),
          expanded: label.getBoundingClientRect().width > 0,
        }
      })

    // 768 展开侧栏：内容 528 < 768 ⇒ 图标态，表单 464px（改前 312px）
    await page.setViewportSize({ width: 768, height: 900 })
    await page.goto('/settings/account')
    await expect(page.getByRole('heading', { name: '登录与密码', level: 2 })).toBeVisible()
    const narrow = await geom()
    expect(narrow.expanded).toBe(false)
    expect(narrow.navW).toBe(48)
    expect(narrow.formW).toBeGreaterThanOrEqual(440)

    // 1024 展开侧栏：内容 784 ≥ 768 ⇒ 文字态，表单仍有余量
    await page.setViewportSize({ width: 1024, height: 900 })
    await expect(page.getByRole('link', { name: '登录与密码' })).toBeVisible()
    const wide = await geom()
    expect(wide.expanded).toBe(true)
    expect(wide.navW).toBe(200)
    expect(wide.formW).toBeGreaterThanOrEqual(540)

    // 两态都不得横向溢出
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBe(0)
  })

  test('连接与外观：表单 + 测试连接 + 保存', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/settings/device')
    // 表单字段（面板地址 + API Key）
    await expect(page.getByRole('textbox', { name: '面板地址' })).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'API Key' })).toBeVisible()
    // 已配置状态行（顶栏状态点同名文本亦为「已连接」，取首个避免 strict 违规）
    await expect(page.getByText('已连接').first()).toBeVisible()
    // 填地址 → 测试连接（走 dev proxy 到 mock，成功）
    // 地址取当前页 origin（端口随 MOCK_PORT/DEV_PORT 泳道变化），不硬编码端口
    await page.getByRole('textbox', { name: '面板地址' }).fill(new URL(page.url()).origin)
    await page.getByRole('button', { name: '测试连接' }).click()
    await expect(page.getByText('连接成功')).toBeVisible()
    // 保存
    await page.getByRole('button', { name: '保存连接' }).click()
    await expect(page.getByText('连接配置已保存')).toBeVisible()
    await maybeShot(page, 'settings-connection-dark.png')
  })

  test('连接与外观：从其他设备访问——本机地址打开时指路，不给可复制地址', async ({ page }) => {
    await setupConnection(page)
    // e2e 的 dev server 在 localhost：环回地址换到别的设备上打不开，卡片改为指路
    await page.goto('/settings/device')
    await expect(page.getByText('从其他设备访问')).toBeVisible()
    await expect(page.getByText(/本机地址/)).toBeVisible()
    await expect(page.getByRole('button', { name: '复制地址' })).toHaveCount(0)
  })

  test('连接与外观：登录会话属于别的面板 → 提示改用 API Key，且不把人踢下线', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        'mcs-connection',
        JSON.stringify({ baseUrl: '', apiKey: 'e2e-mock-key-0000000000' }),
      )
      // 会话绑定到另一个面板（虚构地址）：本面板用不上它
      localStorage.setItem(
        'mcs-session',
        JSON.stringify({
          token: 'e2e-foreign-session-token',
          sessionId: 'e2e-sess-1',
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          issuedFor: 'https://panel-a.example.com',
        }),
      )
    })
    await page.goto('/settings/device')
    await expect(page.getByText(/当前登录会话属于/)).toBeVisible()

    // 换成本面板地址 + 本面板 Key → 走 API Key 通道测试成功。
    // 承重：mock 按未知 Bearer 回 40103（见 mock-server.mjs 请求入口），
    // 故这里必须发面板自己的令牌才能拿到「连接成功」。
    // 地址同样取当前页 origin（端口随泳道变化，硬编码端口在非默认泳道下假红）
    await page.getByRole('textbox', { name: '面板地址' }).fill(new URL(page.url()).origin)
    await page.getByRole('textbox', { name: 'API Key' }).fill('e2e-mock-key-0000000000')
    await page.getByRole('button', { name: '测试连接' }).click()
    await expect(page.getByText('连接成功')).toBeVisible()
    await maybeShot(page, 'settings-connection-foreign-session-dark.png')

    // 应用内常规请求这一路（不经过探测的「不因会话过期跳登录」豁免）也不能被踢：
    // 整页重载触发应用启动路径的请求（连接表单此时是脏的，in-app 导航会被未保存守卫拦下），
    // 若把 A 的令牌发出去即被 40103 清会话 + 跳登录页
    await page.goto('/dashboard')
    await expect(page).toHaveURL(/\/dashboard/)
    await expect(page.getByText('在线玩家').first()).toBeVisible()
    expect(await page.evaluate(() => localStorage.getItem('mcs-session'))).toContain(
      'e2e-foreign-session-token',
    )
  })

  test('连接与外观：API Key 通道开启 → 轮换入口可见可点', async ({ page }) => {
    await setupConnection(page)
    await mockApiKeyChannel(page, true)
    await page.goto('/settings/device')

    // 能力探测只认「已落定的面板地址」（空地址是同源默认值，刻意不探测，见 useApiKeyCapabilities），
    // 故先指明面板地址；地址取当前页 origin（端口随 MOCK_PORT/DEV_PORT 泳道变化）
    await page.getByRole('textbox', { name: '面板地址' }).fill(new URL(page.url()).origin)

    // 打开态：入口在；凭据定位说明已收进信息入口，点开即读到全文
    await expect(page.getByRole('button', { name: '重新生成' })).toBeVisible()
    await page.getByRole('button', { name: 'API Key 说明' }).click()
    await expect(page.getByRole('dialog', { name: 'API Key 说明' })).toContainText(
      '权限等同于管理员',
    )
    await page.keyboard.press('Escape')
    await maybeShot(page, 'settings-connection-api-key-enabled-dark.png')

    // 亮色复读：同一判定在另一主题下不得漂移（截图供视觉审查，判定本身与主题无关）
    await page.getByRole('button', { name: '切换到亮色主题' }).click()
    await expect(page.getByRole('button', { name: '重新生成' })).toBeVisible()
    await maybeShot(page, 'settings-connection-api-key-enabled-light.png')
  })

  test('连接与外观：API Key 通道关闭（API_KEY_ENABLED=false）→ 轮换入口不可见并说明原因', async ({
    page,
  }) => {
    await setupConnection(page)
    await mockApiKeyChannel(page, false)
    await page.goto('/settings/device')
    await page.getByRole('textbox', { name: '面板地址' }).fill(new URL(page.url()).origin)

    // 关闭态：入口消失 + 关闭原因可见；凭据输入框保留（已有 Key 仍可粘贴保存）。
    // 用 toHaveCount(0) 而非 toBeHidden：后者对「元素根本不存在」同样通过，会放过回归
    await expect(page.getByText(/部署配置已关闭 API Key 通道/)).toBeVisible()
    await expect(page.getByRole('button', { name: '重新生成' })).toHaveCount(0)
    await expect(page.getByRole('textbox', { name: 'API Key' })).toBeVisible()
    await maybeShot(page, 'settings-connection-api-key-disabled-dark.png')

    // 亮色复读：关闭态在另一主题下同样不显示入口
    await page.getByRole('button', { name: '切换到亮色主题' }).click()
    await expect(page.getByText(/部署配置已关闭 API Key 通道/)).toBeVisible()
    await expect(page.getByRole('button', { name: '重新生成' })).toHaveCount(0)
    await maybeShot(page, 'settings-connection-api-key-disabled-light.png')
  })

  test('能力探测端点未认证 → 401：mock 与真实服务端同门（不得放行匿名探测）', async ({ page }) => {
    // 不带任何凭据直连该端点（page.request 不继承页面凭据）：真实服务端把它放在
    // authMiddleware 公开白名单之外，未认证一律 401 + 40107（未提供凭据；与「凭据无效」
    // 的 40101 分开）；mock 必须同判，否则「客户端忘了带凭据」在 e2e 里永远成功，
    // 这层防线等于没有。
    const res = await page.request.get('/api/v1/auth/capabilities')
    expect(res.status()).toBe(401)
    const body = (await res.json()) as { code: number; message: string }
    expect(body.code).toBe(40107)
    expect(body.message).toBe('未提供访问凭据：请携带 X-API-Key 头或登录会话令牌')
  })

  test('账号与安全：只读监控凭据——生成后明文只展示一次，收起即不可回看', async ({ page }) => {
    await setupConnection(page)
    // 初始态用请求头钉死（同轮 webServer 共享一个 mock 进程，其它用例可能已生成过凭据；
    // 不依赖 /mock/reset——复位是进程级共享状态，按域复位也可能漏掉本用例关心的那一项）
    await page.setExtraHTTPHeaders({ 'x-mock-readonly-configured': '0' })
    await page.goto('/settings/account')

    // 初始态：服务端未配置只读凭据（mock 台账初值 false）
    const panel = page
      .getByRole('heading', { name: '只读监控凭据' })
      .locator('xpath=ancestor::section[1]')
    await expect(panel.getByText('尚未创建')).toBeVisible()
    // 权限范围收进信息入口：正文不常驻，点开才读到
    await expect(panel.getByText(/仅能访问 5 个读数端点/)).toHaveCount(0)
    await panel.getByRole('button', { name: '只读凭据权限范围' }).click()
    await expect(page.getByRole('dialog', { name: '只读凭据权限范围' })).toContainText(
      '仅能访问 5 个读数端点',
    )
    await page.keyboard.press('Escape')

    // 生成：首次生成无需二次确认；明文一次性出现
    await panel.getByRole('button', { name: /生成只读凭据/ }).click()
    const issued = 'mcro-mock-1234-5678-90ab-cdef-1234-5678-90ab-cdef'
    await expect(panel.getByText(issued)).toBeVisible()
    await expect(panel.getByText(/只显示这一次/)).toBeVisible()

    // 收起后明文消失，且刷新页面也拿不回来（服务端只存摘要）
    await panel.getByRole('button', { name: /我已保存，收起/ }).click()
    await expect(panel.getByText(issued)).toHaveCount(0)
    // 撤掉请求头覆盖：让状态回到 mock 真实台账（生成已把它置真）
    await page.setExtraHTTPHeaders({})
    await page.reload()
    await expect(page.getByText(issued)).toHaveCount(0)
    // 状态下翻为「已配置」：入口文案变为重新生成
    await expect(page.getByRole('button', { name: /重新生成只读凭据/ })).toBeVisible()
  })

  test('账号与安全：重新生成只读凭据需二次确认（说明旧凭据立即失效）', async ({ page }) => {
    await setupConnection(page)
    // 显式钉死「已配置」初始态（不依赖同轮其它用例先跑出状态）
    await page.setExtraHTTPHeaders({ 'x-mock-readonly-configured': '1' })
    await page.goto('/settings/account')
    const panel = page
      .getByRole('heading', { name: '只读监控凭据' })
      .locator('xpath=ancestor::section[1]')

    await panel.getByRole('button', { name: '重新生成只读凭据' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText(/旧凭据立即失效/)).toBeVisible()
    // 取消：不发起写请求（凭据状态保持已配置，且无新明文出现）
    await dialog.getByRole('button', { name: '取消' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByText('mcro-mock-1234-5678-90ab-cdef-1234-5678-90ab-cdef')).toHaveCount(0)
  })

  test('账号与安全：只读凭据通道关闭 → 入口禁用并说明恢复方法', async ({ page }) => {
    await setupConnection(page)
    await page.setExtraHTTPHeaders({
      'x-mock-readonly-enabled': '0',
      'x-mock-readonly-configured': '1',
    })
    await page.goto('/settings/account')

    const panel = page
      .getByRole('heading', { name: '只读监控凭据' })
      .locator('xpath=ancestor::section[1]')
    await expect(panel.getByText('通道已关闭')).toBeVisible()
    await expect(panel.getByText(/READONLY_API_KEY_ENABLED=false/)).toBeVisible()
    await expect(panel.getByRole('button', { name: '重新生成只读凭据' })).toBeDisabled()
  })

  /* 自动重启是实例级配置，写入口是 PUT /instances/:id，住实例设置弹窗（instances.spec 覆盖）。
     这里断言的正是「它不在这张卡上」——界面外观只剩本机偏好（主题/终端滚动/命令确认），
     三项都不落服务端。若哪天它又出现在这里，说明 scope 又漂了，这条会先红 */
  test('界面外观：只有本机偏好，自动重启不在此处', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/settings/device')
    await expect(page.getByText('界面主题')).toBeVisible()
    await expect(page.getByText('终端自动滚动')).toBeVisible()
    await expect(page.getByText('命令执行二次确认')).toBeVisible()
    // 实例级配置不在这张卡上：既没有标题也没有开关（开关在实例设置弹窗里）
    await expect(page.getByText('意外停止后自动重启')).toHaveCount(0)
    await expect(page.getByRole('switch', { name: '意外停止后自动重启' })).toHaveCount(0)
    await maybeShot(page, 'settings-device-dark.png')
  })

  /* 推送与记录：只放入口卡，两个目标都是顶层路由的完整页面（各自带 PageHeader）。
     嵌进设置子路由会两个页头 + 三层滚动，故这里断言「点过去确实换了页」 */
  test('推送与记录：两张入口卡分别跳到 webhooks / audit', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/settings/integration')
    await expect(page.getByRole('heading', { name: '推送通知到外部' })).toBeVisible()
    await expect(page.getByRole('heading', { name: '谁做了什么' })).toBeVisible()
    // 离开设置前先交代，避免用户以为跳走是出错
    await expect(page.getByText('这是独立页面，点开会离开设置')).toHaveCount(2)

    await page.getByRole('link', { name: '去配置推送' }).click()
    await expect(page).toHaveURL(/\/webhooks/)

    await page.goBack()
    await page.getByRole('link', { name: '查看操作记录' }).click()
    await expect(page).toHaveURL(/\/audit/)
  })

  test('通知设置：两组开关 + 修改即时保存', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/settings/notifications')
    // B21 通知矩阵改版：事件类型分组表 + 严重度列
    await expect(page.getByText(/设置各类通知的站内推送/)).toBeVisible()
    await expect(page.getByText('修改即时保存')).toBeVisible()
    // 两组标题
    await expect(page.getByText('游戏通知')).toBeVisible()
    await expect(page.getByText('服务器通知')).toBeVisible()
    // 单行开关切换
    await page.getByRole('switch', { name: '聊天' }).click()
    await maybeShot(page, 'settings-notifications-dark.png')
  })

  test('关于：从设置子导航打开弹窗（版本与链接）', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/settings/device')
    await page.getByRole('button', { name: '关于' }).click()
    // 弹窗以标题承担可访问名
    const dialog = page.getByRole('dialog', { name: 'MC Commander' })
    await expect(dialog).toBeVisible()
    // 精确匹配版本徽章：更新检查卡也有「当前 v…」，模糊匹配会命中两个
    await expect(dialog.getByText(`v${APP_VERSION}`, { exact: true })).toBeVisible()
    await expect(dialog.getByText('开源项目', { exact: true })).toBeVisible()
    await expect(dialog.getByText('基于 AGPL-3.0 协议开源')).toBeVisible()
    // 外链（GitHub 主仓与 Gitee 镜像）
    const repoLink = dialog.getByRole('link', { name: /GitHub 仓库/ })
    await expect(repoLink).toHaveAttribute('href', /github\.com\/wyyfzb\/mc-commander/)
    await expect(repoLink).toHaveAttribute('target', '_blank')
    const giteeLink = dialog.getByRole('link', { name: /Gitee 镜像仓库/ })
    await expect(giteeLink).toHaveAttribute('href', /gitee\.com\/wyyfzb\/mc-commander/)
    await expect(giteeLink).toHaveAttribute('target', '_blank')
    await expect(dialog.getByText('© 2026 MC_Commander · 社区开源项目')).toBeVisible()
    await maybeShot(page, 'settings-about-dialog-dark.png')
  })
})
