import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'

/**
 * 文件页 E2E（数据源：scripts/mock-server.mjs，文件列表/内容为结构占位虚构数据）
 * 验收：三栏布局 / Monaco 编辑器打开+编辑+保存 / 目录导航+面包屑 / 删除确认 / 新建文件 / 视觉截图
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

test.describe('文件页', () => {
  test('双栏布局：文件列表 + 编辑器空态', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/files')
    // 就绪门：页面 chunk 是懒加载的，壳未挂载时下面的断言会把预算耗在「页还没到」上
    // （并行 worker 冷启动下偶发），先等外壳再断内容
    await expect(page.locator('#main-content')).toBeVisible({ timeout: 30_000 })
    // 目录树已移除（导航收敛到面包屑 + 上级按钮）
    await expect(page.getByRole('button', { name: '展开 实例根目录' })).toHaveCount(0)
    // 左栏文件列表（根目录 5 项）
    await expect(page.getByText('server.properties')).toBeVisible()
    await expect(page.getByText('whitelist.json')).toBeVisible()
    await expect(page.getByText('ops.json')).toBeVisible()
    // 右栏编辑器空态
    await expect(page.getByText('选择文件进行编辑')).toBeVisible()
    await maybeShot(page, 'files-two-column-dark.png')
  })

  /**
   * 编辑器「内联双栏 ↔ 全屏覆盖」按双栏区实宽切档（阈值 672px = 编辑器 w-45% 要 ≥320px）。
   * jsdom 不评估布局，阈值只能在这里锁。两条各锁一头：
   * - 767 视口：侧栏退化成抽屉，双栏区内容 743px ⇒ 必须双栏（改前被 <768 误判成全屏）
   * - 768 视口展开侧栏：双栏区内容仅 536px ⇒ 必须全屏（改前双栏只给 Monaco 241px）
   */
  test('编辑器按双栏区实宽切档：767 双栏、768 展开侧栏全屏', async ({ page }) => {
    await setupConnection(page)

    // 767：抽屉侧栏 ⇒ 内容 743px ≥ 672 ⇒ 双栏
    await page.setViewportSize({ width: 767, height: 900 })
    await page.goto('/files')
    await page.getByRole('button', { name: '选择文件 server.properties' }).click()
    await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 20_000 })
    const dual = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('main .shadow-mcs-card'))
      return {
        cardCount: cards.length,
        monacoW: Math.round(
          document.querySelector('.monaco-editor')!.getBoundingClientRect().width,
        ),
        // 全屏覆盖层的判据：Monaco 挂在 fixed 祖先下（侧栏抽屉遮罩同为 overlay 档 z 轴，
        // 但 Monaco 不在它的子树里，用 closest 不会误判）
        overlay: !!document.querySelector('.monaco-editor')?.closest('.fixed'),
      }
    })
    expect(dual.cardCount).toBe(2)
    expect(dual.overlay).toBe(false)
    // w-45% 且 ≥320px 才谈得上可用
    expect(dual.monacoW).toBeGreaterThanOrEqual(320)

    // 768：侧栏常显占 208px ⇒ 内容 536px < 672 ⇒ 全屏覆盖。
    // 等「main 里只剩文件列表一张卡」——内联编辑器那张 Card 卸载后 main 才减到 1 张，
    // 不能用「关闭编辑器」按钮可见来等：内联态也有这个按钮，断言会立刻通过而读到旧形态
    await page.setViewportSize({ width: 768, height: 900 })
    await expect(page.locator('main .shadow-mcs-card')).toHaveCount(1)
    // 全屏态的 Monaco 是重新挂载的（懒加载 chunk），要等它起来再量
    await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 20_000 })
    const full = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('main .shadow-mcs-card'))
      return {
        cardCount: cards.length,
        overlay: !!document.querySelector('.monaco-editor')?.closest('.fixed'),
      }
    })
    expect(full.overlay).toBe(true)
    expect(full.cardCount).toBe(1)

    // 两态都不得横向溢出
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBe(0)
  })

  test('点击文件打开 Monaco 编辑器 + 编辑保存', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/files')
    await page.getByRole('button', { name: '选择文件 server.properties' }).click()
    // Monaco 加载（本地打包 worker，等待放宽）
    await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText('UTF-8')).toBeVisible()
    await expect(page.locator('.view-lines').first()).toContainText('motd=E2E 演示服务器')
    // 编辑 → 脏标记出现（点击行视图聚焦编辑器后键盘输入；Monaco 隐藏 textarea 不接受直接点击）
    await page.locator('.view-lines').first().click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type('\n# e2e-edit-placeholder')
    await expect(page.getByText('未保存')).toBeVisible()
    // 保存 → server.properties 走文件编辑器通道 toast（与 PUT /properties 热改区分）
    await page.getByRole('button', { name: /保存/ }).click()
    await expect(page.getByText('文件已保存，部分属性需重启服务器后生效')).toBeVisible()
    await maybeShot(page, 'files-editor-dark.png')
  })

  test('目录导航 + 面包屑 + 删除确认取消', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/files')
    // 进入 world 目录（文件行/目录行均为 role=button）；URL 深链接 ?dir=
    await page.getByRole('button', { name: '打开目录 world' }).click()
    await expect(page.getByText('level.dat')).toBeVisible()
    await expect(page).toHaveURL(/dir=%2Fworld/)
    // 面包屑末级加粗
    await expect(page.locator('nav[aria-label="面包屑"]').getByText('world')).toBeVisible()
    // 删除确认：level.dat → 对话框 → 截图（覆盖 destructive 按钮/路径行视觉）→ 取消
    await page.getByRole('button', { name: '删除 level.dat' }).click()
    await expect(page.getByText('删除 level.dat？')).toBeVisible()
    await expect(page.getByText('/world/level.dat')).toBeVisible()
    await maybeShot(page, 'files-delete-confirm-dark.png')
    await page.getByRole('button', { name: '取消' }).click()
    await expect(page.getByText('删除 level.dat？')).toBeHidden()
    // 上级按钮回根目录
    await page.getByRole('button', { name: '上级目录' }).click()
    await expect(page.getByText('server.properties')).toBeVisible()
    await maybeShot(page, 'files-subdir-dark.png')
  })

  test('新建文件：对话框 → 创建 → 编辑器打开', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/files')
    await page.getByRole('button', { name: '新建文件' }).click()
    await page.getByRole('dialog').getByLabel('文件名').fill('test-notes.txt')
    await page.getByRole('button', { name: '创建' }).click()
    await expect(page.getByText('已创建文件 test-notes.txt')).toBeVisible()
    // 编辑器打开新文件（头部文件名；mock 内容回读）
    await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText('test-notes.txt').first()).toBeVisible()
    await maybeShot(page, 'files-new-file-dark.png')
  })
})
