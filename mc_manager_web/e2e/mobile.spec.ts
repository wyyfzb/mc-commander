import { test, expect, type Page } from '@playwright/test'

/**
 * 移动端 E2E（viewport 375×812）
 * 验收：侧栏抽屉（汉堡开关/导航关闭）/ 顶栏搜索按钮窄屏可访问名 / 玩家表卡片态 / 桌面端响应式回归
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

/**
 * 侧栏「收起」态跨断点回归：桌面 sidebarCollapsed 只属于桌面侧栏（w-14 图标态），
 * 抽屉是 256px 浮层、不占布局宽 ⇒ 没有收起语义，恒按展开态渲染。
 * 曾把 nav 片段的 collapsed 直接复用到抽屉：桌面收起后拖窄窗口再开抽屉，
 * 只剩图标 + 实例迷你卡被条件卸载——窄屏下导航直接不可读。
 */
test.describe('侧栏收起态跨断点', () => {
  test('桌面收起侧栏后拖窄到移动端：抽屉仍按展开态渲染', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/dashboard')
    // 桌面：收起侧栏（w-14 图标态）
    await page.getByRole('button', { name: '收起侧栏' }).click()
    await expect(page.getByRole('complementary', { name: '主导航' })).toHaveClass(/\bw-14\b/)

    // 拖窄到移动端 → 桌面侧栏退出布局，抽屉接管
    await page.setViewportSize({ width: 375, height: 812 })
    await page.getByRole('button', { name: '打开导航菜单' }).click()
    const drawer = page.getByRole('complementary', { name: '主导航（移动端）' })
    await expect(drawer).toBeVisible()

    // 展开态链接：带文字（非居中图标化）
    const link = drawer.getByRole('link', { name: '玩家' })
    await expect(link).not.toHaveCSS('justify-content', 'center')
    await expect(link).toHaveCSS('padding-left', '10px')
    const label = drawer.locator('a[href="/players"] > span')
    await expect(label).toBeVisible()
    await expect(label).toHaveCSS('opacity', '1')
    await expect(label).toHaveCSS('max-width', '112px')

    // 实例迷你卡随展开态一并渲染（收起态会被条件卸载）
    await expect(drawer.getByText('E2E 演示实例')).toBeVisible()
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
test.describe('仪表盘右栏窄屏可达', () => {
  test.use({ viewport: { width: 375, height: 812 }, reducedMotion: 'reduce' })

  test('375px：右栏三卡可达且公告卡可交互', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/dashboard')
    // 就绪门：本用例量的是盒子高度与视口相交（**不可重试**断言），须等外壳挂载、字体就位
    // 与异步内容落定——挂载未完成时主栅格高度还在变、字体回退会改字形盒与行高、右栏卡从
    // Skeleton 换数据时高度也会变，量早会读到未完成布局（同 dashboard.spec 的字体范式）。
    // 本 describe 关掉动效：`mcs-fade-up` 的 opacity/translate 会让盒子在动画期间偏移 10px，
    // 而 Playwright 的 visible 判定不排除 opacity:0；reduced-motion 是应用自身的降级路径
    // （index.css 全局归零 duration），不是伪造状态。
    await expect(page.getByTestId('server-terminal')).toBeVisible({ timeout: 30_000 })
    await page.evaluate(() => document.fonts.ready)
    await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0)

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
    // 量几何前等字体就位：字体回退会让字形盒与行高变化，终端高度会读到未完成布局的假值
    await page.evaluate(() => document.fonts.ready)

    const header = await page
      .locator('main header')
      .first()
      .evaluate((el) => {
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

  /**
   * 断点口径回归锁：仪表盘栅格按**容器内容宽**切档（`@container` + `@2xl`/`@5xl`），
   * 不是视口断点。jsdom 不评估容器查询，这层只能在这里锁——1280/1366 是笔记本常见尺寸，
   * 且侧栏默认展开（容器 = 视口 − 208 − 32 = 1040/1126，均 ≥ @5xl=1024）。
   * 退回视口断点（`xl`=1280）会让 1280–1391 带内丢掉三列与分栏。
   */
  test('1280×800：顶卡三列同行 + 终端与右栏并排（容器查询档位不回退）', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await setupConnection(page)
    await page.goto('/dashboard')
    await expect(page.getByTestId('server-terminal')).toBeVisible()
    await page.evaluate(() => document.fonts.ready)

    // 列数读计算后的 grid-template-columns（不受顶卡 animate-mcs-fade-up 的位移影响，
    // 用 getBoundingClientRect().top 去重会在入场动画期间抖出假值）
    const topCols = await page
      .getByRole('heading', { name: '资源使用' })
      .locator('xpath=ancestor::section[1]/parent::*')
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns.trim().split(/\s+/).length)
    expect(topCols).toBe(3)

    // 右栏在终端右侧而非其下方（x 轴不受入场动画影响）
    const terminal = await page.getByTestId('server-terminal').boundingBox()
    const aside = await page.getByTestId('dashboard-aside').boundingBox()
    expect(terminal).not.toBeNull()
    expect(aside).not.toBeNull()
    expect(aside!.x).toBeGreaterThanOrEqual(terminal!.x + terminal!.width)
  })
})

/**
 * 玩家表响应式（形态由表格区实宽决定：10 列合计约 1016px，装不下就裁到核心四列；
 * <640px 视口转卡片）。判据取表格区实宽而非视口——侧栏折叠使同视口下内容宽差 152px，
 * 详情面板内联还会再借走 420px，视口断点会把「装得下 10 列」的宽度误判成裁列。
 * jsdom 不评估布局，故这些阈值只能在这里锁（几何断言）
 */
async function playerTableOverflow(page: Page) {
  return page.getByRole('table').evaluate((el) => {
    const scroller = el.parentElement!
    return { scrollWidth: scroller.scrollWidth, clientWidth: scroller.clientWidth }
  })
}

test.describe('玩家表中窄屏：裁到核心列', () => {
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

      // 勾选框与玩家名在视口内（不需要横向滚动才够得着）
      // 行数据是异步的：表头随骨架先挂载，行要等查询返回。先等目标行可见再取盒——
      // 全量并行 8 worker 争抢时会落进「表头可见、行未挂载」的窗口，直接取盒会拿到 null
      await expect(page.getByRole('checkbox', { name: '选择 Steve' })).toBeVisible()

      // 溢出量也必须在行挂载后量：骨架行的列宽与真实行不同，行未到位时量到的
      // scrollWidth 会瞬态超出 clientWidth（并行争抢下实测 812 vs 782 的假红）
      const { scrollWidth, clientWidth } = await playerTableOverflow(page)
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth)

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

  /**
   * 阈值 FULL_COLUMNS_MIN_WIDTH=1016 的下方括号：1240 视口展开侧栏 ⇒ 表格区
   * 1240−208−32=1000px，差 16px 不到全列线，必须仍是核心列。
   * 与上方括号（1280 ⇒ 1040px 全列）合起来把 1016 夹住——阈值往下漂到
   * (860, 1016) 区间时，原先只有溢出断言兜底、且要等表格真溢出才红；
   * 这条在阈值越界的当口就红，不必等布局烂掉。
   */
  test('1240px + 展开侧栏：表格区 1000px 仍裁到核心列（阈值下方括号）', async ({ page }) => {
    await page.setViewportSize({ width: 1240, height: 900 })
    await setupConnection(page)
    await page.goto('/players')
    await expect(page.getByRole('columnheader', { name: '玩家' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: '状态' })).toBeVisible()
    for (const label of ['模式', '维度', '坐标', '延迟', '在线时长', '总时长']) {
      await expect(page.getByRole('columnheader', { name: label })).toHaveCount(0)
    }
    await expect(page.getByRole('checkbox', { name: '选择 Steve' })).toBeVisible()
    const { scrollWidth, clientWidth } = await playerTableOverflow(page)
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth)
  })

  /**
   * 折叠侧栏后表格区从 1039 涨到 1191px（同视口下内容宽 +152px）：
   * 改前 ≤1279 视口一律裁列，1191px 明明装得下 10 列却只给 4 列。
   * 改后判据是表格区实宽 ≥1016px ⇒ 全列。这条锁的就是「折叠侧栏不该丢列」
   */
  test('1279px + 折叠侧栏：表格区 1191px 仍拿全 10 列（不因视口差 1px 裁列）', async ({ page }) => {
    await page.setViewportSize({ width: 1279, height: 900 })
    await setupConnection(page)
    await page.goto('/players')
    await expect(page.getByRole('columnheader', { name: '玩家' })).toBeVisible()

    await page.getByRole('button', { name: '收起侧栏' }).click()
    await expect(page.getByRole('button', { name: '展开侧栏' })).toBeVisible()

    for (const label of ['玩家', '模式', '维度', '坐标', '状态', '延迟', '在线时长', '总时长']) {
      await expect(page.getByRole('columnheader', { name: label })).toBeVisible()
    }
    const { scrollWidth, clientWidth } = await playerTableOverflow(page)
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth)
  })

  /**
   * 详情面板内联会借走表格区 420px：1280 视口开面板后表格区只剩 620px，
   * 必须裁列（否则 10 列横向滚动把勾选框推出视野）。锁「开面板自动裁列」
   */
  test('1280px + 详情面板内联：表格区 620px 裁到核心列（不横向溢出）', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await setupConnection(page)
    await page.goto('/players')
    await page.getByRole('button', { name: '查看 Steve 详情' }).first().click()

    // 内联右栏（容器 1040 ≥ 900），不是 Sheet
    await expect(page.getByRole('complementary', { name: '玩家详情面板' })).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    for (const label of ['模式', '维度', '坐标', '延迟', '在线时长', '总时长']) {
      await expect(page.getByRole('columnheader', { name: label })).toHaveCount(0)
    }
    const { scrollWidth, clientWidth } = await playerTableOverflow(page)
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth)
  })

  /**
   * 容器 900–1023px 时面板仍内联（≥900），但表格区已被压到 480–603px：
   * 这是内联的下限带，裁列后刚好不溢出。低于 900 改走 Sheet（下一条锁）
   */
  test('1156px：容器 916px 仍内联 + 表格区 496px 裁列不溢出', async ({ page }) => {
    await page.setViewportSize({ width: 1156, height: 900 })
    await setupConnection(page)
    await page.goto('/players')
    await page.getByRole('button', { name: '查看 Steve 详情' }).first().click()

    await expect(page.getByRole('complementary', { name: '玩家详情面板' })).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('columnheader', { name: '玩家' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: '状态' })).toBeVisible()
    for (const label of ['模式', '维度', '坐标', '延迟', '在线时长', '总时长']) {
      await expect(page.getByRole('columnheader', { name: label })).toHaveCount(0)
    }
    const { scrollWidth, clientWidth } = await playerTableOverflow(page)
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth)
  })

  /**
   * 容器 <900px（视口 1100 展开侧栏 ⇒ 内容 860px）时面板改 Sheet 全屏承载：
   * 内联会把表格压到 440px 以下。锁「窄容器转 Sheet + 表格恢复全宽」
   */
  test('1100px：容器 860px 详情走 Sheet，表格吃满内容宽', async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 900 })
    await setupConnection(page)
    await page.goto('/players')
    await page.getByRole('button', { name: '查看 Steve 详情' }).first().click()

    await expect(page.getByRole('dialog', { name: /Steve 详情/ })).toBeVisible()
    // Sheet 形态的判据是「面板挂在 dialog 子树里」——aside 元素两种形态都渲染
    // （variant 只换外层容器），数它为 0 会误判
    const inDialog = await page.evaluate(() => {
      const aside = document.querySelector("aside[aria-label='玩家详情面板']")
      const dialog = document.querySelector('[role="dialog"]')
      return !!aside && !!dialog && dialog.contains(aside)
    })
    expect(inDialog).toBe(true)

    // 表格在 Sheet 背后被 aria-modal 置为 inert，角色查询不可见 ⇒ 用 CSS 定位 +
    // evaluate 量几何（不依赖可访问性可见性）
    const table = page.locator('main table')
    await table.waitFor({ state: 'attached' })
    const geom = await table.evaluate((el) => {
      const scroller = el.parentElement!
      return {
        scrollWidth: scroller.scrollWidth,
        clientWidth: scroller.clientWidth,
        tableW: scroller.clientWidth,
      }
    })
    expect(geom.scrollWidth).toBeLessThanOrEqual(geom.clientWidth)
    // 表格吃满内容宽（面板移入 Sheet 后不再借走 420px）
    expect(geom.tableW).toBeGreaterThanOrEqual(848)
  })
})

test.describe('玩家表窄屏：行式卡片', () => {
  test.use({ viewport: { width: 375, height: 812 } })

  test('375px：表格转卡片，勾选/全选/操作菜单可用且页面无横向溢出', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/players')

    // 375px 下表格必然横向溢出（10 列约 1016px），改为一行一卡
    await expect(page.getByRole('table')).toHaveCount(0)
    const card = page.getByRole('listitem').filter({ hasText: 'Steve' }).first()
    await expect(card).toBeVisible()
    await expect(card.getByRole('checkbox', { name: '选择 Steve' })).toBeVisible()
    // 勾选框与 36px 头像共享中线（修复前实测差 6px）；表格态靠单元格 align-middle
    // 天然对齐，卡片态没有这层，故中线只能在浏览器里量（jsdom 无布局引擎）
    const avatarLine = await card.evaluate((li) => {
      const cb = li.querySelector('[role="checkbox"]')!.getBoundingClientRect()
      const avatar = li.querySelector('img')!.getBoundingClientRect()
      return {
        checkbox: cb.top + cb.height / 2,
        avatar: avatar.top + avatar.height / 2,
      }
    })
    expect(Math.abs(avatarLine.checkbox - avatarLine.avatar)).toBeLessThanOrEqual(1)
    // 表头消失后全选入口仍在（与表格表头同标签）
    await expect(page.getByRole('checkbox', { name: '全选当前页' })).toBeVisible()
    // 小字标签：封禁剩余时间等长文本在卡片里完整可读
    await expect(page.getByText(/封禁·剩/)).toBeVisible()

    /**
     * 字号档与估算行高（Charlie 离线 ⇒ 摘要行单行；封禁徽标约 55px，窄于姓名行不把它挤折，
     * 故卡高可判）：姓名 14px/semibold、摘要 12px（与表格同名字段同档，中文不得落到 2xs）、
     * 徽标 10px（角标，2xs 的允许面）。68 须与 CARD_HEIGHT 一致——它是虚拟滚动估值，
     * 卡片内边距或字号一变就要同步，此处是唯一的几何校验点。
     */
    const charlie = page.getByRole('listitem').filter({ hasText: 'Charlie' }).first()
    await expect(charlie.getByRole('button', { name: '查看 Charlie 详情' })).toHaveCSS(
      'font-size',
      '14px',
    )
    await expect(charlie.getByRole('button', { name: '查看 Charlie 详情' })).toHaveCSS(
      'font-weight',
      '600',
    )
    await expect(charlie.getByText(/^最后在线/)).toHaveCSS('font-size', '12px')
    await expect(charlie.getByText(/封禁·剩/)).toHaveCSS('font-size', '10px')
    const singleLineCardH = await charlie.evaluate((li) =>
      Math.round(li.getBoundingClientRect().height),
    )
    expect(singleLineCardH).toBe(68)

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

/**
 * 插件页窄屏（owner 实测报「页头布局混乱 + 批量选择框在行内没有居中」）。
 *
 * 页头：操作区四个按钮合计 349px 且不可收缩，与标题同排时把标题列挤到 40px——
 * 「插件管理」逐字竖排四行。判据同玩家页筛选条那条：单行高度 ≤ 1.5 倍行高（先断症状），
 * 再加标题宽度下界（被挤扁时实测 40px，正常约 88px）。
 * 说明句虽已移入浮层，仍断言它不常驻可见行、且入口能读到全文（信息不丢）。
 *
 * 选择框：与行首 36px 图标块共享中线（修复前实测相差 8px），中线用真实 rect 计算——
 * jsdom 无布局引擎，这条只能在浏览器里量。
 */
test.describe('插件页窄屏：页头不挤压 + 选择框中线', () => {
  test.use({ viewport: { width: 375, height: 812 } })

  test('375px：标题单行、说明入浮层、选择框与图标同中线、无横向溢出', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/plugins')

    const title = page.getByRole('heading', { name: '插件管理' })
    await expect(title).toBeVisible()
    const titleMetrics = await title.evaluate((el) => {
      const rect = el.getBoundingClientRect()
      return {
        width: rect.width,
        height: rect.height,
        lineHeight: parseFloat(getComputedStyle(el).lineHeight),
      }
    })
    expect(titleMetrics.lineHeight).toBeGreaterThan(0)
    expect(titleMetrics.height).toBeLessThanOrEqual(titleMetrics.lineHeight * 1.5)
    expect(titleMetrics.width).toBeGreaterThan(80)

    // 计数留在描述行，且不折成竖排
    const count = page.getByText(/共 \d+ 个（启用 \d+ \/ 禁用 \d+）/)
    await expect(count).toBeVisible()
    const countMetrics = await count.evaluate((el) => ({
      height: el.getBoundingClientRect().height,
      lineHeight: parseFloat(getComputedStyle(el).lineHeight),
    }))
    expect(countMetrics.height).toBeLessThanOrEqual(countMetrics.lineHeight * 1.5)

    // 说明句不常驻；点信息入口才读到全文
    await expect(page.getByText('启停与增删在重启实例后生效')).toHaveCount(0)
    await page.getByRole('button', { name: '插件管理说明' }).click()
    await expect(page.getByRole('dialog', { name: '插件管理说明' })).toContainText(
      '启停与增删在重启实例后生效',
    )
    await page.keyboard.press('Escape')

    // 选择框与行首图标块共享中线
    await expect(page.getByRole('checkbox', { name: '选择 EssentialsX' })).toBeVisible()
    const centers = await page
      .getByRole('checkbox', { name: '选择 EssentialsX' })
      .evaluate((checkbox) => {
        const icon = checkbox.closest('li')!.querySelector('div.size-9')!
        const c = checkbox.getBoundingClientRect()
        const i = icon.getBoundingClientRect()
        return { checkbox: c.top + c.height / 2, icon: i.top + i.height / 2 }
      })
    expect(Math.abs(centers.checkbox - centers.icon)).toBeLessThanOrEqual(1)

    // 四个按钮在 375 下换行而不是把页面撑宽
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }))
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth)

    const mainOverflow = await page
      .locator('#main-content')
      .evaluate((el) => el.scrollWidth - el.clientWidth)
    expect(mainOverflow).toBeLessThanOrEqual(0)
  })
})

test.describe('手机横屏（短视口）', () => {
  /**
   * 短视口下页面下部控件必须仍可点。
   *
   * 缺口由来：表格外壳的收缩下限先写成固定 `min-h-40`（160px），可用高不足时不肯退让，
   * 卡片溢出父级并盖住其后的兄弟节点——「显示全部列」开关实测在 667x375 与 812x375
   * 由可点变**点击超时**（Playwright 非 force 点击会因元素被遮挡而失败）。
   * 下限改 `min()` 后恢复；本用例锁的就是这个可点性。
   * 横屏短高度此前无用例（既有移动用例都是 375x812 竖屏，可用高远大于 160px）。
   */
  test('667x375 与 812x375：表格下方的「显示全部列」开关可点', async ({ page }) => {
    await setupConnection(page)
    for (const vp of [
      { width: 667, height: 375 },
      { width: 812, height: 375 },
    ]) {
      await page.setViewportSize(vp)
      await page.goto('/players')
      await page.waitForLoadState('networkidle')
      await page.waitForTimeout(600)

      const toggle = page.getByRole('button', { name: /显示全部列|收起次要列/ })
      await expect(toggle, `${vp.width}x${vp.height} 未见列开关`).toBeVisible()
      // 非 force 点击：被遮挡时 Playwright 会等待到超时并抛错——正是要拦的回归
      await toggle.click({ timeout: 5000 })
      // 点完确实生效（开关本身有状态变化，不是空过）
      await expect(page.getByRole('button', { name: /收起次要列/ })).toBeVisible()
    }
  })
})
