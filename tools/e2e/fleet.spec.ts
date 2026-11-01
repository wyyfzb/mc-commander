import { test, expect, type Page } from '@playwright/test'

/**
 * 实例总览（/fleet）E2E
 *
 * jsdom 不评估容器查询，故总览清单的列阈值只能在这里锁：同一个视口宽下，侧栏折叠与否会让
 * 内容宽差 152px，按视口断点判列的实现在这两态里必有一态判错。下面两档各自对应
 * 「内容宽不足 @2xl」与「内容宽超过 @3xl」，几何断言直接量格数与摘要行的显示态。
 *
 * mock 数据源：同目录 mock-server.mjs（1 台实例，虚构值）。
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

/**
 * 「在线」列表头所在列在当前布局下是否可见（可见 ⇔ 已上列）。
 *
 * 用 CSS 定位而非 `getByRole`：`display:none` 会把元素从可访问性树里摘掉，
 * 按角色找「收起态」永远等不到元素——判据本身要能表达「它此刻不可见」。
 */
async function metricColumnVisible(page: Page): Promise<boolean> {
  return page
    .locator('th', { hasText: '在线' })
    .first()
    .evaluate((el) => getComputedStyle(el).display !== 'none')
}

test.describe('实例总览', () => {
  test('页头与汇总卡：运行台数、在线玩家、可分配余量', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/fleet')

    await expect(page.getByRole('heading', { name: '实例总览' })).toBeVisible()
    // 一屏同时给出运行台数与在线玩家（多实例用户要的是这两个数，不是逐台卡）
    await expect(page.getByText('全部实例都在运行')).toBeVisible()
    await expect(page.getByText('分布在 1 台运行中的实例')).toBeVisible()
    // 余量按「整机总量 − 系统保留 − 已分配 -Xmx」算：16 GB → 可分配 14 GB，减去 4G = 10 GB
    await expect(page.getByText('已分配 4 GB，可分配 14 GB')).toBeVisible()
    await expect(page.getByText('10.0 GB')).toBeVisible()
  })

  test('清单一台一行，实例名可点开当前实例', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/fleet')

    const open = page.getByRole('button', { name: '打开 E2E 演示实例' })
    await expect(open).toBeVisible()
    // 一实例一行：表头之外只有这一行数据
    await expect(page.getByRole('row')).toHaveCount(2)
    // 该实例已是当前实例 ⇒ 行内标「当前」
    await expect(page.getByText('当前')).toBeVisible()

    await open.click()
    await expect(page).toHaveURL(/\/dashboard$/)
  })

  /**
   * 容器阈值：768 视口 + 展开侧栏 ⇒ 清单区实宽约 528px < @2xl(672)。
   * 此时四项运行指标必须收起成摘要行（否则实例名会被挤到读不出），
   * 且摘要行必须真的显示出来——两边同时隐藏就会让这台实例的指标凭空消失。
   */
  test('窄容器（768 视口 + 展开侧栏）：指标列收起、摘要行顶上来', async ({ page }) => {
    await setupConnection(page)
    await page.setViewportSize({ width: 768, height: 900 })
    await page.goto('/fleet')
    await expect(page.getByRole('button', { name: '打开 E2E 演示实例' })).toBeVisible()

    // 内容宽不足 @2xl ⇒ 指标列不上列
    expect(await metricColumnVisible(page)).toBe(false)
    // 摘要行接管这四项，且是可见的（含在线人数与 TPS 两件关键事实）
    const summary = page.getByText(/^3 人在线 · TPS /)
    await expect(summary).toBeVisible()

    // 不得横向溢出：窄容器下靠收起列来适配，不是靠滚动条
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBe(0)
  })

  /**
   * 折叠侧栏 + 1280 视口 ⇒ 清单区实宽约 1191px ≥ @3xl(768)。
   * 指标列与版本列都要上列，摘要行要退场（否则同一份指标在一行里出现两遍）。
   */
  test('宽容器（1280 视口 + 折叠侧栏）：指标列与版本列都上列，摘要行退场', async ({ page }) => {
    await setupConnection(page)
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/fleet')
    await expect(page.getByRole('button', { name: '打开 E2E 演示实例' })).toBeVisible()

    await page.getByRole('button', { name: '收起侧栏' }).click()
    await expect(page.getByRole('button', { name: '展开侧栏' })).toBeVisible()

    // 内容宽 ≥ @3xl ⇒ 版本列也上列
    expect(await metricColumnVisible(page)).toBe(true)
    await expect(page.getByRole('columnheader', { name: '版本' })).toBeVisible()
    // 摘要行退场：四项指标已在列里，重复一遍会被读成第二组数据
    await expect(page.getByText(/^3 人在线 · TPS /)).toBeHidden()

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBe(0)
  })

  test('空态：无实例时给部署入口，而不是一张空表', async ({ page }) => {
    await setupConnection(page)
    await page.route('**/api/v1/instances', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'ok',
          code: 0,
          message: 'Success',
          data: [],
          timestamp: new Date().toISOString(),
        }),
      }),
    )
    await page.goto('/fleet')

    await expect(page.getByText('暂无已安装的实例')).toBeVisible()
    await expect(page.getByText('还没有已安装的实例')).toBeVisible()
    await page.getByRole('button', { name: '去实例页部署' }).click()
    await expect(page).toHaveURL(/\/instances$/)
  })
})
