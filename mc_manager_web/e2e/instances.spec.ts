import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'

/**
 * 实例页 E2E（数据源：scripts/mock-server.mjs，实例/部署数据为结构占位虚构内容）
 * 验收：实例卡片 / 部署向导三步流程 / 卸载确认 / 视觉截图
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

test.describe('实例页', () => {
  test('实例卡片：名称/状态/版本徽章/当前徽章渲染', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/instances')
    // 卡片名称（first：顶栏实例选择器同名）+ 运行状态文本
    await expect(page.getByText('E2E 演示实例').first()).toBeVisible()
    // 侧栏迷你卡与实例卡双渲染「运行中 · N 人在线」→ 取任一
    await expect(page.getByText(/运行中 · \d+ 人在线/).first()).toBeVisible()
    // 版本徽章（detailStatuses 拉取）
    await expect(page.getByText('1.21.4')).toBeVisible()
    // 当前实例徽章 + 操作行（启停主操作 + 操作菜单触发器；配置/升级/卸载已收进菜单）
    await expect(page.getByText('当前')).toBeVisible()
    await expect(page.getByRole('button', { name: '停止 E2E 演示实例' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'E2E 演示实例 操作菜单' })).toBeVisible()
    await maybeShot(page, 'instances-cards-dark.png')
  })

  test('部署向导：三步流程到部署成功', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/instances')
    await page.getByRole('button', { name: '部署新实例' }).click()
    // 步骤①：默认 Paper 已选中；版本下拉自动查询回填
    await expect(page.getByText('选择服务端', { exact: true })).toBeVisible()
    await expect(page.getByRole('radio', { name: /^Paper/ })).toBeChecked()
    await expect(page.getByLabel('选择 Minecraft 版本')).toContainText('26.2')
    // Java 推荐提示
    await expect(page.getByText(/推荐 Java 版本/)).toBeVisible()
    await maybeShot(page, 'deploy-step1-dark.png')
    // 步骤②：名称 + 内存
    await page.getByRole('button', { name: '下一步' }).click()
    await expect(page.getByText('实例配置')).toBeVisible()
    await page.getByLabel('实例名称').fill('E2E 新服务器')
    await page.getByRole('button', { name: '下一步' }).click()
    // 步骤③：确认摘要 + EULA 同意勾选（不阻断部署：未勾选为「仅部署」，勾选后为「部署并启动」）
    await expect(page.getByText('确认部署')).toBeVisible()
    await expect(page.getByText('E2E 新服务器')).toBeVisible()
    await expect(page.getByRole('button', { name: '仅部署' })).toBeEnabled()
    await page.getByRole('checkbox', { name: /Minecraft EULA/ }).check()
    await page.getByRole('button', { name: '部署并启动' }).click()
    // mock 直接成功：结果块 + 自动启动状态（已勾选 EULA → 部署完成自动启动）+ 完成
    await expect(page.getByText('部署成功')).toBeVisible()
    await expect(page.getByText('已发送启动指令，服务器正在启动（状态可在仪表盘查看）')).toBeVisible()
    await expect(page.getByText('新部署实例').first()).toBeVisible()
    await maybeShot(page, 'deploy-done-dark.png')
    await page.getByRole('button', { name: '完成' }).click()
    await expect(page.getByText(/实例 "新部署实例" 部署完成/)).toBeVisible()
  })

  test('实例启动配置弹窗：内存/Aikar/高级参数 + 保存关闭', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/instances')
    await page.getByRole('button', { name: 'E2E 演示实例 操作菜单' }).click()
    await page.getByRole('menuitem', { name: '启动配置' }).click()
    // 弹窗标题 + 实例名 + 内存预填（mock maxMemory 4096MB → 4.0 GB）
    await expect(page.getByRole('heading', { name: '启动配置' })).toBeVisible()
    await expect(page.getByText('4.0 GB')).toBeVisible()
    await expect(page.getByRole('switch', { name: "JVM 优化 (Aikar's Flags)" })).toBeChecked()
    // 生成的启动命令预览（Aikar 标志已同步进参数）
    await expect(page.getByText(/java -Xms2G -Xmx4G/)).toBeVisible()
    await maybeShot(page, 'instance-settings-dark.png')
    // 高级参数：Java 路径 + JVM 参数 + 参数说明
    await page.getByRole('button', { name: /高级参数/ }).click()
    await expect(page.getByLabel('Java 路径（可选）')).toBeVisible()
    await expect(page.getByLabel('JVM 参数（每行一个）')).toBeVisible()
    await expect(page.getByText('参数说明')).toBeVisible()
    // 保存 → toast + 弹窗关闭
    await page.getByRole('button', { name: '保存配置' }).click()
    await expect(page.getByText('启动配置已保存')).toBeVisible()
    await expect(page.getByRole('heading', { name: '启动配置' })).toBeHidden()
  })

  test('卸载确认：对话框 + 取消', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/instances')
    await page.getByRole('button', { name: 'E2E 演示实例 操作菜单' }).click()
    await page.getByRole('menuitem', { name: '卸载实例' }).click()
    await expect(page.getByRole('heading', { name: '卸载实例' })).toBeVisible()
    await expect(page.getByText(/确定要卸载实例 "E2E 演示实例"/)).toBeVisible()
    // 三条款警告文案
    await expect(
      page.getByText('此操作不可撤销！将会：停止运行中的服务器、删除所有世界数据和配置、从数据库中移除记录'),
    ).toBeVisible()
    await page.getByRole('button', { name: '取消' }).click()
    await expect(page.getByRole('heading', { name: '卸载实例' })).toBeHidden()
  })

  test('深链接：?tab=deploy 自动打开部署向导', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/instances?tab=deploy')
    // 向导自动打开（无需点击「部署新实例」）
    await expect(page.getByText('选择服务端', { exact: true })).toBeVisible()
    await expect(page.getByRole('radio', { name: /^Paper/ })).toBeChecked()
    await expect(page).toHaveURL(/tab=deploy/)
    // 取消关闭 → URL 参数清除
    await page.getByRole('button', { name: '取消' }).click()
    await expect(page).toHaveURL(/\/instances$/)
  })
})
