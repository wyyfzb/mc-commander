import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'

/**
 * 实例页 E2E（数据源：同目录 mock-server.mjs，实例/部署数据为结构占位虚构内容）
 * 验收：实例卡片 / 部署向导三步流程 / 卸载确认 / 视觉截图
 */

// 可选截图（调试用）：设 E2E_SHOT=1 时输出到 test-results/shots/，默认关闭
const SHOT_DIR = path.join(import.meta.dirname, 'test-results', 'shots')
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
    // 步骤①：默认原版（Vanilla）已选中；版本下拉自动查询回填
    // （默认值取原版而非 Paper——预选 Paper 会让没注意的用户装错类型）
    await expect(page.getByText('选择服务端', { exact: true })).toBeVisible()
    await expect(page.getByRole('radio', { name: /^原版/ })).toBeChecked()
    await expect(page.getByLabel('选择 Minecraft 版本')).toContainText('26.2')
    // Java 推荐提示
    await expect(page.getByText(/推荐 Java 版本/)).toBeVisible()
    await maybeShot(page, 'deploy-step1-dark.png')
    // 步骤②：名称 + 内存
    await page.getByRole('button', { name: '下一步' }).click()
    await expect(page.getByText('实例配置')).toBeVisible()
    await page.getByLabel('实例名称').fill('E2E 新服务器')
    // 内存分母是「还能分配」而不是整机：mock 已有 1 个 4G 实例，16 − 2 − 4 = 10 GB
    await expect(page.getByText('/ 还能分配 10.0 GB')).toBeVisible()
    await maybeShot(page, 'deploy-step2-dark.png')
    await page.getByRole('button', { name: '下一步' }).click()
    // 步骤③：确认摘要 + EULA 同意勾选（不阻断部署：未同意为「部署（暂不启动）」，同意后为「部署并启动」）
    // 文案说后果而非流程模式——「仅部署」曾与「部署并启动」并列，读起来像平级选项
    await expect(page.getByText('确认部署')).toBeVisible()
    await expect(page.getByText('E2E 新服务器')).toBeVisible()
    await expect(page.getByRole('button', { name: '部署（暂不启动）' })).toBeEnabled()
    await page.getByRole('checkbox', { name: /Minecraft EULA/ }).check()
    await page.getByRole('button', { name: '部署并启动' }).click()
    // mock 直接成功：结果块 + 自动启动状态（已勾选 EULA → 部署完成自动启动）+ 完成
    await expect(page.getByText('部署成功')).toBeVisible()
    await expect(
      page.getByText('已发送启动指令，服务器正在启动（状态可在仪表盘查看）'),
    ).toBeVisible()
    await expect(page.getByText('新部署实例').first()).toBeVisible()
    await maybeShot(page, 'deploy-done-dark.png')
    await page.getByRole('button', { name: '完成' }).click()
    await expect(page.getByText(/实例 "新部署实例" 部署完成/)).toBeVisible()
  })

  test('实例设置弹窗：内存/Aikar/高级参数 + 保存关闭', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/instances')
    await page.getByRole('button', { name: 'E2E 演示实例 操作菜单' }).click()
    await page.getByRole('menuitem', { name: '实例设置' }).click()
    // 弹窗标题 + 实例名 + 内存预填（mock maxMemory 4096MB → 4.0 GB）
    await expect(page.getByRole('heading', { name: '实例设置' })).toBeVisible()
    // exact：分母那行「/ 最多 14.0 GB」也含「4.0 GB」，子串匹配会同时命中两个元素
    await expect(page.getByText('4.0 GB', { exact: true })).toBeVisible()
    // 滑块分母是「这台最多能给多少」（16 GB 机器扣 2 GB 系统保留），不是整机内存
    await expect(page.getByText('/ 最多 14.0 GB')).toBeVisible()
    // 默认不开 JVM 调优：现代 JVM 先不加 flag，卡顿或有 GC 问题再开
    await expect(page.getByRole('switch', { name: "JVM 优化 (Aikar's Flags)" })).not.toBeChecked()
    // 自动重启是本实例的配置，住这里（mock 默认 autoRestart=true）；说明里写明「默认开启」
    await expect(page.getByRole('switch', { name: '意外停止后自动重启' })).toBeChecked()
    await expect(page.getByText(/新建实例默认开启/)).toBeVisible()
    // 高级参数默认收起：先把「不动也能用」的结论摆出来，命令与参数藏进折叠区
    await expect(page.getByText('不动这里也能正常用', { exact: false })).toBeVisible()
    // exact：引导句里也含「实际启动命令」这四个字，子串匹配会命中引导句本身
    await expect(page.getByText('实际启动命令', { exact: true })).toBeHidden()
    await expect(page.getByLabel('Java 路径（可选）')).toBeHidden()
    await maybeShot(page, 'instance-settings-dark.png')
    // 高级参数：启动命令 + Java 路径 + JVM 参数 + 参数说明
    await page.getByRole('button', { name: /高级参数/ }).click()
    await expect(page.getByText(/java -Xms2G -Xmx4G/)).toBeVisible()
    await expect(page.getByLabel('Java 路径（可选）')).toBeVisible()
    await expect(page.getByLabel('JVM 参数（每行一个）')).toBeVisible()
    await expect(page.getByText('参数说明')).toBeVisible()
    // 保存 → toast + 弹窗关闭
    await page.getByRole('button', { name: '保存配置' }).click()
    // 本用例没改动任何项 ⇒ 回执如实说「与之前一致，无需重启」：笼统说「已保存」会诱导一次
    // 无必要重启，也不该让用户以为待生效
    await expect(page.getByText('设置已保存（与之前一致，无需重启）')).toBeVisible()
    await expect(page.getByRole('heading', { name: '实例设置' })).toBeHidden()
  })

  test('实例设置弹窗：实时推送随「保存配置」提交，保存后卡片注明「待重启」', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/instances')
    await page.getByRole('button', { name: 'E2E 演示实例 操作菜单' }).click()
    await page.getByRole('menuitem', { name: '实例设置' }).click()

    // 拨动开关只改本地草稿：此刻还没提交，弹窗也没关
    await page.getByRole('switch', { name: '实时推送' }).click()
    await expect(page.getByRole('heading', { name: '实例设置' })).toBeVisible()

    await page.getByRole('button', { name: '保存配置' }).click()
    // 只改了推送 ⇒ 回执点名推送，并说明它和启动配置一样要重启才生效
    await expect(page.getByText('实时推送已开启，重启实例后生效')).toBeVisible()
    await expect(page.getByRole('heading', { name: '实例设置' })).toBeHidden()

    // 逐台注明：卡片上直接出现「待重启」，用户不必拿名字去比对页头横幅是哪一台
    const card = page.locator('[data-instance-id="e2e-demo"]')
    await expect(card.getByText('待重启')).toBeVisible()
    // mock 里该实例在运行中 ⇒ 横幅说「重启后生效」，卡片上同时有重启与停止两枚操作
    await expect(page.getByText('E2E 演示实例 的设置已修改，重启后生效')).toBeVisible()
    await expect(card.getByRole('button', { name: '重启 E2E 演示实例' })).toBeVisible()
    await expect(card.getByRole('button', { name: '停止 E2E 演示实例' })).toBeVisible()
  })

  test('实例设置：自动重启随保存提交，回执说「立即生效」（不需要重启实例）', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/instances')
    await page.getByRole('button', { name: 'E2E 演示实例 操作菜单' }).click()
    await page.getByRole('menuitem', { name: '实例设置' }).click()

    // 拨到关：只改草稿，弹窗保持打开
    await page.getByRole('switch', { name: '意外停止后自动重启' }).click()
    await expect(page.getByRole('heading', { name: '实例设置' })).toBeVisible()
    // 未保存就关：必须问一句（否则用户以为已经关掉了）
    await page.getByRole('button', { name: '取消' }).click()
    await expect(page.getByText('上面有未保存的更改，关闭后这些改动将丢失。')).toBeVisible()
    await page.getByRole('button', { name: '继续编辑' }).click()

    await page.getByRole('button', { name: '保存配置' }).click()
    // 自动重启改的是服务端内存态 ⇒ 回执不能跟着启动配置说「重启实例后生效」
    await expect(page.getByText('自动重启已关闭，立即生效')).toBeVisible()
    await expect(page.getByRole('heading', { name: '实例设置' })).toBeHidden()
    // 只改自动重启 ⇒ 不该出现「待重启」（启动配置逐字未变）
    await expect(page.getByText('待重启')).toHaveCount(0)
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
      page.getByText(
        '此操作不可撤销！将会：停止运行中的服务器、删除所有世界数据和配置、从数据库中移除记录',
      ),
    ).toBeVisible()
    await page.getByRole('button', { name: '取消' }).click()
    await expect(page.getByRole('heading', { name: '卸载实例' })).toBeHidden()
  })

  test('卸载：输入实例名经服务端校验后成功，提示保留的备份份数', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/instances')
    await page.getByRole('button', { name: 'E2E 演示实例 操作菜单' }).click()
    await page.getByRole('menuitem', { name: '卸载实例' }).click()

    // 服务端强制实例名确认：名字未输入前确认按钮不可用（UI 前置态）
    const confirmButton = page.getByRole('button', { name: '卸载「E2E 演示实例」' })
    await expect(confirmButton).toBeDisabled()
    await page.getByLabel(/输入实例名/).fill('E2E 演示实例')
    await expect(confirmButton).toBeEnabled()
    await confirmButton.click()

    // mock 确认通过：卸载不再销毁备份，成功提示必须报出保留份数（e2e-demo 有 2 份快照）
    await expect(page.getByText('实例 "E2E 演示实例" 已卸载，已保留 2 份备份')).toBeVisible()
    await expect(page.getByRole('heading', { name: '卸载实例' })).toBeHidden()
  })

  // 按钮文案带上实例名后比通用动词长，窄屏必须仍是一整块可点区域：
  // 基座是 whitespace-nowrap + shrink-0，超出只会溢出、不会换行，故量几何而不是看类名。
  // 用超长实例名（部署表单允许 50 字）压这一刻度：名字走 confirmTargetLabel 截断到
  // 26 个半角单位，不截断的话按钮会撑出对话框（列表接口在此用例内覆写）
  const LONG_NAME = '超长的中文实例名称用于压测按钮宽度'.repeat(3)
  for (const width of [375, 480]) {
    test(`窄屏 ${width}：点名实例的卸载按钮不溢出对话框也不被裁切`, async ({ page }) => {
      await page.setViewportSize({ width, height: 812 })
      await setupConnection(page)
      // 覆写列表：只改名称，其余字段复用真实 mock 的实例视图
      await page.route('**/api/v1/instances', async (route) => {
        const response = await route.fetch()
        const body = await response.json()
        body.data = body.data.map((row: { id: string }) =>
          row.id === 'e2e-demo' ? { ...row, name: LONG_NAME } : row,
        )
        await route.fulfill({ response, json: body })
      })
      await page.goto('/instances')
      await page.getByRole('button', { name: `${LONG_NAME} 操作菜单` }).click()
      await page.getByRole('menuitem', { name: '卸载实例' }).click()

      const button = page.getByRole('button', { name: /^卸载「.*」$/ })
      await expect(button).toBeVisible()
      // 截断真的生效：按钮名里带省略号，且不含完整超长名
      await expect(button).toHaveAccessibleName(/…」$/)
      const dialog = page.getByRole('dialog')
      const buttonBox = await button.boundingBox()
      const dialogBox = await dialog.boundingBox()
      expect(buttonBox).not.toBeNull()
      expect(dialogBox).not.toBeNull()
      // 按钮完整落在对话框内（左右各留 1px 容差给亚像素舍入）
      expect(buttonBox!.x).toBeGreaterThanOrEqual(dialogBox!.x - 1)
      expect(buttonBox!.x + buttonBox!.width).toBeLessThanOrEqual(
        dialogBox!.x + dialogBox!.width + 1,
      )
      // 文案不被裁：内容宽不超过按钮自身宽（溢出时 scrollWidth > clientWidth）
      const overflow = await button.evaluate((el) => el.scrollWidth - el.clientWidth)
      expect(overflow).toBeLessThanOrEqual(1)
      // 单行：高度仍在基座档位（h-10 = 40px），未被挤成两行
      expect(buttonBox!.height).toBeLessThanOrEqual(44)
    })
  }

  test('深链接：?tab=deploy 自动打开部署向导', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/instances?tab=deploy')
    // 向导自动打开（无需点击「部署新实例」）
    await expect(page.getByText('选择服务端', { exact: true })).toBeVisible()
    await expect(page.getByRole('radio', { name: /^原版/ })).toBeChecked()
    await expect(page).toHaveURL(/tab=deploy/)
    // 取消关闭 → URL 参数清除
    await page.getByRole('button', { name: '取消' }).click()
    await expect(page).toHaveURL(/\/instances$/)
  })

  test('单实例：恒定三列网格 + 引导块跨两列（列数不随实例数变化）', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await setupConnection(page)
    await page.goto('/instances')

    // mock 只有 1 个实例：网格仍是三列（列数恒定 ⇒ 骨架与真实网格不跳变），
    // 卡片占 1 列、引导块跨 2 列补满整行
    const grid = page.locator('[data-instance-id]').first().locator('..')
    expect(
      await grid.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length),
    ).toBe(3)
    const card = await page.locator('[data-instance-id]').first().boundingBox()
    const tile = await page.getByTestId('deploy-guide-tile').boundingBox()
    expect(card).not.toBeNull()
    expect(tile).not.toBeNull()
    // 跨两列 = 两倍卡宽 + 一个列间距（gap-3 = 12px）
    expect(Math.abs(tile!.width - (card!.width * 2 + 12))).toBeLessThanOrEqual(1)
    expect(tile!.x).toBeGreaterThan(card!.x)

    // 引导块入口与页头 CTA 同源（打开同一部署向导）
    await page.getByRole('button', { name: '打开部署向导' }).click()
    await expect(page.getByText('选择服务端', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '取消' }).click()

    // 窄屏（375）引导块落到卡片下方整幅宽度，无横向溢出
    await page.setViewportSize({ width: 375, height: 812 })
    await expect(page.getByTestId('deploy-guide-tile')).toBeVisible()
    const narrow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }))
    expect(narrow.scrollWidth).toBeLessThanOrEqual(narrow.clientWidth)
  })

  /**
   * 栅格列数按容器内容宽切档（@2xl=672 两列 / @5xl=1024 三列）。
   * jsdom 不评估容器查询，阈值只能在这里锁。768 视口展开侧栏内容 528px：
   * 改前视口 `md` 给两列、每张 258px，卡内四格指标行被压到 44px/格（"3.2 GB" 截断），
   * 现在必须单列。1279 视口折叠侧栏内容 1191px：改前差 1px 未达 `xl` 只给两列，
   * 现在必须三列
   */
  test('栅格按容器宽切档：768 展开侧栏单列、1279 折叠侧栏三列', async ({ page }) => {
    await setupConnection(page)

    const cols = () =>
      page
        .locator('[data-instance-id]')
        .first()
        .locator('..')
        .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length)

    // 768 展开侧栏（内容 528 < 672）⇒ 单列；卡片吃满，指标格不被压扁
    await page.setViewportSize({ width: 768, height: 900 })
    await page.goto('/instances')
    await expect(page.locator('[data-instance-id]').first()).toBeVisible()
    expect(await cols()).toBe(1)

    // 1279 折叠侧栏（内容 1191 ≥ 1024）⇒ 三列
    await page.getByRole('button', { name: '收起侧栏' }).click()
    await expect(page.getByRole('button', { name: '展开侧栏' })).toBeVisible()
    await page.setViewportSize({ width: 1279, height: 900 })
    expect(await cols()).toBe(3)

    // 两态都不得横向溢出
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBe(0)
  })
})
