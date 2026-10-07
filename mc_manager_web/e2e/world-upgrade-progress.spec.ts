import { test, expect, type Page } from '@playwright/test'

/**
 * 世界格式升级的进度条（数据源：scripts/mock-server.mjs 结构占位虚构数据）
 *
 * 为什么值得一条 e2e：这条链路的产品价值全在「看得见」。协议给的是 **0..1 的分数**，
 * 换算错了（直灌原值）就会渲染成恒 0% 的空条——而单测里 store 拿到的仍是 0.37，
 * 单测看不出「条是空的」。所以这里断言的是**用户看到的那个百分比**。
 *
 * WS 连接分组：本 spec 触发 mock 的 worldUpgrade 广播，而 mock 按分组投递——
 * 不声明分组就收不到自己触发的事件；声明后也不会打进并行 spec。
 */
const WS_GROUP = 'world-upgrade-progress'
const CONNECTION_STORAGE = 'mcs-connection'
const EMIT_URL = '/api/v1/instances/e2e-demo/world-upgrade/emit'

async function setupConnection(page: Page) {
  // 假 Key 运行时拼接（仓库纪律：mock 凭据不写可用字面量）；mock 不校验 X-API-Key
  const fakeKey = ['e2e', 'mock', 'key', '0000000000'].join('-')
  await page.addInitScript(
    ([key, apiKey]) => {
      localStorage.setItem(key as string, JSON.stringify({ baseUrl: '', apiKey }))
    },
    [CONNECTION_STORAGE, fakeKey] as const,
  )
  await page.setExtraHTTPHeaders({ 'x-mock-ws-group': WS_GROUP })
}

/** 单发一条升级事件（mock 的构造端点；page.request 不继承 extraHTTPHeaders，故显式带分组） */
async function emit(page: Page, data: { state: string; progress: number | null }) {
  const res = await page.request.post(EMIT_URL, {
    data,
    headers: { 'x-mock-ws-group': WS_GROUP },
  })
  expect(res.ok()).toBe(true)
}

test.describe('世界格式升级进度', () => {
  test('进行中就地显示百分比，「升级开始」那条收起进度条', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/')
    // 先等实时通道真的连上再发：广播只投给在线连接，抢在握手前发就是发给空气
    await expect(page.getByRole('banner').getByText('已连接')).toBeVisible()

    await emit(page, { state: 'started', progress: null })
    await page.getByRole('button', { name: /通知/ }).click()

    // 条目的可访问名是**通知内容**（类型标签只在设置页的矩阵里用）
    const startedRow = page.getByRole('button', { name: /服务器正在升级世界存档格式/ })
    await expect(startedRow).toBeVisible()

    await emit(page, { state: 'progress', progress: 0.4 })
    // 量纲断言：0.4 的分数 → 40%；直灌原值会得到「升级进度 0%」，条也几乎不可见
    await expect(startedRow).toHaveAccessibleName(/升级进度 40%/)
    await expect(startedRow.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40')

    await emit(page, { state: 'finished', progress: null })
    // 终态：进度条收起（不留一条不动的百分比），终态通知另起一条
    await expect(startedRow.getByRole('progressbar')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /世界存档格式升级完成/ })).toBeVisible()
  })
})
