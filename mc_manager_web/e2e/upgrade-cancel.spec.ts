import { test, expect, type Page } from '@playwright/test'

/**
 * 升级取消 E2E（清单 #94，数据源：scripts/mock-server.mjs 结构占位虚构数据）
 * 路径：实例为停止态才给升级入口（运行中菜单里没有该项）→ 操作菜单「升级版本」
 *      → 选目标版本 → 开始升级 → WS 进度事件进入「升级中」视图 → 取消升级（二次确认）
 *      → 服务端补发 cancelled 终态 → 展示取消块（不是失败块）
 * mock 状态是进程级共享的：运行态由控制端点翻转，用例结束必须复位
 */
const CONNECTION_STORAGE = 'mcs-connection'

async function setupConnection(page: Page) {
  // 假 Key 运行时拼接（仓库纪律：mock 凭据不写可用字面量）；mock 不校验 X-API-Key，取值任意
  const fakeKey = ['e2e', 'mock', 'key', '0000000000'].join('-')
  await page.addInitScript(
    ([key, apiKey]) => {
      localStorage.setItem(key as string, JSON.stringify({ baseUrl: '', apiKey }))
    },
    [CONNECTION_STORAGE, fakeKey] as const,
  )
}

/** mock 控制端点地址：取配置的 baseURL 而非 page.url()——后者在首个 goto 失败时是
 *  about:blank，会让 finally 里的复位一起抛错，把 mock 状态留脏给后续 spec */
function mockApiUrl(): string {
  const base = test.info().project.use.baseURL
  return new URL('/api/v1/mock/instance-running', base).toString()
}

/** 翻转 mock 实例运行态（升级入口仅停止态可见） */
async function setInstanceRunning(page: Page, running: boolean) {
  await page.request.post(mockApiUrl(), { data: { running } })
}

/** 场景态复位（运行中 + 无在途升级）：失败路径也必须执行，故自成 try/catch */
async function resetMockScenario(page: Page) {
  try {
    await page.request.post(new URL('/api/v1/mock/reset', test.info().project.use.baseURL).toString())
  } catch {
    // 复位失败不掩盖用例本身的失败原因（下一轮 e2e 是新 mock 进程，不跨运行泄漏）
  }
}

test.describe('升级取消（清单 #94）', () => {
  test('升级中可取消：确认后展示 cancelled 终态块，而非失败块', async ({ page }) => {
    await setupConnection(page)
    // 先落地再翻转运行态（控制端点地址取当前页 origin；about:blank 上取不到）
    await page.goto('/instances')
    await setInstanceRunning(page, false)
    try {
      await page.reload()
      await page.getByRole('button', { name: 'E2E 演示实例 操作菜单' }).click()
      await page.getByRole('menuitem', { name: '升级版本' }).click()
      await expect(page.getByRole('heading', { name: /升级 E2E 演示实例/ })).toBeVisible()

      // 选目标版本（当前 1.21.4 在选项里禁选，选 26.2）
      await page.getByRole('combobox').click()
      await page.getByRole('option', { name: '26.2' }).click()
      await page.getByRole('button', { name: '开始升级' }).click()

      // 受理后 WS 补发进度 → 升级中视图 + 取消入口（关闭按钮此时不可用）
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByText('下载中')).toBeVisible()
      await expect(page.getByRole('button', { name: '取消', exact: true })).toBeDisabled()

      await page.getByRole('button', { name: '取消升级' }).click()
      await expect(page.getByText('取消升级？')).toBeVisible()
      await page.getByRole('button', { name: '中断升级' }).click()

      // 服务端补发 cancelled 终态 → 取消块展示服务端 detail（含是否已回滚）
      await expect(dialog.getByText('已取消，实例保持 1.21.4')).toBeVisible()
      // 取消不是故障：不得出现失败块的错误色，也不再有进度条
      expect(await dialog.locator('.text-mcs-error-fg').count()).toBe(0)
      await expect(dialog.getByRole('progressbar')).toHaveCount(0)
      await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toBeEnabled()
    } finally {
      await resetMockScenario(page)
    }
  })
})
