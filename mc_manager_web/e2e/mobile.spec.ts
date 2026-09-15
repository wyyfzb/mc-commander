import { test, expect, type Page } from '@playwright/test'

/**
 * 移动端 E2E（viewport 375×812）
 * 验收：侧栏抽屉（汉堡开关/导航关闭）/ 顶栏搜索按钮窄屏可访问名 / 玩家表卡片态（C3）/ 桌面端响应式回归
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
})

/**
 * R19：375 宽下仪表盘右栏完全不可达。
 * 根因＝主栅格行 `min-h-0 flex-1` 在外层定高 flex 列里被收缩到 23.3px，行内
 * `flex-1` 的终端与 `<aside>` 一并塌陷（右栏只剩 3.6px、三张卡用户够不到）。
 *
 * 可达性判据用**视口相交**（三卡 `toBeInViewport({ ratio: 0.5 })` + 与 `innerHeight`
 * 的相交高度 > 0）：它直接断言「用户看得见」这一真实意图，并配合滚动后的公告输入框
 * 可交互断言。下方的盒子高度断言（`aside` 成块）**同样承重、勿删**——回退修法时实测
 * `aside` 为 343×0，高度断言与 `toBeVisible` 都会红；两条断言互补而非互相替代。
 */
test.describe('仪表盘右栏窄屏可达（R19）', () => {
  test.use({ viewport: { width: 375, height: 812 } })

  test('375px：右栏三卡可达且公告卡可交互', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/dashboard')

    const aside = page.getByTestId('dashboard-aside')
    await expect(aside).toBeVisible()
    // 右栏本体必须成块（塌陷时实测 343×3.6）
    const asideBox = await aside.boundingBox()
    expect(asideBox).not.toBeNull()
    expect(asideBox!.height).toBeGreaterThan(100)

    // 三张右栏卡在 375 下各自成块
    const titles = ['MC 时钟 · 世界控制', '最近备份', '公告发送']
    const heights: number[] = []
    for (const title of titles) {
      const heading = page.getByRole('heading', { name: title })
      await expect(heading).toBeVisible()
      const card = heading.locator('xpath=ancestor::section[1]')
      const box = await card.boundingBox()
      expect(box, `${title} 卡片无 box`).not.toBeNull()
      expect(box!.height, `${title} 卡片高度`).toBeGreaterThan(0)
      heights.push(box!.height)
    }
    // 三卡都成块（不只是最后一张把行撑开）
    for (const h of heights) expect(h).toBeGreaterThan(100)

    // 真正可达：逐卡滚到视野内并断言与视口有实际相交面积（裁剪掉时相交≈0）
    for (const title of titles) {
      const card = page.getByRole('heading', { name: title }).locator('xpath=ancestor::section[1]')
      await card.scrollIntoViewIfNeeded()
      await expect(card, `${title} 卡片未进入视口`).toBeInViewport({ ratio: 0.5 })
      const visible = await card.evaluate((el) => {
        const r = el.getBoundingClientRect()
        return Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0)
      })
      expect(visible, `${title} 视口内可见高度`).toBeGreaterThan(0)
    }

    // 滚动到公告卡：真正够得到并可用（塌陷时 #announcement-input 滚不出来）
    const input = page.getByLabel('公告内容')
    await input.scrollIntoViewIfNeeded()
    await expect(input).toBeVisible()
    await input.fill('窄屏可达性验证')
    await expect(page.getByRole('button', { name: '发送公告' })).toBeEnabled()

    // 页面不出现横向溢出（右栏 343 宽不把文档撑宽）
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }))
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth)

    // documentElement 拦不住 main 内部的横向溢出——`app-shell.tsx` 的 main 自带
    // `overflow-y-auto`，其 overflow-x 计算值为 auto ⇒ 内部溢出只体现在 main 自己身上
    const mainOverflow = await page
      .locator('#main-content')
      .evaluate((el) => el.scrollWidth - el.clientWidth)
    expect(mainOverflow).toBeLessThanOrEqual(0)
  })
})

/**
 * 仪表盘首屏高度预算（页头紧凑化）：页头必须单行，终端可见高度不得退回旧值。
 * 口径用「页头高 ≤ 页头标题行高的 1.2 倍」——描述换行回标题下方时会立刻翻倍。
 */
test.describe('仪表盘首屏高度预算（1440×900）', () => {
  test('页头单行 + 终端可见高度 ≥ 400px', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await setupConnection(page)
    await page.goto('/dashboard')
    await expect(page.getByTestId('server-terminal')).toBeVisible()

    const header = await page.locator('main header').first().evaluate((el) => {
      const h2 = el.querySelector('h2')
      return {
        height: el.getBoundingClientRect().height,
        titleLineHeight: h2 ? parseFloat(getComputedStyle(h2).lineHeight) : 0,
      }
    })
    expect(header.titleLineHeight).toBeGreaterThan(0)
    expect(header.height).toBeLessThanOrEqual(header.titleLineHeight * 1.2 + 2)

    // 终端可见高度（页头/顶排卡占位偏高时会掉到 388px 附近）
    const terminal = await page.getByTestId('server-terminal').boundingBox()
    expect(terminal).not.toBeNull()
    expect(terminal!.height).toBeGreaterThanOrEqual(400)

    // 顶排三卡紧凑档：内距 12px（紧凑卡档），改回 p-4 时终端高度断言同时变红
    const cardPadding = await page
      .getByRole('heading', { name: '资源使用' })
      .locator('xpath=ancestor::section[1]')
      .evaluate((el) => getComputedStyle(el).padding)
    expect(cardPadding).toBe('12px')
  })
})

/**
 * 玩家表响应式（J28 形态由实测决定：<1256px 视口下 10 列合计约 1016px 会横向溢出，
 * 表格横向滚动把勾选框与玩家名推出视野 → 中窄屏裁列、<640px 转卡片）
 */
async function playerTableOverflow(page: Page) {
  return page.getByRole('table').evaluate((el) => {
    const scroller = el.parentElement!
    return { scrollWidth: scroller.scrollWidth, clientWidth: scroller.clientWidth }
  })
}

test.describe('玩家表中窄屏：裁到核心列（J28）', () => {
  for (const width of [1024, 768]) {
    test(`${width}px：核心列齐全、次级列不渲染、无横向滚动`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await setupConnection(page)
      await page.goto('/players')

      await expect(page.getByRole('columnheader', { name: '玩家' })).toBeVisible()
      await expect(page.getByRole('columnheader', { name: '状态' })).toBeVisible()
      for (const label of ['模式', '维度', '坐标', '延迟', '在线时长', '总时长']) {
        await expect(page.getByRole('columnheader', { name: label })).toHaveCount(0)
      }

      const { scrollWidth, clientWidth } = await playerTableOverflow(page)
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth)

      // 勾选框与玩家名在视口内（不需要横向滚动才够得着）
      const checkbox = await page.getByRole('checkbox', { name: '选择 Steve' }).boundingBox()
      expect(checkbox).not.toBeNull()
      expect(checkbox!.x).toBeGreaterThanOrEqual(0)
      expect(checkbox!.x + checkbox!.width).toBeLessThanOrEqual(width)
      await expect(page.getByRole('button', { name: '查看 Steve 详情' })).toBeVisible()
    })
  }

  test('1280px：完整 10 列（响应式不收窄宽屏）', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await setupConnection(page)
    await page.goto('/players')
    for (const label of ['玩家', '模式', '维度', '坐标', '状态', '延迟', '在线时长', '总时长']) {
      await expect(page.getByRole('columnheader', { name: label })).toBeVisible()
    }
  })
})

test.describe('玩家表窄屏：行式卡片（C3）', () => {
  test.use({ viewport: { width: 375, height: 812 } })

  test('375px：表格转卡片，勾选/全选/操作菜单可用且页面无横向溢出', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/players')

    // 375px 下表格必然横向溢出（10 列约 1016px），改为一行一卡
    await expect(page.getByRole('table')).toHaveCount(0)
    const card = page.getByRole('listitem').filter({ hasText: 'Steve' }).first()
    await expect(card).toBeVisible()
    await expect(card.getByRole('checkbox', { name: '选择 Steve' })).toBeVisible()
    // 表头消失后全选入口仍在（与表格表头同标签）
    await expect(page.getByRole('checkbox', { name: '全选当前页' })).toBeVisible()
    // 小字标签：封禁剩余时间等长文本在卡片里完整可读
    await expect(page.getByText(/封禁·剩/)).toBeVisible()

    // 卡片态与表格共用同一套操作菜单
    await page.getByRole('button', { name: 'Steve 操作菜单' }).click()
    await expect(page.getByRole('menuitem', { name: '详情' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: '取消 OP' })).toBeVisible()

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }))
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth)
  })

  /**
   * 375 下筛选条计数「5 / 5 名玩家」曾被压成逐字竖排（CJK 断行点落在任意字符间）。
   * 修法是 `whitespace-nowrap` **且**容器 `flex-wrap`——只锁 nowrap 会让筛选条的
   * min-content 变成「计数 + 三个按钮」之和，把主区撑出横向溢出。
   */
  test('375px：筛选条计数不折成竖排，筛选条与主区均无横向溢出', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/players')

    const count = page.getByText(/\d+ \/ \d+ 名玩家/)
    await expect(count).toBeVisible()
    const metrics = await count.evaluate((el) => {
      const cs = getComputedStyle(el)
      return {
        height: el.getBoundingClientRect().height,
        lineHeight: parseFloat(cs.lineHeight),
        whiteSpace: cs.whiteSpace,
      }
    })
    // 竖排时实测为 6 行高；单行必须 ≤ 1.5 倍行高（先断症状，再断机制）
    expect(metrics.height).toBeLessThanOrEqual(metrics.lineHeight * 1.5)
    expect(metrics.whiteSpace).toBe('nowrap')

    // 筛选条自身（重置按钮的父节点即筛选条根）不得横向溢出
    const barOverflow = await page
      .getByRole('button', { name: '重置筛选' })
      .locator('xpath=..')
      .evaluate((el) => el.scrollWidth - el.clientWidth)
    expect(barOverflow).toBeLessThanOrEqual(0)

    const mainOverflow = await page
      .locator('#main-content')
      .evaluate((el) => el.scrollWidth - el.clientWidth)
    expect(mainOverflow).toBeLessThanOrEqual(0)
  })
})
