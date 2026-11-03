import { test, expect, type Page } from '@playwright/test'

/**
 * 备份页 E2E（数据源：同目录 mock-server.mjs，备份/实例数据为结构占位虚构内容）
 *
 * 备份是侧栏一级的实例级页面（与 玩家/世界/文件/插件/任务 同构），不再是设置子页。
 * 页面级标题由 PageHeader 的 h2 承担，列表区块标题是 h3。
 */

// 可选截图（调试用）：设 E2E_SHOT=1 时输出到 tools/e2e/test-results/shots/，默认关闭
const E2E_DIR = import.meta.dirname
const SHOT_DIR = `${E2E_DIR}/test-results/shots`
function maybeShot(page: Page, name: string) {
  return process.env.E2E_SHOT ? page.screenshot({ path: `${SHOT_DIR}/${name}` }) : undefined
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

test.describe('备份页', () => {
  test('页面标题 + 列表 + 立即备份 + 恢复确认取消', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/backups')

    // 页面级标题（h2）与列表区块标题（h3）各就其位，两者不同名
    await expect(page.getByRole('heading', { name: '备份', level: 2 })).toBeVisible()
    await expect(page.getByRole('heading', { name: '备份列表', level: 3 })).toBeVisible()
    // 首句用用户词交代「备份 = 某一刻的存档」
    await expect(page.getByText(/备份就是这个服务器在某一刻的存档/)).toBeVisible()

    // 快照机制说明收进信息入口：正文不常驻，点开才读到
    await expect(
      page.getByText('快照备份：未修改文件零拷贝增量传输，超出保留策略自动清理'),
    ).toHaveCount(0)
    await page.getByRole('button', { name: '快照备份说明' }).click()
    await expect(page.getByRole('dialog', { name: '快照备份说明' })).toContainText(
      '快照备份：未修改文件零拷贝增量传输，超出保留策略自动清理',
    )
    await page.keyboard.press('Escape')
    // 列表行（mock 2 条：completed / failed）。名称都用精确匹配：
    // 子串匹配下夹具名重新内嵌日期也照样命中，等于没有防线
    await expect(page.getByText('手动备份', { exact: true })).toBeVisible()
    await expect(page.getByText('失败的备份', { exact: true })).toBeVisible()
    // 立即备份 → creating 行 + toast
    await page.getByRole('button', { name: '立即备份' }).click()
    await expect(page.getByText('备份任务已启动')).toBeVisible()
    // 恢复确认（B3 危险弹窗：红色警示 + 输入实例名确认）
    await page.getByRole('button', { name: '手动备份 恢复' }).click()
    await expect(page.getByRole('heading', { name: '恢复备份（危险操作）' })).toBeVisible()
    await expect(page.getByText(/覆盖当前世界数据，且不可撤销/)).toBeVisible()

    // 取消路径：不输入名字时确认按钮禁用（实例名确认是服务端强制的同一道闸门）
    await expect(page.getByRole('button', { name: '恢复到「手动备份」' })).toBeDisabled()
    await page.getByRole('button', { name: '取消' }).click()
    await expect(page.getByRole('heading', { name: '恢复备份（危险操作）' })).toHaveCount(0)

    // 确认路径：输入实例名 → 请求体必须带 confirmName（服务端按实例名强制校验；
    // mock 与真实服务端同语义，缺名会回 400 40017）
    await page.getByRole('button', { name: '手动备份 恢复' }).click()
    const restoreReq = page.waitForRequest(
      (r) => /\/api\/v1\/backups\/\d+\/restore$/.test(r.url()) && r.method() === 'POST',
    )
    await page.getByLabel(/输入实例名/).fill('E2E 演示实例')
    await page.getByRole('button', { name: '恢复到「手动备份」' }).click()
    const req = await restoreReq
    expect(req.postDataJSON()).toEqual({ confirmName: 'E2E 演示实例' })
    await expect(page.getByText('恢复已开始，完成后请启动服务器生效')).toBeVisible()
    await expect(page.getByRole('heading', { name: '恢复备份（危险操作）' })).toBeHidden()
    await maybeShot(page, 'backups-page-dark.png')
  })

  test('归档快照（来自已卸载实例）可见且可挂载到本实例', async ({ page }) => {
    await setupConnection(page)
    // 按域复位 mock 的归档状态（同轮 webServer 共享一个 mock 进程；不传 only 的全量复位
    // 会清掉并行升级用例的在途升级态）
    await page.request.post('/api/v1/mock/reset', { data: { only: 'archive' } })
    await page.goto('/backups')

    const archive = 'paper-1a2b3c4d'
    await expect(page.getByText('归档快照（未建立索引）')).toBeVisible()
    await expect(page.getByText(archive)).toBeVisible()
    await expect(page.getByText(/来自已卸载实例/)).toBeVisible()
    await expect(page.getByText(/可挂载 2\/3 份/)).toBeVisible()

    // 挂载：二次确认讲清后果（不动磁盘 + 无第二份副本 + 计入配额受保留策略约束），
    // 确认后 toast 报挂载与跳过份数
    await page.getByRole('button', { name: /挂载到本实例/ }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText(archive)
    await expect(dialog).toContainText('原归档目录不会被复制或移动')
    await expect(dialog).toContainText('删除这些条目会删除磁盘上的原归档快照')
    await expect(dialog).toContainText('计入本实例的备份配额')
    await dialog.getByRole('button', { name: '挂载' }).click()

    await expect(page.getByText(/已挂载 2 份归档快照/)).toBeVisible()
    // 挂载后清点收敛：区块消失（已无未索引项）
    await expect(page.getByText('归档快照（未建立索引）')).toHaveCount(0)
  })

  test('自动备份摘要条：从任务列表推导现状并深链到任务页', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/backups')
    // 夹具里有一条启用的 backup 任务（每日 04:00）——摘要条必须点名它的 cron 与任务名
    const summary = page.getByText(/自动备份：/)
    await expect(summary).toBeVisible()
    await page.getByRole('link', { name: /去调整/ }).click()
    await expect(page).toHaveURL(/\/tasks$/)
  })

  /* 归档快照是**面板级**资产（清点端点不带实例），不属于任何一台服务器。
     卸载最后一台之后，「已保留 N 份备份」这句话的唯一出口就在这里——它若跟着
     实例空态一起消失，用户就没有任何办法看到那些快照 */
  test('一台实例都没有时：归档快照仍然可见，但不给挂载按钮', async ({ page }) => {
    await setupConnection(page)
    await page.request.post('/api/v1/mock/reset', { data: { only: 'archive' } })
    // 让实例列表返回空：这是「卸载完最后一台」的真实形态
    await page.route('**/api/v1/instances', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'ok',
          code: 0,
          message: 'Success',
          data: [],
          timestamp: '',
        }),
      }),
    )

    await page.goto('/backups')

    await expect(page.getByText('暂无服务器实例')).toBeVisible()
    await expect(page.getByText('归档快照（未建立索引）')).toBeVisible()
    await expect(page.getByText('paper-1a2b3c4d')).toBeVisible()
    // 没有目标实例可登记，挂载按钮不能出现（点了必然失败）
    await expect(page.getByRole('button', { name: /挂载到本实例/ })).toHaveCount(0)
    await expect(page.getByText(/挂载需要先有一台实例/)).toBeVisible()
  })
})
