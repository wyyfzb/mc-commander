import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'

/**
 * 世界页 E2E（数据源：同目录 mock-server.mjs，世界/属性数据为结构占位虚构内容）
 * 验收：左栏世界信息卡+维度卡 / 属性 Tab 编辑保存 / gamerule Tab 查询+行级编辑 / 视觉截图
 */

// 可选截图（调试用）：设 E2E_SHOT=1 时输出到 test-results/shots/，默认关闭
const SHOT_DIR = path.join(import.meta.dirname, 'test-results', 'shots')

/** 可见文本（剔除 sr-only 的完整解释）：子串匹配咬不住文案本身，逐字比对才咬得住 */
function visibleText(locator: import('@playwright/test').Locator) {
  return locator.evaluate((el) => {
    const clone = el.cloneNode(true) as HTMLElement
    clone.querySelectorAll('.sr-only').forEach((n) => n.remove())
    return clone.textContent
  })
}
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

test.describe('世界页', () => {
  test('左栏世界信息卡 + 维度卡渲染', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/world')
    // 世界信息卡：名称/种子/天数
    await expect(page.getByRole('heading', { name: '世界信息' })).toBeVisible()
    // 手写 h3 与 mcs/card 基座 heading 必须同配方（18px / w600 / text-default），
    // 否则「同一个 lg 档」存在两套观感，后续迁入基座就不再是零视觉变化
    const infoTitle = page.getByRole('heading', { name: '世界信息' })
    const infoStyle = (prop: string) =>
      infoTitle.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop)
    expect(await infoStyle('font-size')).toBe('18px')
    expect(await infoStyle('font-weight')).toBe('600')
    expect(await infoStyle('color')).toBe(
      await page.locator('body').evaluate((el) => getComputedStyle(el).color),
    )
    await expect(page.getByText('演示世界')).toBeVisible()
    await expect(page.getByText('887654321')).toBeVisible()
    await expect(page.getByText('42 天')).toBeVisible()
    // 难度/游戏模式 PillBadge（normal → 普通；survival → 生存）
    await expect(page.getByText('普通')).toBeVisible()
    await expect(page.getByText('生存', { exact: true })).toBeVisible()
    // 维度卡 3 张
    for (const name of ['主世界', '下界', '末地']) {
      await expect(page.getByText(name)).toBeVisible()
    }
    await maybeShot(page, 'world-info-dark.png')
  })

  /**
   * 主从分栏阈值为容器档 @3xl=768px（左栏 320 + 列距 16 + 右栏最小 432）。
   * jsdom 不评估容器查询，阈值只能在这里锁。两条各锁一头：
   * - 1023 视口展开侧栏内容 784px：改前差 1px 未达 lg 仍上下堆叠，现在必须分栏
   * - 900 视口展开侧栏内容 660px：分栏会把右栏压到 324px，必须继续堆叠
   */
  test('主从分栏按容器宽切档：1023 视口分栏、900 视口堆叠', async ({ page }) => {
    await setupConnection(page)

    // 分栏：左栏与右栏同一行（left 相差 >10px 且 top 对齐）
    await page.setViewportSize({ width: 1023, height: 900 })
    await page.goto('/world')
    await expect(page.getByRole('heading', { name: '世界信息' })).toBeVisible()
    const split = await page.evaluate(() => {
      const left = document.querySelector('main .overflow-y-auto')!
      const right = document.querySelector('main .flex.min-h-0.min-w-0')!
      const l = left.getBoundingClientRect()
      const r = right.getBoundingClientRect()
      return {
        sameRow: Math.abs(l.top - r.top) < 4,
        rightOfLeft: r.left > l.left + 10,
        leftW: l.width,
      }
    })
    expect(split.sameRow).toBe(true)
    expect(split.rightOfLeft).toBe(true)
    expect(split.leftW).toBe(320)

    // 堆叠：右栏落到左栏下方
    await page.setViewportSize({ width: 900, height: 900 })
    await expect(page.getByRole('heading', { name: '世界信息' })).toBeVisible()
    const stacked = await page.evaluate(() => {
      const left = document.querySelector('main .overflow-y-auto')!
      const right = document.querySelector('main .flex.min-h-0.min-w-0')!
      const l = left.getBoundingClientRect()
      const r = right.getBoundingClientRect()
      return { below: r.top >= l.bottom - 1, fullWidth: Math.abs(r.width - l.width) < 2 }
    })
    expect(stacked.below).toBe(true)
    expect(stacked.fullWidth).toBe(true)

    // 两态都不得横向溢出
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBe(0)
  })

  test('侧栏实例卡刷新语义（结果说明）：未连通时说「轮询」且不截断', async ({ page }) => {
    await setupConnection(page)
    // 故意从世界页进：这条结果的真值不依赖当前页面（它若取 store，只有仪表盘会写，
    // 于是从别的页面进来会拿到空值）
    await page.goto('/world')
    // 桌面 rail 与移动抽屉各渲染一份迷你卡：抽屉那份 aria-hidden/inert，仍按名字精确限定
    const rail = page.getByRole('complementary', { name: '主导航', exact: true })
    const line = rail.getByText('运行中 · 3 人在线 · 轮询')
    await expect(line).toBeVisible({ timeout: 10_000 })
    // 逐字比对可见文本（剔除 sr-only）：`getByText` 是**子串**匹配，把标签改成「轮询中」
    // 它照样命中——那种断言咬不住文案本身
    expect(await visibleText(line)).toBe('运行中 · 3 人在线 · 轮询')
    // 标签必须短到不截断：该行内容宽实测 149px（「运行中 · 3 人在线」占 90px），带空格的
    // 整句「每 30 秒刷新」要 172px，会被 ellipsis 吃掉尾巴。这条只有真实布局能量到，jsdom 恒 0
    expect(await line.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0)
  })

  test('侧栏实例卡刷新语义：实例详情报 msmpPush=true ⇒ 说「实时」', async ({ page }) => {
    await setupConnection(page)
    // 用 route 造出「推送面已连通」这一真值：mock 的通道是关的，缺这条就只剩单测证据
    await page.route('**/api/v1/instances/*', async (route) => {
      const res = await route.fetch()
      const body = (await res.json()) as { data?: { capabilities?: { msmpPush?: boolean } } }
      if (body?.data?.capabilities) body.data.capabilities.msmpPush = true
      await route.fulfill({ response: res, json: body })
    })
    await page.goto('/world')
    const rail = page.getByRole('complementary', { name: '主导航', exact: true })
    const line = rail.getByText('运行中 · 3 人在线 · 实时')
    await expect(line).toBeVisible({ timeout: 10_000 })
    // 逐字比对可见文本：子串匹配下「实时更新」这类改法照样命中
    expect(await visibleText(line)).toBe('运行中 · 3 人在线 · 实时')
    // 正档同样不得被 ellipsis 吃掉（实测 128px / 内容宽 149px）；jsdom 量不到真实几何
    expect(await line.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0)
    // 顶栏已不承载这条结果（它只报连接档位）
    await expect(page.getByText('已连接 · 实时')).toHaveCount(0)
  })

  test('属性 Tab：默认渲染 + 编辑保存流程', async ({ page }) => {
    await setupConnection(page)
    await page.goto('/world')
    // 默认属性 Tab：motd 键（mono）与占位值可见；敏感键锁定占位
    await expect(page.getByText('motd', { exact: true })).toBeVisible()
    // motd 为 Input 控件（值在 value 属性，非文本节点）
    await expect(page.getByLabel('MOTD 输入')).toHaveValue('E2E 演示服务器')
    await expect(page.getByText('********').first()).toBeVisible()
    // 进入编辑 → 提示条出现
    await page.getByRole('button', { name: '编辑' }).click()
    await expect(
      page.getByText('编辑模式已开启 — 你可以修改服务器属性，完成后点击「保存」或「取消」'),
    ).toBeVisible()
    // 切 pvp 开关并保存 → PUT /properties（mock 返回 restartRequired: []）
    await page.getByRole('switch', { name: 'PvP 开关' }).click()
    await page.getByRole('button', { name: '保存' }).click()
    await expect(page.getByText('规则已保存到服务器')).toBeVisible()
    await maybeShot(page, 'world-properties-dark.png')
  })

  test('游戏规则 Tab：名单来自端点 + 三态渲染 + 行级编辑保存后重取', async ({ page }) => {
    await setupConnection(page)
    // 取数次数由本 spec 自己数：端点回包与「保存后重取」都只有这一条链路的证据
    let gameruleHits = 0
    page.on('request', (req) => {
      if (req.url().includes('/gamerules')) gameruleHits++
    })
    // 保存下发的值从请求体里取，不从夹具常量推：mock 的规则值会被写命令改掉，
    // 写死期望值在 CI 重试时（同一进程的第二次运行）会把断言锚在旧状态上
    let sentRule = ''
    page.on('request', (req) => {
      if (!req.url().endsWith('/command')) return
      const body = req.postDataJSON() as { command?: string } | null
      const m = /^gamerule\s+(\S+)\s+(\S+)$/.exec(body?.command ?? '')
      if (m) sentRule = `${m[1]} = ${m[2]}`
    })
    await page.goto('/world')
    await page.getByRole('tab', { name: '游戏规则' }).click()
    // URL 深链接：Tab 状态写入 ?tab=
    await expect(page).toHaveURL(/tab=gamerule/)

    // 名单以服务器自述为准：这两条在面板文案表里查不到，只由端点回包给出，
    // 故它们出现即证明行是按端点名单渲染的，不是按静态表
    await expect(page.getByText('doFireTick', { exact: true })).toBeVisible()
    await expect(page.getByText('spawnChunkRadius', { exact: true })).toBeVisible()
    // 文案表能查到的规则同样由端点给名，值控件按端点类型渲染
    await expect(page.getByText('doDaylightCycle', { exact: true })).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'maxEntityCramming 值' })).toHaveValue('24')
    // 徽章表达取值通道（MSMP / RCON 两档，取端点 source 字段）而非版本：这里只要求
    // 有一枚通道徽章在，不锁具体哪一档——换档由 mock 回包决定，不是断言对象
    await expect(page.getByText(/^(MSMP|RCON)$/)).toBeVisible()

    // missing：灰标「未读取」且**不渲染值控件**（开关的「关」会被读成事实）
    const missingRow = page.getByTestId('gamerule-row-doVillageSieges')
    await expect(missingRow).toContainText('未读取')
    await expect(missingRow.getByRole('switch')).toHaveCount(0)
    await expect(missingRow.getByRole('textbox')).toHaveCount(0)
    // unreadable 与 missing 的呈现同形，原因文案不同（读失败 vs 本版本没有）
    const unreadableRow = page.getByTestId('gamerule-row-keepInventory')
    await expect(unreadableRow).toContainText('未读取')
    await expect(unreadableRow.getByRole('switch')).toHaveCount(0)

    // StrictMode 下挂载期的 effect 会跑两遍，取数次数因此有 1~2 发的浮动——
    // 断言只锁「保存后恰好多一轮」，绝对值锁在这里是锁 StrictMode 的实现细节
    const hitsAfterMount = gameruleHits

    // 行级编辑：切首行 switch（写成它的相反值）→ 行尾保存 → 乐观值 + toast + 重新取数一次
    const firstSwitch = page.getByRole('switch', { name: 'allowEnteringNetherUsingPortals 开关' })
    const before = await firstSwitch.getAttribute('data-state')
    await firstSwitch.click()
    await page.getByRole('button', { name: '保存' }).click()
    // 下发值同样由观测得出：mock 的规则值会被写命令改掉，写死期望值在重跑时会锚在旧状态
    await expect
      .poll(() => sentRule)
      .toBe('allowEnteringNetherUsingPortals = ' + (before === 'checked' ? 'false' : 'true'))
    await expect(page.getByText('已更新规则 ' + sentRule)).toBeVisible()
    // 乐观值：控件先显示刚提交的那一档，不等端点回来
    await expect(firstSwitch).toHaveAttribute(
      'data-state',
      before === 'checked' ? 'unchecked' : 'checked',
    )
    // 保存后必须重新取数一次（乐观值只活到这一轮回来）；不轮询 ⇒ 不会多出第三轮
    await expect.poll(() => gameruleHits).toBe(hitsAfterMount + 1)
    await maybeShot(page, 'world-gamerules-dark.png')
  })

  test('游戏规则 Tab：两条通道都不可用 ⇒ 整块「未能读取当前值」，不画任何规则行', async ({
    page,
  }) => {
    await setupConnection(page)
    // 「读不到」按请求头构造（mock 侧不落进程级开关，否则会改脏并行 spec 的规则列表）
    await page.setExtraHTTPHeaders({ 'x-mock-gamerules-source': 'none' })
    // 契约层：两条通道都不可用时 source='none' 且**不带** rosterFailed。
    // 界面区分不出这一档（两个字段的结论都是「未读取」），所以只能在这一层咬住——
    // 一旦 none 也带上 rosterFailed，「查连接」与「重试」的判据就永久丢失且无人发现
    const noneBody = await page.request.get('/api/v1/instances/e2e-demo/gamerules', {
      headers: { 'x-mock-gamerules-source': 'none' },
    })
    const noneData = (await noneBody.json()).data as { source: string; rosterFailed?: boolean }
    expect(noneData.source).toBe('none')
    expect(noneData.rosterFailed).toBeUndefined()

    await page.goto('/world?tab=gamerule')
    await expect(page.getByText(/未能读取当前值/)).toBeVisible()
    // 两通道都不通是连接问题，措辞必须指向它——与下一条「名单没答上来」区分开
    await expect(page.getByText(/命令通道与推送通道都不可用/)).toBeVisible()
    // 不回退任何默认值：一条规则行、一个值控件都不画
    await expect(page.locator('[data-testid^="gamerule-row-"]')).toHaveCount(0)
    await expect(page.getByRole('switch')).toHaveCount(0)
  })

  test('游戏规则 Tab：通道通但名单查询失败 ⇒ 说「名单」可重试，不说「通道都不可用」', async ({
    page,
  }) => {
    await setupConnection(page)
    // source 仍是 rcon（通道是通的），只是这一问没答上来 ⇒ rosterFailed
    await page.setExtraHTTPHeaders({ 'x-mock-gamerules-source': 'roster-failed' })
    const failedBody = await page.request.get('/api/v1/instances/e2e-demo/gamerules', {
      headers: { 'x-mock-gamerules-source': 'roster-failed' },
    })
    const failedData = (await failedBody.json()).data as {
      source: string
      rules: unknown[]
      rosterFailed?: boolean
    }
    expect(failedData.source).toBe('rcon')
    expect(failedData.rules).toEqual([])
    expect(failedData.rosterFailed).toBe(true)

    await page.goto('/world?tab=gamerule')
    // 结论落在「名单」上：用户该做的是重试，不是去查连接
    await expect(page.getByText(/未能读取规则名单/)).toBeVisible()
    await expect(page.getByRole('button', { name: /重试/ })).toBeVisible()
    // 反过来：把它报成「两条通道都不可用」是假结论，用户会去改一个没坏的配置
    await expect(page.getByText(/命令通道与推送通道都不可用/)).toHaveCount(0)
    // 空名单不是「没有规则」：不能画成空态，也不能给任何默认值控件
    await expect(page.getByText('未读取到任何规则')).toHaveCount(0)
    await expect(page.locator('[data-testid^="gamerule-row-"]')).toHaveCount(0)
  })

  test('属性面板窄屏（375px）：键名与值上下堆叠，全部键名不再被裁', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await setupConnection(page)
    await page.goto('/world')
    await expect(page.getByRole('heading', { name: '世界信息' })).toBeVisible()

    const rows = page.locator('[data-prop]')
    // 属性清单来自 GET /properties，等首行落定再量（空集合会让下面两条断言空转）
    await expect(rows.first()).toBeVisible()
    const rowCount = await rows.count()
    expect(rowCount).toBeGreaterThan(0)

    // xs（30rem=480px）以下改为纵向堆叠：行内 176px 固定值列会把长键名裁到 2-3 字可见
    const directions = await rows.evaluateAll((els) =>
      els.map((el) => getComputedStyle(el).flexDirection),
    )
    expect(new Set(directions)).toEqual(new Set(['column']))

    // 堆叠后键名拿到整行宽度：逐行量「截断溢出量」，任何一行 > 0 都算回归
    const overflow = await rows.evaluateAll((els) =>
      els.map((row) => {
        const name = row.querySelector('[data-prop-name]')
        return name ? name.scrollWidth - name.clientWidth : -1
      }),
    )
    expect(overflow.filter((n) => n !== 0)).toEqual([])
    // 页面级不横向溢出（堆叠不能把内容撑破视口）
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
    expect(scrollWidth).toBeLessThanOrEqual(375)
    await maybeShot(page, 'world-properties-375.png')
  })
})
