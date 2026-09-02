import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'

/**
 * 任务页 E2E（数据源：scripts/mock-server.mjs，任务数据为结构占位虚构内容）
 * 验收：列表渲染 / 新建对话框（cron 描述+预置+可视化编辑器）/ 行内立即执行 / 删除确认 / 视觉截图
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

test.describe('任务页', () => {
  test('任务列表渲染：3 条任务 + 类型徽章 + cron + 时间行', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/tasks')
    // 任务名称
    for (const name of ['每日自动重启', '每日备份', '清理告示牌命令']) {
      await expect(page.getByText(name)).toBeVisible()
    }
    // 类型徽章（重启/备份/命令）
    await expect(page.getByText('重启', { exact: true })).toBeVisible()
    await expect(page.getByText('备份', { exact: true })).toBeVisible()
    await expect(page.getByText('命令', { exact: true })).toBeVisible()
    // cron mono 与命令文本
    await expect(page.getByText('0 4 * * *')).toBeVisible()
    await expect(page.getByText('say 服务器每半小时自动公告')).toBeVisible()
    // 时间行（上次运行 · 下次运行，双空格分隔）
    await expect(page.getByText(/上次运行: .+\s+·\s+下次运行: .+/).first()).toBeVisible()
    await maybeShot(page, 'tasks-list-dark.png')
  })

  test('新建任务：预置 chip 回填 cron + 中文描述实时 + 创建成功', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/tasks')
    await page.getByRole('button', { name: '新建任务' }).click()
    // 对话框：名称输入 + 预置 chip「每天 4:00」→ cron 回填 + 描述出现
    await page.getByLabel('任务名称').fill('E2E 占位任务')
    await page.getByRole('button', { name: '每天 4:00' }).click()
    await expect(page.getByLabel('Cron 表达式')).toHaveValue('0 4 * * *')
    await expect(page.getByText('04:00每天执行')).toBeVisible()
    // 创建 → 成功 toast
    await page.getByRole('button', { name: '创建' }).click()
    await expect(page.getByText('任务已创建')).toBeVisible()
    await maybeShot(page, 'tasks-create-dark.png')
  })

  test('可视化编辑器：五字段下拉联动回写表达式', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/tasks')
    await page.getByRole('button', { name: '新建任务' }).click()
    // 打开可视化编辑器
    await page.getByRole('button', { name: '可视化编辑' }).click()
    // 五字段标签可见（分/时/日/月/周）
    for (const label of ['分', '时', '日', '月', '周']) {
      await expect(page.getByText(label, { exact: true })).toBeVisible()
    }
    // 选「每30分」→ cron 输入更新
    await page.getByRole('combobox', { name: '分' }).click()
    await page.getByRole('option', { name: '每30分' }).click()
    await expect(page.getByLabel('Cron 表达式')).toHaveValue('*/30 * * * *')
    await expect(page.getByText('每30分钟每天执行')).toBeVisible()
    await maybeShot(page, 'tasks-cron-editor-dark.png')
  })

  test('行内操作：立即执行 + 按钮复位 + 删除确认', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/tasks')
    // 立即执行 → 确认对话框（命令预览仅命令类型任务显示）
    await page.getByRole('button', { name: '每日自动重启 立即执行' }).click()
    await expect(page.getByText('确认执行任务')).toBeVisible()
    await page.getByRole('button', { name: '执行' }).click()
    // mock 返回触发成功 → toast
    await expect(page.getByText(/已触发执行/)).toBeVisible()
    // 按钮复位：锁定 mutation 完成后按钮恢复可用（variables 残留会导致永久禁用）
    const runButton = page.getByRole('button', { name: '每日自动重启 立即执行' })
    await expect(runButton).toBeEnabled()
    // 删除确认 → 执行 → toast
    await page.getByRole('button', { name: '每日自动重启 删除' }).click()
    await expect(page.getByText('确定要删除任务 "每日自动重启" 吗？')).toBeVisible()
    await page.getByRole('button', { name: '删除' }).click()
    await expect(page.getByText('任务已删除')).toBeVisible()
  })
})
