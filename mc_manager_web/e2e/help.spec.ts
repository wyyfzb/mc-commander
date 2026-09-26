import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'

/**
 * 站内帮助页 E2E（内容源：仓库根 docs/user-guide.md，构建期 `?raw` 内联）
 *
 * 为什么要有 e2e：单元测试跑在 jsdom 里，量不到真实几何，也证不了「构建产物里到底有没有
 * 这份文档」——`?raw` 跨包读取是构建期行为（dev 还需 vite server.fs.allow 放行），
 * 单测绿不代表产物里真有内容。这里在**真实构建产物**上断言正文可见。
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

test.describe('站内帮助', () => {
  test('侧栏「帮助」进入 /help，渲染仓库用户向导正文', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/dashboard')
    await page.getByRole('link', { name: /帮助/ }).click()
    await expect(page).toHaveURL(/\/help/)

    // 页头标题来自文档一级标题（会随文档改标题而红，那正是要的信号）
    await expect(
      page.getByRole('heading', { name: 'MC_Commander 用户向导', level: 2 }),
    ).toBeVisible()
    // 正文抽查：首尾各一处，证明确实是整份文档而不是页头空壳
    await expect(page.getByRole('heading', { name: /部署面板/ })).toBeVisible()
    // FAQ 末行：同一短语在「现象」列与「处理」列正文里都有，故断到**行**上
    // （`getByText` 会同时命中两格 → strict mode 报冲突）
    await expect(
      page
        .getByRole('table')
        .last()
        .getByRole('row', { name: /忘记管理员密码/ }),
    ).toBeVisible()
  })

  test('目录锚点原地跳转：标题进入视口（证锚点确实落在渲染出的标题上）', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/help')
    const heading = page.getByRole('heading', { name: /常见问题/ })
    // 首屏时「常见问题」在长文下方、不可见，点击目录链接后才进入视口
    await expect(heading).not.toBeInViewport()
    await page.getByRole('link', { name: '常见问题' }).click()
    await expect(heading).toBeInViewport()
  })

  test('表格渲染为真表格（不是纯文本排布）', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/help')
    const table = page.getByRole('table').first()
    await expect(table.getByRole('columnheader', { name: '方式' })).toBeVisible()
    await maybeShot(page, 'help-page.png')
  })

  test('命令面板可跳转帮助页（Ctrl+K 的发现路径与侧栏一致）', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/dashboard')
    // lazy chunk 首次编译期间键盘事件可能被吞：先等页面就绪再按键（同 smoke.spec.ts 的成因）
    await expect(page.getByText('E2E 演示实例').first()).toBeVisible()
    await page.keyboard.press('Control+k')
    await expect(page.getByPlaceholder('输入页面名称或命令…')).toBeVisible()
    await page.getByRole('option', { name: /帮助/ }).click()
    await expect(page).toHaveURL(/\/help/)
  })

  test('截图不渲染为坏图：以「截图见仓库文档」说明呈现', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/help')
    // 产物内没有 screenshots/（Release tarball 只打服务端 + 内联 mc-schemas），
    // 渲染 <img> 只会是坏图
    await expect(page.locator('#main-content img')).toHaveCount(0)
    await expect(page.getByText(/截图见仓库文档/).first()).toBeVisible()
  })
})
