/**
 * GamerulePanel —— 世界页「游戏规则」面板。
 *
 * 数据走 `GET /instances/:id/gamerules`（名单与当前值都由服务器自述），故这里真跑 react-query +
 * msw，不 mock api 层：一次挂载发几次请求、保存后是否刷新，只有走真链路才断言得到。
 *
 * 夹具覆盖三态（current / missing / unreadable）与一条**文案表里没有**的规则：
 * 后者用来钉住「查不到中文名只影响文案，不影响该行是否出现、是否可编辑」。
 * 规则名与取值均为公开的游戏数据，不含真实服务器信息。
 */
import { StrictMode } from 'react'
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { Toaster, toast as sonnerToast } from 'sonner'
import { GamerulePanel } from '@/features/world/components/gamerule-panel'
import { useConnectionStore } from '@/stores/connection'
import type { GamerulesResponse } from '@/api/types'

type SendCommand = (command: string) => Promise<string | null>

function ok<T>(data: T) {
  return HttpResponse.json({
    status: 'ok',
    code: 0,
    message: 'Success',
    data,
    timestamp: new Date().toISOString(),
  })
}

/** 三态齐备：两条有值、一条本版本没有、一条读取失败，外加一条文案表里没有的规则 */
const SNAPSHOT: GamerulesResponse = {
  source: 'rcon',
  rules: [
    { name: 'keepInventory', status: 'current', type: 'boolean', value: 'false' },
    { name: 'randomTickSpeed', status: 'current', type: 'integer', value: '3' },
    { name: 'spawnChunkRadius', status: 'current', type: 'integer', value: '2' },
    { name: 'doVillageSieges', status: 'missing', type: null, value: null },
    { name: 'announceAdvancements', status: 'unreadable', type: null, value: null },
  ],
}

let gameruleHits = 0
let snapshot: GamerulesResponse = SNAPSHOT
let commandHandler: (cmd: string) => void = () => {}
let snapshotStatus = 200

const server = setupServer(
  http.get('*/api/v1/instances/inst-1/gamerules', () => {
    gameruleHits++
    if (snapshotStatus !== 200) {
      return HttpResponse.json(
        { status: 'error', code: 50300, message: 'rcon offline', details: null, timestamp: '' },
        { status: snapshotStatus },
      )
    }
    return ok(snapshot)
  }),
  http.post('*/api/v1/instances/inst-1/command', async ({ request }) => {
    const body = (await request.json()) as { command?: string }
    commandHandler(body.command ?? '')
    return ok('Game rule has been updated')
  }),
)

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
afterAll(() => server.close())

beforeEach(() => {
  // sonner toast 存于模块级 store，跨测试残留会导致同文案 toast 重复匹配
  sonnerToast.dismiss()
  localStorage.clear()
  useConnectionStore.setState({ baseUrl: '', apiKey: 'test-key', status: 'ready' })
  gameruleHits = 0
  snapshot = SNAPSHOT
  snapshotStatus = 200
  commandHandler = () => {}
})

function renderPanel(opts: { connected?: boolean; mcVersion?: string; send?: SendCommand } = {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const onSendCommand: SendCommand = opts.send ?? vi.fn(async () => 'Game rule has been updated')
  // StrictMode：main.tsx 挂在它下面，开发期 effect 会双执行。不套它，测试里的「一次挂载」
  // 与真实浏览器就不是同一件事，请求次数断言会在真机上失守
  render(
    <StrictMode>
      <QueryClientProvider client={qc}>
        <GamerulePanel
          instanceId="inst-1"
          mcVersion={opts.mcVersion ?? '1.21.4'}
          isRconConnected={opts.connected ?? true}
          onSendCommand={onSendCommand}
        />
        <Toaster />
      </QueryClientProvider>
    </StrictMode>,
  )
  return { onSendCommand, qc }
}

/** 取某一行的容器（行根节点带 data-testid，未读取态没有值控件可当锚点） */
function row(name: string): HTMLElement {
  return screen.getByTestId(`gamerule-row-${name}`)
}

describe('GamerulePanel 三态渲染', () => {
  it('current：有值 ⇒ 渲染可编辑控件（布尔行是开关、整数行是输入框）', async () => {
    renderPanel()
    expect(await screen.findByText('keepInventory')).toBeInTheDocument()
    const sw = within(row('keepInventory')).getByRole('switch', { name: 'keepInventory 开关' })
    expect(sw).toHaveAttribute('data-state', 'unchecked') // 端点值 false
    const input = within(row('randomTickSpeed')).getByLabelText('randomTickSpeed 值')
    expect(input).toHaveValue('3')
    expect(input).not.toBeDisabled()
  })

  it('missing：灰标「未读取」+ 原因走可聚焦浮层 + 不渲染任何值控件', async () => {
    const user = userEvent.setup()
    renderPanel()
    await screen.findByText('doVillageSieges')
    const r = row('doVillageSieges')
    expect(r).toHaveAttribute('data-rule-status', 'missing')
    expect(within(r).getByText('未读取')).toBeInTheDocument()
    // 关键：不能退化成「开关关着」或「数字是 0」——那会把「没读到」读成事实
    expect(within(r).queryByRole('switch')).not.toBeInTheDocument()
    expect(within(r).queryByRole('textbox')).not.toBeInTheDocument()
    // 解释必须键盘与触屏都拿得到（裸 title 两者都取不到）
    await user.click(within(r).getByRole('button', { name: 'doVillageSieges 未读取原因' }))
    expect(
      await screen.findByRole('dialog', { name: 'doVillageSieges 未读取原因' }),
    ).toHaveTextContent('当前服务器版本没有这条规则，无法读取或修改')
  })

  it('unreadable：同样灰标禁用，但原因文案与 missing 不同', async () => {
    const user = userEvent.setup()
    renderPanel()
    await screen.findByText('announceAdvancements')
    const r = row('announceAdvancements')
    expect(r).toHaveAttribute('data-rule-status', 'unreadable')
    expect(within(r).getByText('未读取')).toBeInTheDocument()
    expect(within(r).queryByRole('switch')).not.toBeInTheDocument()
    expect(within(r).queryByRole('textbox')).not.toBeInTheDocument()
    await user.click(within(r).getByRole('button', { name: 'announceAdvancements 未读取原因' }))
    expect(
      await screen.findByRole('dialog', { name: 'announceAdvancements 未读取原因' }),
    ).toHaveTextContent('读取当前值失败，可点「刷新」重试')
  })
})

describe('GamerulePanel 通道徽章', () => {
  it("source='msmp' ⇒ 徽章显示 MSMP，且规则行照常可编辑", async () => {
    snapshot = { source: 'msmp', rules: SNAPSHOT.rules }
    renderPanel()
    await screen.findByText('keepInventory')
    expect(screen.getByText('MSMP', { exact: true })).toBeInTheDocument()
    expect(screen.queryByText('RCON', { exact: true })).not.toBeInTheDocument()
    // 通道只解释「值从哪来」，不改变可编辑性
    expect(within(row('randomTickSpeed')).getByLabelText('randomTickSpeed 值')).not.toBeDisabled()
  })

  it("source='rcon' ⇒ 徽章显示 RCON", async () => {
    renderPanel()
    await screen.findByText('keepInventory')
    expect(screen.getByText('RCON', { exact: true })).toBeInTheDocument()
    expect(screen.queryByText('MSMP', { exact: true })).not.toBeInTheDocument()
  })

  it("source='none' ⇒ 不显示任何通道徽章（没有通道可交代）", async () => {
    snapshot = { source: 'none', rules: [] }
    renderPanel()
    await screen.findByText(/未能读取当前值/)
    expect(screen.queryByText('MSMP', { exact: true })).not.toBeInTheDocument()
    expect(screen.queryByText('RCON', { exact: true })).not.toBeInTheDocument()
  })
})

describe('GamerulePanel 名单以服务器自述为准', () => {
  it('文案表里没有的规则照常出现且可编辑（只缺中文描述，不影响该行）', async () => {
    const user = userEvent.setup()
    const { onSendCommand } = renderPanel()

    // spawnChunkRadius 不在 1.21.4 的文案表里：显示原始名、没有描述，但控件齐全
    expect(await screen.findByText('spawnChunkRadius')).toBeInTheDocument()
    const input = within(row('spawnChunkRadius')).getByLabelText('spawnChunkRadius 值')
    expect(input).toHaveValue('2')
    expect(input).not.toBeDisabled()

    await user.clear(input)
    await user.type(input, '4')
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSendCommand).toHaveBeenCalledWith('gamerule spawnChunkRadius 4'))
  })

  it('文案表没有的规则也不会被搜索藏掉（按原始名命中）', async () => {
    const user = userEvent.setup()
    renderPanel()
    await screen.findByText('keepInventory')
    await user.type(screen.getByLabelText('搜索规则'), 'spawnChunk')
    expect(screen.getByText('spawnChunkRadius')).toBeInTheDocument()
    expect(screen.queryByText('keepInventory')).not.toBeInTheDocument()
  })
})

describe('GamerulePanel 读取失败', () => {
  it("source='none' ⇒ 整块「未能读取当前值」+ 重试，且不显示任何规则行", async () => {
    snapshot = { source: 'none', rules: [] }
    renderPanel()
    expect(await screen.findByText(/未能读取当前值/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /重试/ })).toBeInTheDocument()
    // 不回退任何默认值：一条规则行都不画
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    expect(screen.queryByText('未读取到任何规则')).not.toBeInTheDocument()
  })

  it('source=none 时点重试会重新请求，取到后恢复列表', async () => {
    snapshot = { source: 'none', rules: [] }
    const user = userEvent.setup()
    renderPanel()
    await screen.findByText(/未能读取当前值/)
    expect(gameruleHits).toBe(1)

    snapshot = SNAPSHOT
    await user.click(screen.getByRole('button', { name: /重试/ }))
    expect(await screen.findByText('keepInventory')).toBeInTheDocument()
    expect(gameruleHits).toBe(2)
    expect(screen.queryByText(/未能读取当前值/)).not.toBeInTheDocument()
  })

  /* rosterFailed 与 source='none' 都是空 rules，但成因不同：前者通道通、只是名单那一问没答上来，
     用户该重试；后者是两条通道都不通，用户该去查连接。两种措辞各锁一条，且互相不许出现。 */
  it('rosterFailed ⇒ 「未能读取规则名单，可点重试」，不画规则行，也不说「通道都不可用」', async () => {
    snapshot = { source: 'rcon', rules: [], rosterFailed: true }
    renderPanel()
    expect(await screen.findByText('未能读取规则名单，可点重试')).toBeInTheDocument()
    expect(screen.queryByText(/命令通道与推送通道都不可用/)).not.toBeInTheDocument()
    expect(screen.queryByText(/未能读取当前值/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /重试/ })).toBeInTheDocument()
    // 不画任何规则行（空 rules 不得被当成「一条规则都没有」的事实）
    expect(screen.queryByTestId(/^gamerule-row-/)).not.toBeInTheDocument()
    expect(screen.queryByText('未读取到任何规则')).not.toBeInTheDocument()
    // 通道是通的：徽章照常显示实际通道
    expect(screen.getByText('RCON', { exact: true })).toBeInTheDocument()
  })

  it("source='none' ⇒ 说「命令通道与推送通道都不可用」，不说「规则名单」", async () => {
    snapshot = { source: 'none', rules: [] }
    renderPanel()
    // 文案整句是「未能读取当前值：命令通道与推送通道都不可用」，故两条短语各断一次
    expect(await screen.findByText(/未能读取当前值/)).toBeInTheDocument()
    expect(screen.getByText(/命令通道与推送通道都不可用/)).toBeInTheDocument()
    expect(screen.queryByText(/未能读取规则名单/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /重试/ })).toBeInTheDocument()
  })

  it('请求本身失败 ⇒ 同一出口提示「未能读取当前值」并说明原因', async () => {
    snapshotStatus = 503
    renderPanel()
    expect(await screen.findByText(/未能读取当前值/)).toBeInTheDocument()
    expect(screen.getByText(/rcon offline/)).toBeInTheDocument()
  })
})

describe('GamerulePanel 请求次数', () => {
  /* 这一条锁的是「一次挂载 = 一次取数」的接线（不轮询、StrictMode 下不翻倍）。
     jsdom 里 msw 是立即 resolve 的，抓不到「在途请求被中止后重取」那条路径——
     实际浏览器有代理延迟，StrictMode 卸载会中止在途请求并让第二次挂载重取一发，
     那份证据由 e2e 的请求计数持有，不在这里重复。 */
  it('一次挂载只发一次请求（StrictMode 下 effect 双执行也不得翻倍；不轮询）', async () => {
    renderPanel()
    await screen.findByText('keepInventory')
    // 给可能的二次请求留出落地时间：多打一次就会在下面被数到
    await new Promise((r) => setTimeout(r, 50))
    expect(gameruleHits).toBe(1)
  })

  it('同 key 重挂载（切走再切回本 Tab）在 staleTime 内复用缓存，不重打', async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    const view = (key: string) => (
      <StrictMode>
        <QueryClientProvider client={qc}>
          <GamerulePanel
            key={key}
            instanceId="inst-1"
            mcVersion="1.21.4"
            isRconConnected
            onSendCommand={async () => 'ok'}
          />
        </QueryClientProvider>
      </StrictMode>
    )
    const first = render(view('a'))
    await screen.findByText('keepInventory')
    await new Promise((r) => setTimeout(r, 50))
    expect(gameruleHits).toBe(1)

    first.unmount()
    render(view('b'))
    await screen.findByText('keepInventory')
    await new Promise((r) => setTimeout(r, 50))
    // staleTime 挡的是「刚取过又立刻重取」：整份快照背后是几十条串行命令
    expect(gameruleHits).toBe(1)
  })

  it('RCON 未连接：不发请求 + 提示通道不可用 + 控件与刷新禁用', async () => {
    renderPanel({ connected: false })
    expect(screen.getByText('gamerule 修改需要 RCON 连接')).toBeInTheDocument()
    await new Promise((r) => setTimeout(r, 50))
    expect(gameruleHits).toBe(0)
    expect(screen.getByRole('button', { name: '刷新规则' })).toBeDisabled()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  })
})

describe('GamerulePanel 行级编辑', () => {
  it('bool：点开关 → 保存/取消出现 → 保存下发命令 + 乐观写值 + 保存后刷新一次', async () => {
    const user = userEvent.setup()
    const { onSendCommand } = renderPanel()
    await screen.findByText('keepInventory')

    await user.click(
      within(row('keepInventory')).getByRole('switch', { name: 'keepInventory 开关' }),
    )
    expect(screen.getByRole('button', { name: '保存' })).toBeInTheDocument()
    // 刷新后服务端也认这条改动：保存后的重取要与乐观值一致
    snapshot = {
      source: 'rcon',
      rules: SNAPSHOT.rules.map((r) => (r.name === 'keepInventory' ? { ...r, value: 'true' } : r)),
    }
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(onSendCommand).toHaveBeenCalledWith('gamerule keepInventory true'))
    expect(await screen.findByText('已更新规则 keepInventory = true')).toBeInTheDocument()
    // 保存后重取一次当前值（挂载 1 次 + 保存后 1 次）
    await waitFor(() => expect(gameruleHits).toBe(2))
    await waitFor(() =>
      expect(
        within(row('keepInventory')).getByRole('switch', { name: 'keepInventory 开关' }),
      ).toHaveAttribute('data-state', 'checked'),
    )
    expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument()
  })

  /* 验收口径（重试成功后看到服务端值）单列一条。它**不承重**：重试走的就是 reload()，
     新写法（无条件清）与旧写法（仅成功时清）在这一条上都清——重试本身成功了。
     真正能区分实现的路径是「重取失败后，由别处触发的成功取数」，见下一条。 */
  it('保存成功但重取失败：点重试取到后显示服务端值', async () => {
    const user = userEvent.setup()
    renderPanel()
    await screen.findByText('keepInventory')

    await user.click(
      within(row('keepInventory')).getByRole('switch', { name: 'keepInventory 开关' }),
    )
    snapshotStatus = 503
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText(/未能读取当前值/)).toBeInTheDocument()

    snapshotStatus = 200
    snapshot = SNAPSHOT
    await user.click(screen.getByRole('button', { name: /重试/ }))
    await screen.findByText('keepInventory')
    await waitFor(() =>
      expect(
        within(row('keepInventory')).getByRole('switch', { name: 'keepInventory 开关' }),
      ).toHaveAttribute('data-state', 'unchecked'),
    )
  })

  /* 乐观值没有 TTL：它只该活在「提交成功 → 这一轮重取结束」之间。下面这条走的是
     「重取失败之后、由别处触发的成功取数」——那条路径不经过 reload()，乐观值若没在失败
     那一轮清掉，就会在这里顶替服务端值。用 invalidateQueries 触发正是为了绕开 reload()，
     否则两种写法都会被 reload 顺手清掉，用例区分不了实现。 */
  it('保存成功但重取失败：乐观值不残留（后续成功取数显示服务端值）', async () => {
    const user = userEvent.setup()
    const { qc } = renderPanel()
    await screen.findByText('keepInventory')

    await user.click(
      within(row('keepInventory')).getByRole('switch', { name: 'keepInventory 开关' }),
    )
    // 保存成功后端点转红：这一轮重取失败
    snapshotStatus = 503
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText(/未能读取当前值/)).toBeInTheDocument()

    // 端点恢复，但**服务端仍说 false**（写命令没生效 / 这期间被别人改回去）
    snapshotStatus = 200
    snapshot = SNAPSHOT
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ['mcs', 'gamerules', 'inst-1'] })
    })
    await screen.findByText('keepInventory')
    await waitFor(() =>
      expect(
        within(row('keepInventory')).getByRole('switch', { name: 'keepInventory 开关' }),
      ).toHaveAttribute('data-state', 'unchecked'),
    )
  })

  it('int：输入新值 → 保存下发命令', async () => {
    const user = userEvent.setup()
    const { onSendCommand } = renderPanel()
    await screen.findByText('randomTickSpeed')
    const input = within(row('randomTickSpeed')).getByLabelText('randomTickSpeed 值')
    await user.clear(input)
    await user.type(input, '5')
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSendCommand).toHaveBeenCalledWith('gamerule randomTickSpeed 5'))
  })

  it('取消 → 回滚草稿（开关回到已提交值）', async () => {
    const user = userEvent.setup()
    const { onSendCommand } = renderPanel()
    await screen.findByText('keepInventory')
    await user.click(
      within(row('keepInventory')).getByRole('switch', { name: 'keepInventory 开关' }),
    )
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument()
    expect(
      within(row('keepInventory')).getByRole('switch', { name: 'keepInventory 开关' }),
    ).toHaveAttribute('data-state', 'unchecked')
    expect(onSendCommand).not.toHaveBeenCalledWith('gamerule keepInventory true')
  })

  it('保存失败：toast 友好错误 + 退出编辑态（不回写本地值）', async () => {
    const user = userEvent.setup()
    const onSendCommand = vi.fn<SendCommand>().mockRejectedValue(new Error('boom'))
    renderPanel({ send: onSendCommand })
    await screen.findByText('keepInventory')
    await user.click(
      within(row('keepInventory')).getByRole('switch', { name: 'keepInventory 开关' }),
    )
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('规则更新失败：网络错误')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument()
    expect(
      within(row('keepInventory')).getByRole('switch', { name: 'keepInventory 开关' }),
    ).toHaveAttribute('data-state', 'unchecked')
  })

  it('越界值就地拦下并给出原因（该回包在服务端是静默成功，不拦就会「界面说改了、服务器没改」）', async () => {
    const user = userEvent.setup()
    // 区间表只覆盖 1.21.11+ 的 snake_case 名；旧命名体系实测不设规则级边界，一律不拦
    snapshot = {
      source: 'rcon',
      rules: [{ name: 'random_tick_speed', status: 'current', type: 'integer', value: '3' }],
    }
    renderPanel({ mcVersion: '26.3' })
    await screen.findByText('random_tick_speed')
    const input = within(row('random_tick_speed')).getByLabelText('random_tick_speed 值')
    await user.clear(input)
    await user.type(input, '-1')
    // 下界 0 由真实回包反推（-1 → Integer must not be less than 0），而该文本不在失败短语表里
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText('不得小于 0：-1')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
    await user.clear(input)
    await user.type(input, '0')
    expect(screen.getByRole('button', { name: '保存' })).toBeEnabled()
  })
})

describe('GamerulePanel 搜索与分类', () => {
  it('搜索按名字过滤（无文案的行同样可被搜到）', async () => {
    const user = userEvent.setup()
    renderPanel()
    await screen.findByText('keepInventory')
    await user.type(screen.getByLabelText('搜索规则'), 'keep')
    expect(screen.getByText('keepInventory')).toBeInTheDocument()
    expect(screen.queryByText('randomTickSpeed')).not.toBeInTheDocument()
  })

  it('分类 chip 来自当前名单与文案表（无文案的规则落「其他」，仍可单独筛出）', async () => {
    const user = userEvent.setup()
    snapshot = {
      source: 'rcon',
      rules: [
        { name: 'keep_inventory', status: 'current', type: 'boolean', value: 'false' },
        { name: 'random_tick_speed', status: 'current', type: 'integer', value: '3' },
        { name: 'spawn_chunk_radius', status: 'current', type: 'integer', value: '2' },
      ],
    }
    renderPanel({ mcVersion: '26.3' })
    await screen.findByText('keep_inventory')
    expect(screen.getByRole('button', { name: '玩家' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '世界更新' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '其他' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '生物' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '玩家' }))
    expect(screen.getByText('keep_inventory')).toBeInTheDocument()
    expect(screen.queryByText('random_tick_speed')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '其他' }))
    expect(screen.getByText('spawn_chunk_radius')).toBeInTheDocument()
  })

  it('搜索无匹配显示空态', async () => {
    const user = userEvent.setup()
    renderPanel()
    await screen.findByText('keepInventory')
    await user.type(screen.getByLabelText('搜索规则'), '不存在的规则xyz')
    expect(screen.getByText('无匹配规则')).toBeInTheDocument()
  })
})
