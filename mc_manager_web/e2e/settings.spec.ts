import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'

/**
 * 设置页 E2E（数据源：scripts/mock-server.mjs，备份/实例数据为结构占位虚构内容）
 * 验收：子导航五页 / 连接表单保存 / 通用 autoRestart+主题 / 通知两组开关 / 备份列表+恢复确认 / 关于
 */

// 可选截图（调试用）：设 E2E_SHOT=1 时输出到 test-results/shots/，默认关闭
const SHOT_DIR = path.join(process.cwd(), 'test-results', 'shots')
function maybeShot(page: Page, name: string) {
  return process.env.E2E_SHOT ? page.screenshot({ path: path.join(SHOT_DIR, name) }) : undefined
}

// 包版本（about-panel 由 vite define 编译期注入同源值），不逐版本改断言
const APP_VERSION = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8')).version

/** 注入连接配置（mock 假 key，mock server 不校验）——严禁真实服务器信息 */
async function setupConnection(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'mcs-connection',
      JSON.stringify({ baseUrl: '', apiKey: 'e2e-mock-key-0000000000' }),
    )
  })
}

test.describe('设置页', () => {
  test('子导航：六子页 + 默认重定向连接设置', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/settings')
    // /settings → 重定向 /settings/connection
    await expect(page).toHaveURL(/\/settings\/connection/)
    // 子导航六项（含安全主线的账号与安全）
    for (const label of ['连接设置', '账号与安全', '通用设置', '通知设置', '备份管理', '关于']) {
      await expect(page.getByRole('link', { name: label })).toBeVisible()
    }
    await expect(page.getByRole('link', { name: '连接设置' })).toHaveAttribute('aria-current', 'page')
  })

  test('连接设置：表单 + 测试连接 + 保存', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/settings/connection')
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

  test('连接设置：登录会话属于别的面板 → 提示改用 API Key，且不把人踢下线', async ({ page }) => {
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
    await page.goto('/settings/connection')
    await expect(page.getByText(/当前登录会话属于/)).toBeVisible()

    // 换成本面板地址 + 本面板 Key → 走 API Key 通道测试成功。
    // 承重：mock 按未知 Bearer 回 40103（见 mock-server.mjs 请求入口），
    // 旧实现无条件发 A 的令牌，这里拿不到「连接成功」。
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

  test('通用设置：自动重启开关 + 主题切换', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/settings/general')
    await expect(page.getByText('意外停止自动重启')).toBeVisible()
    await expect(page.getByText('服务器意外崩溃/退出后自动重启（手动停止不触发）')).toBeVisible()
    // 切换 → 成功 toast
    await page.getByRole('switch', { name: '意外停止自动重启' }).click()
    await expect(page.getByText('自动重启设置已保存')).toBeVisible()
    // 主题切换
    await expect(page.getByText('界面主题')).toBeVisible()
    await maybeShot(page, 'settings-general-dark.png')
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

  test('备份管理：列表 + 立即备份 + 恢复确认取消', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/settings/backup')
    // 面板标题（h3 面板内标题；页面级 h2 与其同名，按层级区分）
    await expect(page.getByRole('heading', { name: '备份管理', level: 3 })).toBeVisible()
    // 快照机制说明
    await expect(page.getByText('快照备份：未修改文件零拷贝增量传输，超出保留策略自动清理')).toBeVisible()
    // 列表行（mock 3 条：completed snapshot / zip / failed）。三条名称都用精确匹配：
    // 子串匹配下夹具名重新内嵌日期也照样命中，等于没有防线
    await expect(page.getByText('手动备份', { exact: true })).toBeVisible()
    await expect(page.getByText('旧格式压缩包', { exact: true })).toBeVisible()
    await expect(page.getByText('失败的备份', { exact: true })).toBeVisible()
    await expect(page.getByText('旧格式', { exact: true })).toBeVisible()
    // 立即备份 → creating 行 + toast
    await page.getByRole('button', { name: '立即备份' }).click()
    await expect(page.getByText('备份任务已启动')).toBeVisible()
    // 恢复确认（B3 危险弹窗：红色警示 + 输入实例名确认）→ 取消
    await page.getByRole('button', { name: '手动备份 恢复' }).click()
    await expect(page.getByRole('heading', { name: '恢复备份（危险操作）' })).toBeVisible()
    await expect(
      page.getByText(/覆盖当前世界数据，且不可撤销/),
    ).toBeVisible()
    await page.getByRole('button', { name: '取消' }).click()
    await expect(page.getByRole('heading', { name: '恢复备份（危险操作）' })).toBeHidden()
    await maybeShot(page, 'settings-backup-dark.png')
  })

  test('关于：版本与链接', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/settings/about')
    await expect(page.getByRole('heading', { name: 'MC Commander' })).toBeVisible()
    await expect(page.getByText(`v${APP_VERSION}`)).toBeVisible()
    await expect(page.getByText('开源项目', { exact: true })).toBeVisible()
    await expect(page.getByText('基于 AGPL-3.0 协议开源')).toBeVisible()
    // 外链（GitHub 主仓与 Gitee 镜像）
    const repoLink = page.getByRole('link', { name: /GitHub 仓库/ })
    await expect(repoLink).toHaveAttribute('href', /github\.com\/wyyfzb\/mc-commander/)
    await expect(repoLink).toHaveAttribute('target', '_blank')
    const giteeLink = page.getByRole('link', { name: /Gitee 镜像仓库/ })
    await expect(giteeLink).toHaveAttribute('href', /gitee\.com\/wyyfzb\/mc-commander/)
    await expect(giteeLink).toHaveAttribute('target', '_blank')
    await expect(page.getByText('© 2026 MC_Commander · 社区开源项目')).toBeVisible()
    await maybeShot(page, 'settings-about-dark.png')
  })
})
