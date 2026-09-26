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

/**
 * 长目录虚拟滚动：行高恒定、少渲染、滚动连续，以及截断时的如实提示。
 *
 * 缺口由来：mock 根目录只有 5 条，「条目多于一屏」的形态结构性不可达——
 * 虚拟滚动的 estimateSize 前提（行高恒等）此前从未被实测。
 * 夹具策略：在路由层放大既有 mock 响应，**不改 mock-server 的数据规模**
 * （改 mock 会连带影响既有 spec 的文件名断言）。
 * jsdom 无布局引擎（滚动容器恒 0 高）、也不评估行高，故只能在 e2e 锁。
 *
 * 行高常量在此**重复声明**而不从组件导入：e2e 的职责是独立见证真实渲染几何，
 * 与实现共用常量会把「改常量忘改样式」这类漂移一起放行（本项正是这么被发现的：
 * estimateSize 声明 40 而实高 42.39，逐行错位累积 290px、列表尾部滚不到）。
 */
const ROW_HEIGHT = 44
const FILE_TOTAL = 120

async function injectLongFileList(page: Page, truncated = false) {
  await page.route('**/api/v1/instances/*/files*', async (route) => {
    const url = route.request().url()
    // 只放大列表端点，不碰 content/upload
    if (!/\/files(\?|$)/.test(url)) return route.continue()
    const response = await route.fetch()
    const body = await response.json()
    const one = body.data?.files?.[0]
    if (!one) return route.fulfill({ response })
    const files = Array.from({ length: FILE_TOTAL }, (_, i) => ({
      ...one,
      name: `fixture-${String(i).padStart(4, '0')}.txt`,
      path: `/fixture-${String(i).padStart(4, '0')}.txt`,
      isDirectory: false,
      type: 'file',
      size: 1024,
    }))
    await route.fulfill({
      response,
      json: { ...body, data: { ...body.data, files, ...(truncated ? { truncated: true } : {}) } },
    })
  })
}

test.describe('文件页 长目录虚拟滚动', () => {
  /* 夹具路由是**异步改写响应**（route.fetch 再 fulfill），用例结束时若还有请求在飞，
     Playwright 会以「route.fetch: Test ended」报错——那是收尾竞态、不是断言失败，
     在满载（并行跑全量门禁）时尤其容易撞上。收尾统一解绑并吞掉在途错误。 */
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  })

  test('120 条：行高恒定、只渲染视口内的行、末项滚得到', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await setupConnection(page)
    await injectLongFileList(page)
    await page.goto('/files')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(600)

    const snap = () =>
      page.evaluate(() => {
        const box = document.querySelector('main .overflow-y-auto') as HTMLElement | null
        // 行走容器范围内的 role=button（面包屑不在滚动容器内，天然排除）
        const rows = box ? [...box.querySelectorAll<HTMLElement>('[role="button"]')] : []
        const last = rows[rows.length - 1]
        const boxRect = box?.getBoundingClientRect()
        const lastRect = last?.getBoundingClientRect()
        const tops = rows.map((r) => Math.round(r.getBoundingClientRect().top))
        return {
          clientH: box?.clientHeight ?? 0,
          scrollH: box?.scrollHeight ?? 0,
          scrollTop: Math.round(box?.scrollTop ?? 0),
          maxScroll: box ? box.scrollHeight - box.clientHeight : 0,
          rendered: rows.length,
          firstLabel: rows[0]?.getAttribute('aria-label') ?? null,
          lastLabel: last?.getAttribute('aria-label') ?? null,
          /** 行高去重集：虚拟滚动 estimateSize 的前提是恒等于 ROW_HEIGHT */
          rowHeights: [...new Set(rows.map((r) => Math.round(r.getBoundingClientRect().height)))],
          /** 相邻行间距去重集：唯一能抓「行实高 ≠ estimateSize」的观测量（错位由此累积） */
          rowPitch: [...new Set(tops.slice(1).map((t, i) => t - tops[i]))],
          /** 末行底边与容器底边的间距：≈0 即尾部无留白、末项够得着 */
          tailGap: boxRect && lastRect ? Math.round(boxRect.bottom - lastRect.bottom) : null,
          /** 行内文本块实高与行高之差：行盒被 height 钉死后，字号/内距改大了
              只会让内容溢出（文字压到下一行），行高本身量不出问题——故单独量内容。 */
          contentOverflow: rows.map((r) => {
            const inner = r.querySelector('div')
            return inner ? Math.round(inner.getBoundingClientRect().height - r.clientHeight) : 0
          }),
        }
      })

    const top = await snap()
    // 虚拟化生效：渲染行数远少于总数（否则 120 行全进 DOM）
    expect(top.rendered).toBeGreaterThan(0)
    expect(top.rendered).toBeLessThan(FILE_TOTAL)
    // 行高与行距恒等 —— estimateSize 的前提；两者都必须等于声明值
    expect(top.rowHeights).toEqual([ROW_HEIGHT])
    expect(top.rowPitch).toEqual([ROW_HEIGHT])
    // 撑起的高度必须恰为「条数 × 行高」：少了就有内容落在可滚范围之外
    expect(top.scrollH).toBe(FILE_TOTAL * ROW_HEIGHT)
    expect(top.scrollH).toBeGreaterThan(top.clientH)
    /* 内容必须装得进行盒（≤0 表示未溢出）。行盒被 height 钉死后，把字号/内距改大会
       表现为内容溢出而不是行高变化——只看行高放行这类改动，故补这一条。 */
    expect(Math.max(...top.contentOverflow)).toBeLessThanOrEqual(0)

    // 滚到底：末项必须真的可见且贴容器底边（错位累积时最后若干条滚不到）
    await page.evaluate(() => {
      const box = document.querySelector('main .overflow-y-auto')
      if (box) box.scrollTop = box.scrollHeight
    })
    await expect
      .poll(async () => {
        const s = await snap()
        return (
          Math.abs(s.maxScroll - s.scrollTop) <= 1 && s.tailGap !== null && Math.abs(s.tailGap) <= 4
        )
      })
      .toBe(true)
    const bottom = await snap()
    expect(bottom.lastLabel).toBe(`选择文件 fixture-${String(FILE_TOTAL - 1).padStart(4, '0')}.txt`)
    expect(bottom.rowHeights).toEqual([ROW_HEIGHT])
    expect(bottom.rowPitch).toEqual([ROW_HEIGHT])
    expect(bottom.firstLabel).not.toBe(top.firstLabel)

    // 滚回顶部：首行与初次一致（滚动连续性）
    await page.evaluate(() => {
      const box = document.querySelector('main .overflow-y-auto')
      if (box) box.scrollTop = 0
    })
    await expect.poll(async () => (await snap()).firstLabel).toBe(top.firstLabel)
  })

  test('服务端回报 truncated 时如实提示（少列了不能读成没有了）', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await setupConnection(page)
    await injectLongFileList(page, true)
    await page.goto('/files')
    await page.waitForLoadState('networkidle')

    await expect(page.getByText(/条目过多，仅显示前/)).toBeVisible()
  })

  test('未截断时不出现截断提示（提示不能常驻）', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await setupConnection(page)
    await injectLongFileList(page, false)
    await page.goto('/files')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(400)

    // 就绪门：列表没加载出来时「找不到横幅」同样成立——先证明列表真的在，
    // 再断言横幅缺席（否则请求失败/夹具失效都会假绿）
    await expect(page.getByRole('button', { name: '选择文件 fixture-0000.txt' })).toBeVisible()
    await expect(page.getByText(/条目过多，仅显示前/)).toHaveCount(0)
  })
})
