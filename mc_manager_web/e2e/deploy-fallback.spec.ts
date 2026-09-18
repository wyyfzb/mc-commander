/**
 * 部署进度兜底与重复部署门控 E2E
 * 数据源：scripts/mock-server.mjs（结构占位虚构数据）
 * - 刷新页面：兜底快照（GET /instances/deploy/status）恢复在途进度，不回落步骤①
 * - 服务端在途：实例页「部署新实例」入口禁用（消除刷新后的重复发起部署）
 * - 断线提示：实时通道断开后写明进度刷新方式，并明确不得重新发起部署
 * 时序确定性：断线场景先等实时通道连上（顶栏「已连接」）再断开，
 * 否则横幅判定（曾连接过 + 当前断开）不成立
 * 空态收敛（部署完成/死快照超时）不在此复现：真实浏览器里要等满全局 10s
 * 新鲜期（main.tsx staleTime）才可能重取快照，或等 WS 断线后的 30s 轮询，
 * 该路径由 deploy-status-fallback.test.tsx 用假时钟精确覆盖
 */
import { test, expect, type Page } from '@playwright/test'

/** 注入连接配置 + mock 部署在途场景（假 key，mock 不校验；严禁真实服务器信息） */
async function setupInFlightDeploy(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'mcs-connection',
      JSON.stringify({ baseUrl: '', apiKey: 'e2e-mock-key-0000000000' }),
    )
    localStorage.setItem('mcs-deploy-mock', 'in-flight')
  })
  // WS 连接分组：断线用例会调 mock 的 drop-ws，按分组只断本用例的连接。
  // 旧实现断的是共享 mock 进程里的全部连接（连接普查实测：会连带掐掉并行 spec 的
  // 实时通道），按分组后只断自己那几条
  await page.setExtraHTTPHeaders({ 'x-mock-ws-group': 'deploy-fallback' })
}

test.describe('部署进度兜底', () => {
  test('刷新页面恢复在途进度，且实例页禁止重复部署', async ({ page }) => {
    await setupInFlightDeploy(page)
    await page.goto('/instances?tab=deploy')

    // 兜底快照恢复进度视图：不回落步骤①
    await expect(page.getByRole('progressbar')).toBeVisible()
    await expect(page.getByRole('button', { name: '下一步' })).toHaveCount(0)
    await expect(page.getByText(/有实例正在部署/)).toBeVisible()

    // 回列表：入口按钮禁用（点击不打开向导，无二次部署入口）
    await page.goto('/instances')
    const blocked = page.getByRole('button', { name: '已有部署在进行中' })
    await expect(blocked).toBeVisible()
    await expect(blocked).toBeDisabled()
    await blocked.click({ force: true })
    await expect(page.getByRole('button', { name: '下一步' })).toHaveCount(0)
  })

  test('断线提示：实时通道断开 + 服务端在途 → 写明进度刷新方式且不得重复发起', async ({
    page,
  }) => {
    await setupInFlightDeploy(page)
    await page.goto('/instances')
    await expect(page.getByRole('banner').getByText('已连接')).toBeVisible()

    // 断开实时通道：mock 专用控制端点断开**本组** WS（HTTP 兜底仍可用）。
    // 地址取当前页 origin（= dev/preview server，端口随 MOCK_PORT/DEV_PORT 泳道变化），
    // 经其 proxy 转发到 mock：硬编码 mock 端口会让非默认泳道下的 spec 变成 ECONNREFUSED 假红。
    // 分组头显式带上：setExtraHTTPHeaders 作用于页面请求（WS 握手因此拿到分组），
    // 但 page.request 的 APIRequestContext 不继承它——不显式传就会断到「无分组」那一组
    const dropRes = await page.request.post(
      new URL('/api/v1/instances/deploy/drop-ws', page.url()).toString(),
      { headers: { 'x-mock-ws-group': 'deploy-fallback' } },
    )
    // 先把「一条都没断」的失败钉在调用点（否则只能等下面三条 UI 断言，失败信息指向模糊）
    expect(((await dropRes.json()) as { data: { dropped: number } }).data.dropped).toBeGreaterThan(0)

    await expect(page.getByText('WebSocket 已断开').first()).toBeVisible()
    await expect(page.getByText(/请勿重新发起部署（会重复创建实例）/)).toBeVisible()
    // 文案可兑现：进度仍由服务端兜底刷新（不是「已冻结」），间隔只声明一次
    await expect(page.getByText(/进度经服务端刷新/)).toBeVisible()
    await expect(page.getByText(/每 30 秒/)).toHaveCount(1)
  })

  test('恢复态可取消在途部署：请求按实例 id 精确匹配，终态切「已取消」而非「失败」', async ({
    page,
  }) => {
    await setupInFlightDeploy(page)
    await page.goto('/instances?tab=deploy')
    await expect(page.getByRole('progressbar')).toBeVisible()

    // 请求体断言：取消必须点名实例 id（服务端按 id 匹配注册表，不做「取消当前那个」的推断）
    const cancelBodies: unknown[] = []
    page.on('request', (req) => {
      if (req.url().endsWith('/api/v1/instances/deploy/cancel')) cancelBodies.push(req.postDataJSON())
    })

    await page.getByRole('button', { name: '取消部署' }).click()
    await expect(page.getByText('取消部署？')).toBeVisible()
    await page.getByRole('button', { name: '中断并清理' }).click()

    // mock 按真实链路补发 cancelled 终态事件 → 视图收敛到已取消（不是失败视图）
    await expect(page.getByText('部署已取消，未完成的实例目录已清理。')).toBeVisible()
    await expect(page.getByText(/部署失败/)).toHaveCount(0)
    expect(cancelBodies).toEqual([{ instanceId: 'paper-a1b2c3d4' }])
  })
})
