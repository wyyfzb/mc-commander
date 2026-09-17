import { test, expect, type Page } from '@playwright/test'

/**
 * 长列表虚拟滚动：「全部」档下的尾部留白、行高恒定与滚动连续性
 *
 * 缺口：`scripts/mock-server.mjs` 只有 5 名玩家，「全部」档下表格高度不足一屏、
 * 没有可滚动高度 ⇒ 虚拟滚动的尾部留白与滚动连续性此前从未被实测。
 *
 * 夹具策略：在路由层取回既有 mock 响应后复制成 TOTAL 人，**不改 mock-server 的数据规模**——
 * 改 mock 会连带影响 players/dashboard/mobile 等既有 spec 的条数与计数断言。
 * jsdom 验不了本项（无布局引擎，虚拟滚动容器恒为 0 高），故只能在 e2e 实测。
 *
 * 夹具必须自带「在线 + 文本徽标 + 有 IP」的行：mock 玩家 `ip` 恒为空串、封禁玩家恒离线，
 * 该组合在既有夹具体系里结构性不可达，而它正是「次要行折行把行撑过 ROW_HEIGHT」的触发条件。
 */

const TOTAL = 60

/** 夹具姓名（与 injectLongList 的生成式一致，三位零填充） */
const playerName = (index: number) => `Player_${String(index).padStart(3, '0')}`

/** 滚动容器与虚拟窗口快照 */
async function snapshot(page: Page) {
  return page.evaluate(() => {
    const box = document.querySelector('main .overflow-auto') as HTMLElement | null
    const tbody = document.querySelector('main table tbody')
    const rows = tbody ? [...tbody.querySelectorAll('tr:not([aria-hidden])')] : []
    const last = rows[rows.length - 1] as HTMLElement | undefined
    const boxRect = box?.getBoundingClientRect()
    const lastRect = last?.getBoundingClientRect()
    return {
      clientH: box?.clientHeight ?? 0,
      scrollH: box?.scrollHeight ?? 0,
      scrollTop: Math.round(box?.scrollTop ?? 0),
      maxScroll: box ? box.scrollHeight - box.clientHeight : 0,
      horizontalOverflow: box ? box.scrollWidth - box.clientWidth : 0,
      renderedRows: rows.length,
      firstRow: rows[0]?.querySelector('button[aria-label^="查看"]')?.textContent ?? null,
      /** 行高去重集：虚拟滚动 estimateSize 的前提是恒等于 ROW_HEIGHT(40) */
      rowHeights: [...new Set(rows.map((r) => Math.round(r.getBoundingClientRect().height)))],
      /** 末行底边与容器底边的间距：≈0 即尾部无留白 */
      tailGap: boxRect && lastRect ? Math.round(boxRect.bottom - lastRect.bottom) : null,
    }
  })
}

async function scrollTo(page: Page, position: 'top' | 'bottom') {
  await page.evaluate((pos) => {
    const box = document.querySelector('main .overflow-auto')
    if (box) box.scrollTop = pos === 'bottom' ? box.scrollHeight : 0
  }, position)
}

/**
 * 把玩家列表扩到 TOTAL 人：姓名 `Player_000`…`Player_059`。
 * - 全部在线、`isOp`/`lastSeen`/`totalPlayTime` 拉平 ⇒ 默认排序（在线>OP>lastSeen>总时长）
 *   对它们全部无差别，稳定排序保持注入顺序；行数少时断言首行才有确定值。
 * - **每行都带 IP**（mock 恒为空串，故必须覆写）；文本徽标按 i % 5 轮换，
 *   其中 i % 5 === 0 是「临时封禁(倒计时)」——宽徽标与 IP 同时在次要行，即折行回归的触发组合。
 */
async function injectLongList(page: Page) {
  await page.route('**/api/v1/instances/*/players', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    const source = body.data
    body.data = Array.from({ length: TOTAL }, (_, i) => {
      const base = {
        ...source[i % source.length],
        uuid: `00000000-0000-4000-8000-${String(200000000000 + i)}`,
        name: playerName(i),
        isOnline: true,
        isOp: false,
        isWhitelisted: false,
        isAfk: false,
        isBanned: false,
        banExpiresAt: null,
        isIpBanned: false,
        lastSeen: null,
        totalPlayTime: 0,
        ip: `192.168.100.${(i % 250) + 1}`,
      }
      // 宽文本徽标（倒计时 ~103px）+ IP 同处次要行：折行回归的唯一触发形状
      if (i % 5 === 0) return { ...base, isBanned: true, banExpiresAt: Date.now() + 12 * 3600_000 }
      if (i % 5 === 1) return { ...base, isWhitelisted: true }
      if (i % 5 === 2) return { ...base, isAfk: true }
      return base
    })
    return route.fulfill({ response, json: body })
  })
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

/** 进「全部」档（只有该档启用 react-virtual 虚拟滚动）并等夹具就绪 */
async function openAllPage(page: Page) {
  await setupConnection(page)
  await injectLongList(page)
  await page.goto('/players')
  await expect(page.getByText(`${TOTAL} / ${TOTAL} 名玩家`)).toBeVisible()
  await page.selectOption('select[aria-label="每页行数"]', '-1')
  await expect.poll(async () => (await snapshot(page)).renderedRows).toBeGreaterThan(0)
  // 量几何前等字体与虚拟窗口落定：字体回退期行高与容器高都会变，冷启动并行跑时
  // 曾量到未落定的值（单次假红，单独重跑即过）。轮询到几何自洽为止——真的坏掉会超时红
  await page.evaluate(() => document.fonts.ready)
  await expect
    .poll(
      async () => {
        const s = await snapshot(page)
        return s.scrollH > s.clientH && s.rowHeights.length > 0 && s.rowHeights.every((h) => h === 40)
      },
      { message: '等待列表几何落定（可滚动 + 行高恒为 40）' },
    )
    .toBe(true)
}

test.describe('长列表虚拟滚动（「全部」档）', () => {
  test('60 人：可滚动、行高恒定 40px、尾部无留白、真的能滚到底', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await openAllPage(page)

    // 1. 真出现可滚动高度（本项此前从未被实测的前提条件）
    const top = await snapshot(page)
    expect(top.scrollH).toBeGreaterThan(top.clientH)
    expect(top.scrollTop).toBe(0)
    // 2. 虚拟化生效：渲染行数远少于总数，且首行是第一名玩家（夹具排序键已拉平）
    expect(top.renderedRows).toBeLessThan(TOTAL)
    expect(top.firstRow).toBe(playerName(0))
    // 3. 行高恒定 —— 虚拟滚动 estimateSize 的前提。夹具含「宽徽标 + IP」行，
    //    次要行一旦折行这里立刻变红（实测该回归把行撑到 59px）
    expect(top.rowHeights).toEqual([40])

    // 4. 滚到底：真的到达容器底部（scrollTop 被钳位/抖动即说明高度模型不可信）
    //    且末行底边贴住容器底边（尾部不留白）
    await scrollTo(page, 'bottom')
    await expect
      .poll(
        async () => {
          const s = await snapshot(page)
          return Math.abs(s.maxScroll - s.scrollTop) <= 1 && s.tailGap !== null && Math.abs(s.tailGap) <= 4
        },
        { message: '等待滚动容器落到底部且尾部无留白' },
      )
      .toBe(true)
    const bottom = await snapshot(page)
    expect(bottom.rowHeights).toEqual([40])
    expect(bottom.horizontalOverflow).toBe(0)
    expect(bottom.firstRow).not.toBe(top.firstRow)

    // 5. 滚回顶部：首行与初次一致（滚动连续性，虚拟窗口随滚动位置重建）
    await scrollTo(page, 'top')
    await expect
      .poll(async () => (await snapshot(page)).firstRow, { message: '等待回到顶部' })
      .toBe(playerName(0))
    const back = await snapshot(page)
    expect(back.scrollTop).toBe(0)
    expect(back.rowHeights).toEqual([40])
    expect(back.horizontalOverflow).toBe(0)
  })

  test('640–1440 全档行高恒为 40px（含「在线 + 临时封禁 + IP」行）', async ({ page }) => {
    await openAllPage(page)

    for (const width of [640, 800, 1024, 1280, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      await expect
        .poll(async () => (await snapshot(page)).rowHeights, { message: `${width}px 下行高` })
        .toEqual([40])
      // 夹具里的封禁行（宽徽标 + IP）确实在渲染窗口内，否则上面的断言是空转
      expect(await page.locator('main table tbody').getByText(/封禁·剩/).count()).toBeGreaterThan(0)
    }
  })
})

/**
 * 分页栏的「共 N 条 · 第 x/y 页」与筛选条计数是同一形态——CJK 文案的断行点
 * 落在任意字符间，375 下会被压成逐字竖排。此处的 60 人夹具是本仓**唯一**能让
 * 分页栏出现多页文案（`共 60 条 · 第 1/3 页` + 页码组）的现场：mock 只有 5 人，
 * 单页时 `showPager` 为假、文案退化成「共 5 条」，测不到该形态。
 */
test.describe('窄屏分页栏（375）', () => {
  test('375px：条数/页码不折成竖排，分页栏与主区均无横向溢出', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await setupConnection(page)
    await injectLongList(page)
    await page.goto('/players')
    await expect(page.getByText(`${TOTAL} / ${TOTAL} 名玩家`)).toBeVisible()

    const info = page.getByText(/共 \d+ 条 · 第 \d+\/\d+ 页/)
    await expect(info).toBeVisible()
    const metrics = await info.evaluate((el) => {
      const cs = getComputedStyle(el)
      return {
        height: el.getBoundingClientRect().height,
        lineHeight: parseFloat(cs.lineHeight),
        whiteSpace: cs.whiteSpace,
      }
    })
    // 先断症状（逐字竖排会把行高撑成多倍），再断机制（nowrap）
    expect(metrics.height).toBeLessThanOrEqual(metrics.lineHeight * 1.5)
    expect(metrics.whiteSpace).toBe('nowrap')

    // 分页栏自身（每页选择器的祖父节点即分页栏根）不得横向溢出
    const barOverflow = await page
      .getByLabel('每页行数')
      .locator('xpath=../..')
      .evaluate((el) => el.scrollWidth - el.clientWidth)
    expect(barOverflow).toBeLessThanOrEqual(0)

    const mainOverflow = await page
      .locator('#main-content')
      .evaluate((el) => el.scrollWidth - el.clientWidth)
    expect(mainOverflow).toBeLessThanOrEqual(0)
  })
})
