/**
 * 部署进度兜底与重复部署门控 E2E（J29）
 * 数据源：scripts/mock-server.mjs（结构占位虚构数据）
 * - 刷新页面：兜底快照（GET /instances/deploy/status）恢复在途进度，不回落步骤①
 * - 服务端在途：实例页「部署新实例」入口禁用（消除刷新后的重复发起部署）
 * - 断线提示：实时通道断开后写明进度刷新方式，并明确不得重新发起部署
 * 时序确定性：断线场景先等实时通道连上（顶栏「已连接」）再断开，
 * 否则横幅判定（曾连接过 + 当前断开）不成立
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
}

test.describe('部署进度兜底（J29）', () => {
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

    // 断开实时通道：mock 专用控制端点强制断开 WS（HTTP 兜底仍可用）
    await page.request.post('http://localhost:5198/api/v1/instances/deploy/drop-ws')

    await expect(page.getByText('WebSocket 已断开').first()).toBeVisible()
    await expect(page.getByText(/请勿重新发起部署（会重复创建实例）/)).toBeVisible()
    // 文案可兑现：进度仍可由服务端兜底刷新（不是「已冻结」）
    await expect(page.getByText(/进度每 \d+ 秒从服务端刷新/)).toBeVisible()
  })
})
