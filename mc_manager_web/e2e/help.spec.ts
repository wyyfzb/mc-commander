import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'

/**
 * 帮助中心 E2E（数据源：仓库根 docs/user-guide.md 构建期 `?raw` 内联 + scripts/mock-server.mjs）
 *
 * 两条腿：
 * ① **使用向导**：文档是构建期内联的（跨包 `?raw` + dev 的 `server.fs.allow` 都是构建期行为），
 *    单测绿不代表产物里真有内容 ⇒ 在真实构建产物上断言正文可见。
 * ② **排障**：三段（自检 / 崩溃历史 / 面板自身错误）里有两件**只有浏览器才测得到**的事——
 *    页内出路是真锚点（路由 pushState 只改地址栏、不滚动），以及崩溃历史点开一条会加载那份的
 *    完整诊断、已被清理的那条如实说「已不在」。
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
  // 声明自己的 WS 分组：并行 spec 触发的广播/通知不打进来（本 spec 断言不依赖通知态）
  await page.setExtraHTTPHeaders({ 'x-mock-ws-group': 'help' })
}

/** 切到「使用向导」标签：文档只在那个标签页挂载（默认停在排障） */
async function openGuide(page: Page) {
  await page.goto('/help')
  await page.getByRole('tab', { name: '使用向导' }).click()
}

test.describe('站内帮助·使用向导', () => {
  test('侧栏「帮助」进入 /help，切到使用向导渲染仓库用户向导正文', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/dashboard')
    await page.getByRole('link', { name: /帮助/ }).click()
    await expect(page).toHaveURL(/\/help/)

    // 页头是页面自己的名字（帮助中心罩住两个标签）；默认落在排障
    await expect(page.getByRole('heading', { name: '帮助中心' })).toBeVisible()
    await expect(page.getByRole('heading', { name: '自检' })).toBeVisible()

    await page.getByRole('tab', { name: '使用向导' }).click()
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
    await openGuide(page)
    const heading = page.getByRole('heading', { name: /常见问题/ })
    // 首屏时「常见问题」在长文下方、不可见，点击目录链接后才进入视口
    await expect(heading).not.toBeInViewport()
    await page.getByRole('link', { name: '常见问题' }).click()
    await expect(heading).toBeInViewport()
  })

  test('表格渲染为真表格（不是纯文本排布）', async ({ page }) => {
    await setupConnection(page)
    await openGuide(page)
    const table = page.getByRole('table').first()
    await expect(table.getByRole('columnheader', { name: '方式' })).toBeVisible()
    await maybeShot(page, 'help-guide.png')
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
    await openGuide(page)
    // 产物内没有 screenshots/（Release tarball 只打服务端 + 内联 mc-schemas），
    // 渲染 <img> 只会是坏图
    await expect(page.locator('#main-content img')).toHaveCount(0)
    await expect(page.getByText(/截图见仓库文档/).first()).toBeVisible()
  })
})

test.describe('站内帮助·排障', () => {
  test('自检：有事的项在前，正常项默认折叠、展开后才进 DOM', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/help')

    // 「运行中」在侧栏状态行等处也有 ⇒ 断言限定在自检卡内
    const check = page.getByTestId('self-check')
    // mock 里唯一需要注意的项是「面板自身错误 记录 2 条」（崩溃记录在 24 小时窗口外 ⇒ 正常）
    await expect(check.getByText('记录 2 条')).toBeVisible()
    await expect(check.getByText('运行中')).toHaveCount(0)

    await check.getByRole('button', { name: /其余 \d+ 项正常/ }).click()
    await expect(check.getByText('运行中')).toBeVisible()
  })

  test('自检的出路是可用的页内锚点：点了目标真的进视口', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/help')

    const target = page.locator('#panel-errors')
    await expect(target).not.toBeInViewport()

    await page.getByRole('link', { name: '看错误列表' }).click()

    // 只断言 hash 会漏掉「点了不滚动」这个真缺陷（路由 pushState 就只改地址栏）
    await expect(page).toHaveURL(/#panel-errors$/)
    await expect(target).toBeInViewport()
  })

  test('崩溃历史：默认看最新那份的完整诊断，点已被清理的那条如实说「已不在」', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/help')

    const history = page.locator('#crash-history')
    // 默认选中最新一条（crash-report）⇒ 下方给出完整诊断卡
    await expect(history.locator('button[aria-current="true"]')).toContainText(
      'crash-2026-10-07_09-14-02-server.txt',
    )
    await expect(page.getByRole('heading', { name: '崩溃报告' })).toBeVisible()
    await expect(page.getByText('这次崩溃不在已知词条里')).toBeVisible()

    // 第二条（hs_err）在 mock 里已被「清理」：选取它要如实说明，且不悄悄换成最新那份
    await history.getByText(/hs_err_pid2601333\.log/).click()
    await expect(page.getByText(/已不在（日志轮转/)).toBeVisible()
    await expect(page.getByRole('heading', { name: '崩溃报告' })).toHaveCount(0)
    await maybeShot(page, 'help-diagnose.png')
  })

  test('面板自身错误：条目、级别、日志路径与复制入口都在', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/help')

    const errors = page.locator('#panel-errors')
    await expect(errors.getByText(/升级实例失败/)).toBeVisible()
    await expect(errors.getByText('ERROR').first()).toBeVisible()
    await expect(errors.getByText(/日志文件：/)).toBeVisible()
    await expect(errors.getByRole('button', { name: '复制面板错误日志' })).toBeVisible()
  })
})
