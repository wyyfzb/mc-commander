/**
 * PlayerTable 响应式形态
 * 三段各自锁住：
 * - 表格区 <640px：整表转行式卡片（横向溢出下 10 列无论如何都读不全），保留勾选、全选、操作菜单
 * - 表格区 <1016px：表格裁到核心列（选择/玩家/状态/操作），次级列不再横向溢出把勾选框与玩家名推出视野
 * - 表格区 ≥1016px：维持完整 10 列（默认不测量即宽屏态）
 * 列数判据是**表格区实宽**（useContainerWidth）而非视口：侧栏折叠差 152px、详情面板内联再借走
 * 436px，同一视口下表格区能差出六百多 px。这里用可控 ResizeObserver mock 直接喂宽度。
 * mock 数据为结构占位（虚构玩家 Steve），严禁真实玩家/服务器信息
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Toaster, toast as sonnerToast } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { BREAKPOINT_BELOW_SM } from '@/hooks/use-media-query'
import { mockContainerWidth } from '@/test/mock-container-width'
import { PlayerTable } from '../player-table'
import { usePlayersUiStore } from '../../store'
import type { Player } from '@/api/types'
import type { PlayerActionRequest } from '../../mutations'

function makePlayer(overrides: Partial<Player> = {}): Player {
  return {
    name: 'Steve',
    uuid: '00000000-0000-4000-8000-000000000002',
    isOnline: true,
    ip: '1.2.3.4',
    joinTime: null,
    onlineTime: 3600,
    totalPlayTime: 7200,
    isOp: true,
    isWhitelisted: true,
    isBanned: false,
    banExpiresAt: null,
    isIpBanned: false,
    ipBanExpiresAt: null,
    isFakePlayer: false,
    lastSeen: '',
    health: 20,
    maxHealth: 20,
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

/** 只让指定视口断点命中（供卡片态判定用；其余查询保持 false，与宽屏态用例互不干扰） */
function mockBreakpoints(matching: string[]) {
  const orig = window.matchMedia
  window.matchMedia = ((query: string) => ({
    matches: matching.includes(query),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  return () => {
    window.matchMedia = orig
  }
}

/**
 * 让 useContainerWidth 测到指定表格区宽度（jsdom 无布局引擎，clientWidth 恒 0，
 * setup.ts 的 ResizeObserver 又是空实现——共用 mock 见 src/test/mock-container-width.ts）
 */
function mockTableWidth(px: number) {
  return mockContainerWidth(px)
}

let restoreMedia: (() => void) | null = null
let restoreObserver: (() => void) | null = null

afterEach(() => {
  restoreMedia?.()
  restoreMedia = null
  restoreObserver?.()
  restoreObserver = null
  sonnerToast.dismiss()
})

function setup(players: Player[]) {
  const onOpenDetail = vi.fn()
  const onOpenBan = vi.fn()
  const onAction = vi.fn<(req: PlayerActionRequest) => Promise<void>>().mockResolvedValue(undefined)
  const onKicked = vi.fn()
  render(
    <TooltipProvider>
      <Toaster />
      <PlayerTable
        players={players}
        isLoading={false}
        totalCount={players.length}
        onClearFilter={vi.fn()}
        isRconConnected
        onOpenDetail={onOpenDetail}
        onOpenBan={onOpenBan}
        onAction={onAction}
        onKicked={onKicked}
      />
    </TooltipProvider>,
  )
  return { onOpenDetail, onOpenBan, onAction, onKicked }
}

describe('PlayerTable · 响应式形态', () => {
  it('<640px：渲染行式卡片而非表格，勾选/全选/操作菜单均在位', () => {
    restoreMedia = mockBreakpoints([BREAKPOINT_BELOW_SM])
    restoreObserver = mockTableWidth(375)
    usePlayersUiStore.setState({ selectedUuids: [] })
    const { onOpenDetail } = setup([makePlayer()])

    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByRole('columnheader')).toBeNull()
    const card = screen.getByRole('listitem')
    // 大字姓名 + 小字标签都在卡片内（不是被截断的表格单元格）
    expect(card).toHaveTextContent('Steve')
    expect(within(card).getByLabelText('OP')).toBeInTheDocument()
    expect(card).toHaveTextContent('白名单')
    expect(screen.getByRole('checkbox', { name: '选择 Steve' })).toBeInTheDocument()
    // 表头消失后「全选当前页」入口仍在（与表格表头同标签同口径）
    expect(screen.getByRole('checkbox', { name: '全选当前页' })).toBeInTheDocument()
    // 打开详情：与表格同一条键盘/指针入口
    expect(screen.getByRole('button', { name: '查看 Steve 详情' })).toBeInTheDocument()
    expect(onOpenDetail).not.toHaveBeenCalled()
  })

  it('<640px：卡片态行内菜单与表格共用同一套操作（可逆项直执）', async () => {
    restoreMedia = mockBreakpoints([BREAKPOINT_BELOW_SM])
    restoreObserver = mockTableWidth(375)
    usePlayersUiStore.setState({ selectedUuids: [] })
    const user = userEvent.setup()
    const { onAction } = setup([makePlayer({ isOp: false })])

    await user.click(screen.getByRole('button', { name: 'Steve 操作菜单' }))
    await user.click(await screen.findByRole('menuitem', { name: '设为 OP' }))
    expect(onAction).toHaveBeenCalledWith({ kind: 'op', playerName: 'Steve' })
  })

  it('<640px：卡片勾选写入选中集（批量条依赖同一 store）', async () => {
    restoreMedia = mockBreakpoints([BREAKPOINT_BELOW_SM])
    restoreObserver = mockTableWidth(375)
    usePlayersUiStore.setState({ selectedUuids: [] })
    const user = userEvent.setup()
    setup([makePlayer()])

    await user.click(screen.getByRole('checkbox', { name: '选择 Steve' }))
    expect(usePlayersUiStore.getState().selectedUuids).toEqual([
      '00000000-0000-4000-8000-000000000002',
    ])
  })

  it('<1016px（≥640px）：表格裁到核心列，次级列不参与布局（免横向溢出）', async () => {
    restoreObserver = mockTableWidth(784)
    setup([makePlayer()])

    expect(await screen.findByRole('table')).toBeInTheDocument()
    for (const label of ['玩家', '状态']) {
      expect(screen.getByRole('columnheader', { name: label })).toBeInTheDocument()
    }
    for (const label of ['模式', '维度', '坐标', '延迟', '在线时长', '总时长']) {
      expect(screen.queryByRole('columnheader', { name: label })).toBeNull()
    }
    expect(screen.getByRole('checkbox', { name: '选择 Steve' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Steve 操作菜单' })).toBeInTheDocument()
  })

  it('≥1016px：完整 10 列（响应式不收窄宽屏；折叠侧栏 1279 视口表格区 1191px 也命中此档）', async () => {
    restoreObserver = mockTableWidth(1191)
    setup([makePlayer()])

    expect(await screen.findByRole('table')).toBeInTheDocument()
    for (const label of ['玩家', '模式', '维度', '坐标', '状态', '延迟', '在线时长', '总时长']) {
      expect(screen.getByRole('columnheader', { name: label })).toBeInTheDocument()
    }
  })

  it('未测到宽度（首帧前 / 无布局引擎）：按宽兜底给全列，不闪裁列形态', async () => {
    // 不装 mockTableWidth：setup.ts 的 RO 空实现 ⇒ width 保持 null
    setup([makePlayer()])

    expect(await screen.findByRole('table')).toBeInTheDocument()
    for (const label of ['模式', '维度', '坐标', '延迟', '在线时长', '总时长']) {
      expect(screen.getByRole('columnheader', { name: label })).toBeInTheDocument()
    }
  })
})
