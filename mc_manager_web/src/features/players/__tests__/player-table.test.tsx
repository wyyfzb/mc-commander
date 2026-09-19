/**
 * PlayerTable 行为级测试（issue 466：组件拆分等价性回归锁）
 * 拆分（player-table-columns/row/config）后锁定原有交互语义，覆盖：
 * - 表头 10 列渲染与加载骨架行
 * - 空态双文案（0=暂无玩家 / >0=无匹配 + 清空筛选 CTA）；错误态由页面持有，本组件不渲染
 * - 行元数据：OP/白名单/封禁徽标、离线态；行点击（指针便利）与名字按钮（键盘入口）打开详情
 * - 选择列：勾选写入 store、阻断行点击冒泡
 * - 行内菜单：详情/传送入口、OP·白名单可逆（直执 + 撤销，无确认弹窗）、
 *   踢出直执（无逆操作）、离线禁用
 * - 列头单列排序（Web 增强箭头）
 * mock 数据为结构占位（虚构玩家 Steve/Alex/Bob），严禁真实玩家/服务器信息
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Toaster, toast as sonnerToast } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { PlayerTable } from '../components/player-table'
import { usePlayersUiStore } from '../store'
import type { Player } from '@/api/types'
import type { PlayerActionRequest } from '../mutations'

function makePlayer(overrides: Partial<Player> = {}): Player {
  return {
    name: 'Steve',
    uuid: '00000000-0000-4000-8000-000000000002',
    isOnline: true,
    ip: '1.2.3.4',
    joinTime: null,
    onlineTime: 0,
    totalPlayTime: 0,
    isOp: false,
    isWhitelisted: false,
    isBanned: false,
    banExpiresAt: null,
    isIpBanned: false,
    ipBanExpiresAt: null,
    isFakePlayer: false,
    lastSeen: '',
    health: null,
    maxHealth: null,
    hunger: null,
    xpLevel: null,
    spawnPoint: null,
    respawnPoint: null,
    position: null,
    gameMode: 'survival',
    dimension: 'overworld',
    armor: null,
    xpProgress: null,
    ping: null,
    isSleeping: false,
    isAfk: false,
    isFlying: false,
    isSneaking: false,
    isSprinting: false,
    isBurning: false,
    isFrozen: false,
    potionEffects: [],
    ipHistory: [],
    inventory: null,
    events: [],
    sessions: [],
    stats: {
      totalOnline: 0,
      loginCount: 0,
      offlineSince: 0,
      deathCount: 0,
      achievementCount: 0,
      sleepCount: 0,
    },
    ...overrides,
  }
}

interface SetupOpts {
  players?: Player[]
  isLoading?: boolean
  totalCount?: number
}

function setup({ players, isLoading = false, totalCount = 0 }: SetupOpts = {}) {
  const onClearFilter = vi.fn()
  const onOpenDetail = vi.fn()
  const onOpenBan = vi.fn()
  const onAction = vi.fn<(req: PlayerActionRequest) => Promise<void>>().mockResolvedValue(undefined)
  const onKicked = vi.fn()
  const view = render(
    <TooltipProvider>
      <Toaster />
      <PlayerTable
        players={players ?? [makePlayer()]}
        isLoading={isLoading}
        totalCount={totalCount}
        onClearFilter={onClearFilter}
        isRconConnected
        onOpenDetail={onOpenDetail}
        onOpenBan={onOpenBan}
        onAction={onAction}
        onKicked={onKicked}
      />
    </TooltipProvider>,
  )
  return { view, onClearFilter, onOpenDetail, onOpenBan, onAction, onKicked }
}

beforeEach(() => {
  usePlayersUiStore.setState({ selectedUuids: [] })
  sonnerToast.dismiss() // sonner toast 为模块级单例，清掉上一用例残留弹窗（仓库既有范式）
})

// ── 表头与加载骨架 ──

describe('PlayerTable · 表头与加载态', () => {
  it('渲染 10 列表头与全选当前页复选框', () => {
    setup()
    for (const label of ['玩家', '模式', '维度', '坐标', '状态', '延迟', '在线时长', '总时长']) {
      expect(screen.getByRole('columnheader', { name: label })).toBeInTheDocument()
    }
    expect(screen.getByRole('checkbox', { name: '全选当前页' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: '选择 Steve' })).toBeInTheDocument()
  })

  it('isLoading 时渲染 5 条骨架行且不渲染数据行', () => {
    setup({ isLoading: true, players: [makePlayer()] })
    expect(screen.queryByText('Steve')).not.toBeInTheDocument()
    // 骨架行 aria-hidden（thead 之外 tbody 内 tr 计数）
    const tbody = document.querySelector('tbody')!
    expect(tbody.querySelectorAll('tr')).toHaveLength(5)
  })
})

// ── 错误态与空态 ──

describe('PlayerTable · 空态', () => {
  it('totalCount=0 空态展示「暂无在线玩家」且无清空筛选 CTA', () => {
    setup({ players: [], totalCount: 0 })
    expect(screen.getByText('暂无在线玩家')).toBeInTheDocument()
    expect(screen.queryByTestId('players-clear-filter')).not.toBeInTheDocument()
  })

  it('totalCount>0 无匹配时展示「没有匹配的玩家」，清空筛选 CTA 触发 onClearFilter', async () => {
    const user = userEvent.setup()
    const { onClearFilter } = setup({ players: [], totalCount: 7 })
    expect(screen.getByText('没有匹配的玩家')).toBeInTheDocument()
    await user.click(screen.getByTestId('players-clear-filter'))
    expect(onClearFilter).toHaveBeenCalledTimes(1)
  })
})

// ── 行元数据与行交互 ──

describe('PlayerTable · 行元数据渲染', () => {
  it('OP 图标/白名单徽标/封禁徽标/AFK 按元数据渲染，离线玩家不显示 IP', () => {
    setup({
      players: [
        makePlayer({ name: 'Steve', isOp: true, isWhitelisted: true, isAfk: true }),
        makePlayer({
          name: 'Bob',
          uuid: '00000000-0000-4000-8000-000000000004',
          isOnline: false,
          ip: undefined,
          isBanned: true,
          banExpiresAt: Date.now() + 86400_000,
        }),
      ],
    })
    expect(screen.getByLabelText('OP')).toBeInTheDocument()
    expect(screen.getByText('白名单')).toBeInTheDocument()
    expect(screen.getByText('AFK')).toBeInTheDocument()
    expect(screen.getByText(/封禁·剩/)).toBeInTheDocument()
    // 离线：IP 行缺席（在线 Steve 的 IP 仍在）
    expect(screen.getByText('1.2.3.4')).toBeInTheDocument()
  })

  it('离线玩家状态列展示「离线」或「已封禁」', () => {
    setup({
      players: [
        makePlayer({ name: 'Bob', uuid: '00000000-0000-4000-8000-000000000004', isOnline: false }),
        makePlayer({
          name: 'Banned',
          uuid: '00000000-0000-4000-8000-000000000005',
          isOnline: false,
          isBanned: true,
        }),
      ],
    })
    expect(screen.getByText('离线')).toBeInTheDocument()
    expect(screen.getByText('已封禁')).toBeInTheDocument()
  })

  /**
   * 玩家列的行高契约：`player-table-row.tsx` 用 height: ROW_HEIGHT(40)，「全部」档虚拟滚动
   * 的 estimateSize 也取同值 —— 整条链的前提是**每行恒为一行姓名 + 一行次要信息**。
   * jsdom 没有布局引擎，量不出像素，故这里锁的是能推出该前提的结构：
   * ①宽文本徽标不得与姓名按钮同行（否则其 shrink-0 会把姓名挤成几个字）；
   * ②次要行不得折行（折行会把行撑过 ROW_HEIGHT，实测 在线+临时封禁+IP 会到 59px）。
   * 像素级的行高由 e2e（players-virtual-scroll.spec.ts）实测锁定。
   */
  it('玩家列：宽文本徽标不与姓名同行，且次要行不折行（行高契约）', () => {
    setup({
      players: [
        makePlayer({
          name: 'DragonSlayer_777',
          isOp: true,
          isBanned: true,
          banExpiresAt: Date.now() + 12 * 3600_000,
          ip: '192.168.100.200',
        }),
      ],
    })
    const nameBtn = screen.getByRole('button', { name: '查看 DragonSlayer_777 详情' })
    const bannedBadge = screen.getByText(/封禁·剩/)
    // 超长名被截断时的可读出口
    expect(nameBtn).toHaveAttribute('title', 'DragonSlayer_777')

    // ① 姓名同行只允许纯图标徽标：文本徽标必须在姓名按钮所在行容器之外
    const nameRow = nameBtn.parentElement as HTMLElement
    expect(nameRow).not.toBeNull()
    expect(nameRow).not.toContainElement(bannedBadge)

    // ② 次要行不折行（折行即行高回归），且与文本徽标同处一行
    const metaRow = bannedBadge.parentElement as HTMLElement
    expect(metaRow).not.toBe(nameRow)
    expect(metaRow.className).toContain('flex-nowrap')
    expect(metaRow).toContainElement(screen.getByText('192.168.100.200'))

    // ①的补强：OP 是纯图标（14px），留在姓名同行，不占次要行
    expect(nameRow).toContainElement(screen.getByLabelText('OP'))
    expect(metaRow).not.toContainElement(screen.getByLabelText('OP'))
  })
})

/** 取玩家名按钮所在的数据行（行不再是 row 角色时本助手也依然可用，便于定位失败原因） */
function dataRowOf(name = 'Steve'): HTMLElement {
  const row = screen.getByRole('button', { name: `查看 ${name} 详情` }).closest('tr')
  expect(row).not.toBeNull()
  return row as HTMLElement
}

describe('PlayerTable · 行交互', () => {
  it('行任意位置点击打开详情（指针便利，onOpenDetail 透传玩家名）', async () => {
    const user = userEvent.setup()
    const { onOpenDetail } = setup()
    // 行是 row 角色、不承载激活语义：整行可点属指针便利，非键盘入口
    await user.click(dataRowOf())
    expect(onOpenDetail).toHaveBeenCalledWith('Steve')
    expect(onOpenDetail).toHaveBeenCalledTimes(1)
  })

  it('鼠标点击玩家名按钮只打开一次详情（按钮与行的 onClick 不得叠加）', async () => {
    const user = userEvent.setup()
    const { onOpenDetail } = setup()
    await user.click(screen.getByRole('button', { name: '查看 Steve 详情' }))
    // 按钮若不去冒泡，会连同 <tr> 的 onClick 一起触发两次
    expect(onOpenDetail).toHaveBeenCalledTimes(1)
  })

  it('玩家名按钮是键盘入口：聚焦后回车打开详情', async () => {
    const user = userEvent.setup()
    const { onOpenDetail } = setup()
    const nameButton = screen.getByRole('button', { name: '查看 Steve 详情' })
    nameButton.focus()
    await user.keyboard('{Enter}')
    expect(onOpenDetail).toHaveBeenCalledWith('Steve')
    expect(onOpenDetail).toHaveBeenCalledTimes(1)
  })

  it('玩家名按钮空格同样激活（原生 button 语义，不依赖行级按键处理）', async () => {
    const user = userEvent.setup()
    const { onOpenDetail } = setup()
    const nameButton = screen.getByRole('button', { name: '查看 Steve 详情' })
    nameButton.focus()
    await user.keyboard(' ')
    expect(onOpenDetail).toHaveBeenCalledWith('Steve')
    expect(onOpenDetail).toHaveBeenCalledTimes(1)
  })

  it('表格行不可聚焦且不伪造交互角色（table 祖先下 <tr> 只允许 row）', () => {
    setup()
    const dataRow = dataRowOf()
    expect(dataRow).not.toHaveAttribute('tabindex')
    // 显式 role="row" 冗余但合法，故只拒绝交互角色；不可聚焦的行上 aria-label
    // 既无用也无害，真正要守的是「行没有变成可聚焦的假控件」
    expect(dataRow.getAttribute('role') ?? 'row').toBe('row')
  })

  it('勾选行复选框写入 store 且不触发行点击打开详情', async () => {
    const user = userEvent.setup()
    const { onOpenDetail } = setup()
    await user.click(screen.getByRole('checkbox', { name: '选择 Steve' }))
    expect(usePlayersUiStore.getState().selectedUuids).toEqual([
      '00000000-0000-4000-8000-000000000002',
    ])
    expect(onOpenDetail).not.toHaveBeenCalled()
  })
})

// ── 选择范围（分页语义）与行内控件键盘 ──

describe('PlayerTable · 选择范围与行内键盘', () => {
  it('行内复选框聚焦后按空格：写入选择且不打开详情（行不再吞掉空格）', async () => {
    const user = userEvent.setup()
    const { onOpenDetail } = setup()
    const checkbox = screen.getByRole('checkbox', { name: '选择 Steve' })
    checkbox.focus()
    await user.keyboard(' ')
    expect(usePlayersUiStore.getState().selectedUuids).toEqual([
      '00000000-0000-4000-8000-000000000002',
    ])
    expect(onOpenDetail).not.toHaveBeenCalled()
  })

  it('表头「全选当前页」只选中当前页（25 名玩家 / 每页 20 → 选中 20 名）', async () => {
    const user = userEvent.setup()
    const players = Array.from({ length: 25 }, (_, i) =>
      makePlayer({
        name: `P${i + 1}`,
        uuid: `00000000-0000-4000-8000-0000000000${String(i + 1).padStart(2, '0')}`,
      }),
    )
    setup({ players, totalCount: players.length })
    await user.click(screen.getByRole('checkbox', { name: '全选当前页' }))
    const selected = usePlayersUiStore.getState().selectedUuids
    // 表头只作用于当前页：不得把第 21 名及以后的筛选结果一并选中
    expect(selected).toHaveLength(20)
    expect(selected).toContain(players[0]!.uuid)
    expect(selected).toContain(players[19]!.uuid)
    expect(selected).not.toContain(players[20]!.uuid)
  })
})

// ── 行内操作菜单 ──

async function openMenu(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole('button', { name: `${name} 操作菜单` }))
}

describe('PlayerTable · 行内操作菜单', () => {
  it('菜单「详情」打开概览 Tab（onOpenDetail(name, overview)）', async () => {
    const user = userEvent.setup()
    const { onOpenDetail } = setup()
    await openMenu(user, 'Steve')
    await user.click(await screen.findByRole('menuitem', { name: '详情' }))
    expect(onOpenDetail).toHaveBeenCalledWith('Steve', 'overview')
  })

  it('菜单「传送」对离线玩家禁用，在线玩家透传 teleport Tab', async () => {
    const user = userEvent.setup()
    const { onOpenDetail } = setup({
      players: [
        makePlayer(),
        makePlayer({ name: 'Bob', uuid: '00000000-0000-4000-8000-000000000004', isOnline: false }),
      ],
    })
    await openMenu(user, 'Bob')
    // radix DropdownMenuItem 的 disabled 语义：aria-disabled 属性（div 非原生 button）
    expect(await screen.findByRole('menuitem', { name: '传送' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    await user.keyboard('{Escape}')
    await openMenu(user, 'Steve')
    await user.click(await screen.findByRole('menuitem', { name: '传送' }))
    expect(onOpenDetail).toHaveBeenCalledWith('Steve', 'teleport')
  })

  it('可逆：菜单「设为 OP」直执（无确认弹窗）+ 回执挂撤销，撤销发 deop', async () => {
    const user = userEvent.setup()
    const { onAction } = setup()
    await openMenu(user, 'Steve')
    await user.click(await screen.findByRole('menuitem', { name: '设为 OP' }))
    expect(screen.queryByText('确认设为 OP')).not.toBeInTheDocument()
    expect(onAction).toHaveBeenCalledWith({ kind: 'op', playerName: 'Steve' })
    expect(await screen.findByText('已设置 Steve 为 OP')).toBeInTheDocument()

    // fireEvent 直派 click：jsdom 无 setPointerCapture，user.click 会在 sonner 的
    // onPointerDown 上抛异常（与 toast 动作按钮无关的 jsdom 缺口）
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(onAction).toHaveBeenLastCalledWith({ kind: 'deop', playerName: 'Steve' })
  })

  it('可逆：菜单「加入白名单」直执 + 撤销发 whitelistRemove', async () => {
    const user = userEvent.setup()
    const { onAction } = setup()
    await openMenu(user, 'Steve')
    await user.click(await screen.findByRole('menuitem', { name: '加入白名单' }))
    expect(screen.queryByText('确认加入白名单')).not.toBeInTheDocument()
    expect(onAction).toHaveBeenCalledWith({ kind: 'whitelistAdd', playerName: 'Steve' })

    fireEvent.click(await screen.findByRole('button', { name: '撤销' }))
    expect(onAction).toHaveBeenLastCalledWith({ kind: 'whitelistRemove', playerName: 'Steve' })
  })

  it('踢出直执（无逆操作 → 回执不挂撤销入口）+ onKicked', async () => {
    const user = userEvent.setup()
    const { onAction, onKicked } = setup()
    await openMenu(user, 'Steve')
    await user.click(await screen.findByRole('menuitem', { name: '踢出' }))
    expect(screen.queryByText('确认踢出')).not.toBeInTheDocument()
    expect(onAction).toHaveBeenCalledWith({ kind: 'kick', playerName: 'Steve' })
    await waitFor(() => expect(onKicked).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('button', { name: '撤销' })).not.toBeInTheDocument()
  })

  it('离线玩家菜单「踢出」禁用', async () => {
    const user = userEvent.setup()
    const { onAction } = setup({
      players: [
        makePlayer({ name: 'Bob', uuid: '00000000-0000-4000-8000-000000000004', isOnline: false }),
      ],
    })
    await openMenu(user, 'Bob')
    expect(await screen.findByRole('menuitem', { name: '踢出' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    expect(onAction).not.toHaveBeenCalled()
  })

  it('菜单「封禁…」透传 onOpenBan(player)', async () => {
    const user = userEvent.setup()
    const player = makePlayer()
    const { onOpenBan } = setup({ players: [player] })
    await openMenu(user, 'Steve')
    await user.click(await screen.findByRole('menuitem', { name: '封禁…' }))
    expect(onOpenBan).toHaveBeenCalledWith(player)
  })
})

// ── 单列排序（Web 增强） ──

describe('PlayerTable · 列头排序', () => {
  it('点击「玩家」列头切换排序箭头 ↑→↓（既有行为：箭头由 sorting state 驱动）', async () => {
    const user = userEvent.setup()
    setup({
      players: [
        makePlayer(),
        makePlayer({ name: 'Alex', uuid: '00000000-0000-4000-8000-000000000003' }),
      ],
    })
    await user.click(screen.getByRole('button', { name: '玩家' }))
    // 箭头 span 带 aria-hidden，不进 accessible name，用 textContent 断言
    expect(screen.getByRole('button', { name: '玩家' })).toHaveTextContent('↑')
    await user.click(screen.getByRole('button', { name: '玩家' }))
    expect(screen.getByRole('button', { name: '玩家' })).toHaveTextContent('↓')
  })

  it('排序态经 aria-sort 暴露：none → ascending → descending，不可排序列不设该属性', async () => {
    const user = userEvent.setup()
    setup({
      players: [
        makePlayer(),
        makePlayer({ name: 'Alex', uuid: '00000000-0000-4000-8000-000000000003' }),
      ],
    })
    const nameHeader = () => screen.getByRole('columnheader', { name: '玩家' })

    // 可排序但未排序：none（不是缺失——缺失读不出「这列能排但当前没排」）
    expect(nameHeader()).toHaveAttribute('aria-sort', 'none')
    await user.click(screen.getByRole('button', { name: '玩家' }))
    expect(nameHeader()).toHaveAttribute('aria-sort', 'ascending')
    await user.click(screen.getByRole('button', { name: '玩家' }))
    expect(nameHeader()).toHaveAttribute('aria-sort', 'descending')
    // 其他可排序列仍是 none（排序态不会串到别的列）
    expect(screen.getByRole('columnheader', { name: '延迟' })).toHaveAttribute('aria-sort', 'none')
    // 不可排序列（选择列）不设该属性：aria-sort 只对可排序表头有意义
    expect(screen.getByRole('checkbox', { name: '全选当前页' }).closest('th')).not.toHaveAttribute(
      'aria-sort',
    )
  })

  // 回归锁（issue #472 / PR #473 沉淀缺口）：v9 未注册 sortedRowModel 时
  // getRowModel() 返回预排序模型——箭头翻转但行序纹丝不动。此用例断言
  // 行序真实变化：升序 Alex 在前、降序 Steve 在前（修复前升序仍是 Steve 在前）
  const playerNameOrder = () =>
    [...document.querySelectorAll('tbody tr')].map((tr) =>
      tr.textContent?.includes('Steve') ? 'Steve' : 'Alex',
    )

  it('升序点击后行序真实重排：Alex（字母序在前）排到 Steve 之前', async () => {
    const user = userEvent.setup()
    setup({
      players: [
        makePlayer(),
        makePlayer({ name: 'Alex', uuid: '00000000-0000-4000-8000-000000000003' }),
      ],
    })
    // 修复前：getRowModel() 恒为 core 模型，行序保持传入序 [Steve, Alex]
    expect(playerNameOrder()).toEqual(['Steve', 'Alex'])

    await user.click(screen.getByRole('button', { name: '玩家' }))
    expect(screen.getByRole('button', { name: '玩家' })).toHaveTextContent('↑')
    expect(playerNameOrder()).toEqual(['Alex', 'Steve'])
  })

  it('再次点击切换降序后行序反转回传入序', async () => {
    const user = userEvent.setup()
    setup({
      players: [
        makePlayer(),
        makePlayer({ name: 'Alex', uuid: '00000000-0000-4000-8000-000000000003' }),
      ],
    })
    await user.click(screen.getByRole('button', { name: '玩家' }))
    expect(playerNameOrder()).toEqual(['Alex', 'Steve'])
    await user.click(screen.getByRole('button', { name: '玩家' }))
    expect(screen.getByRole('button', { name: '玩家' })).toHaveTextContent('↓')
    expect(playerNameOrder()).toEqual(['Steve', 'Alex'])
  })
})

// ── 分页栏常驻（「全部」档是单向门缺陷的回归锁）──

describe('PlayerTable · 分页栏', () => {
  it('切到「全部」档分页栏仍在，可切回其他每页条数', async () => {
    const user = userEvent.setup()
    setup({
      players: [
        makePlayer(),
        makePlayer({ name: 'Alex', uuid: '00000000-0000-4000-8000-000000000003' }),
      ],
    })

    await user.selectOptions(screen.getByLabelText('每页行数'), '-1')
    // 历史缺陷：pageSize === -1 时整条分页栏被条件渲染掉，
    // 「全部」是单向门——切进去就再也选不回 10/20/50，只能刷新页面
    expect(screen.getByLabelText('每页行数')).toHaveValue('-1')
    expect(screen.getByText(/共 2 条/)).toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText('每页行数'), '20')
    expect(screen.getByLabelText('每页行数')).toHaveValue('20')
    expect(screen.getByText('Steve')).toBeInTheDocument()
  })
})
