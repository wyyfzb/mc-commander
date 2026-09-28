/**
 * BatchBar 行为级补测（issue 506 口径回归）
 * - 9 动作入口三通道：导航类（传送/给予直接回调）、直执类（名单±/OP±/踢出/游戏模式）、
 *   确认类（仅清空背包不可逆走 ConfirmDialog）
 * - 可逆动作（名单±/OP±/游戏模式）直执 + 5s 撤销，且只回滚真正下发成功的目标
 * - 离线策略经真实 runBatchForTargets：名单类离线仍执行、在线类跳过离线、全离线不执行任何命令
 * - toast 汇总经真实 Toaster 渲染断言，sonner spy 观察调用类型
 * mock 数据为虚构玩家（Steve/Alex），严禁真实玩家/服务器信息
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Toaster, toast as sonnerToast } from 'sonner'
import { BatchBar } from '../batch-bar'
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

const OFFLINE_ALEX = { name: 'Alex', uuid: '00000000-0000-4000-8000-000000000003', isOnline: false }

describe('BatchBar', () => {
  const onOpenBatchDetail = vi.fn<(tab: 'teleport' | 'give') => void>()
  const onAction = vi.fn<(req: PlayerActionRequest) => Promise<void>>()
  let user: ReturnType<typeof userEvent.setup>

  beforeEach(() => {
    vi.clearAllMocks()
    sonnerToast.dismiss() // sonner toast 为模块级单例，清掉上一用例残留弹窗（仓库既有范式）
    onAction.mockResolvedValue(undefined)
    usePlayersUiStore.setState({ selectedUuids: ['00000000-0000-4000-8000-000000000002'] })
    user = userEvent.setup()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function setup(players: Player[]) {
    render(
      <>
        <Toaster />
        <BatchBar
          selectedPlayers={players}
          onOpenBatchDetail={onOpenBatchDetail}
          onAction={onAction}
        />
      </>,
    )
  }

  async function confirmInDialog() {
    await user.click(await screen.findByRole('button', { name: '确认操作' }))
  }

  /** 撤销入口在 toast 上：jsdom 无 setPointerCapture，直派 click 避开 sonner 的 onPointerDown */
  function clickUndo() {
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
  }

  it('渲染已选择计数与全部动作入口（导航/名单/游戏模式/危险/清除）', () => {
    setup([makePlayer(), makePlayer(OFFLINE_ALEX)])
    expect(screen.getByText('已选择 2 名玩家')).toBeInTheDocument()
    for (const label of [
      '传送',
      '给予物品',
      '白名单',
      '移除白名单',
      'OP',
      '取消OP',
      '游戏模式',
      '清空背包',
      '踢出',
    ]) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
    expect(screen.getByRole('button', { name: '清除选择' })).toBeInTheDocument()
  })

  it('导航类直接回调：传送/给予物品不经确认弹窗', async () => {
    setup([makePlayer()])
    await user.click(screen.getByRole('button', { name: '传送' }))
    await user.click(screen.getByRole('button', { name: '给予物品' }))
    expect(onOpenBatchDetail).toHaveBeenNthCalledWith(1, 'teleport')
    expect(onOpenBatchDetail).toHaveBeenNthCalledWith(2, 'give')
    expect(onAction).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: '确认操作' })).not.toBeInTheDocument()
  })

  it.each([
    ['白名单', 'whitelistAdd', '添加白名单', 'whitelistRemove'],
    ['移除白名单', 'whitelistRemove', '移除白名单', 'whitelistAdd'],
    ['OP', 'op', '设置OP', 'deop'],
    ['取消OP', 'deop', '取消OP', 'op'],
  ])(
    '名单类 %s：直执（无确认弹窗）+ 回执挂撤销，撤销对偶动作；离线玩家仍执行',
    async (label, kind, actionLabel, undoKind) => {
      setup([makePlayer({ ...OFFLINE_ALEX })])
      await user.click(screen.getByRole('button', { name: label }))

      // 直执：无任何确认弹窗
      expect(screen.queryByRole('button', { name: '确认操作' })).not.toBeInTheDocument()
      await screen.findByText(`批量${actionLabel}完成：成功 1，失败 0`)
      expect(onAction).toHaveBeenCalledTimes(1)
      expect(onAction).toHaveBeenCalledWith({ kind, playerName: 'Alex' })

      clickUndo()
      expect(onAction).toHaveBeenLastCalledWith({ kind: undoKind, playerName: 'Alex' })
    },
  )

  it('踢出：直执（无逆操作 → 回执不挂撤销），离线玩家跳过', async () => {
    setup([makePlayer(), makePlayer(OFFLINE_ALEX)])
    await user.click(screen.getByRole('button', { name: '踢出' }))
    await screen.findByText('批量踢出完成：成功 1，失败 0，跳过离线 1')
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(onAction).toHaveBeenCalledWith({ kind: 'kick', playerName: 'Steve' })
    expect(screen.queryByRole('button', { name: '撤销' })).not.toBeInTheDocument()
  })

  it('全离线：不执行任何命令并提示所选玩家均已离线，无撤销入口', async () => {
    setup([makePlayer(OFFLINE_ALEX)])
    await user.click(screen.getByRole('button', { name: '踢出' }))
    await screen.findByText('所选玩家均已离线，无法执行')
    expect(onAction).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: '撤销' })).not.toBeInTheDocument()
  })

  it('清空背包：不可逆 → 确认 + 危险警告文案 + clear 命令；个体失败走 warning 且带失败详情，无撤销', async () => {
    setup([makePlayer()])
    await user.click(screen.getByRole('button', { name: '清空背包' }))
    expect(await screen.findByText('批量清空背包')).toBeInTheDocument()
    expect(
      screen.getByText('此操作不可撤销，所有物品将被永久删除；离线玩家将跳过'),
    ).toBeInTheDocument()
    onAction.mockRejectedValueOnce(new Error('boom'))
    await confirmInDialog()
    await screen.findByText('批量清空背包完成：成功 0，失败 1')
    expect(screen.getByText('• Steve：boom')).toBeInTheDocument()
    expect(onAction).toHaveBeenCalledWith({ kind: 'command', command: 'clear Steve' })
    expect(screen.queryByRole('button', { name: '撤销' })).not.toBeInTheDocument()
  })

  it('清空背包确认弹窗取消：不执行动作且弹窗关闭', async () => {
    setup([makePlayer()])
    await user.click(screen.getByRole('button', { name: '清空背包' }))
    expect(await screen.findByText('批量清空背包')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByText('批量清空背包')).not.toBeInTheDocument())
    expect(onAction).not.toHaveBeenCalled()
  })

  it('游戏模式：下拉选择创造 → 直执 gamemode，撤销切回各目标原模式', async () => {
    setup([makePlayer({ gameMode: 'survival' })])
    await user.click(screen.getByRole('button', { name: '游戏模式' }))
    await user.click(await screen.findByRole('menuitem', { name: '创造' }))
    await screen.findByText('批量切换游戏模式完成：成功 1，失败 0')
    expect(onAction).toHaveBeenCalledWith({ kind: 'command', command: 'gamemode creative Steve' })

    clickUndo()
    expect(onAction).toHaveBeenLastCalledWith({
      kind: 'command',
      command: 'gamemode survival Steve',
    })
  })

  it('游戏模式多目标含离线：在线执行、离线跳过并汇总', async () => {
    setup([makePlayer(), makePlayer(OFFLINE_ALEX)])
    await user.click(screen.getByRole('button', { name: '游戏模式' }))
    await user.click(await screen.findByRole('menuitem', { name: '生存' }))
    await screen.findByText('批量切换游戏模式完成：成功 1，失败 0，跳过离线 1')
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(onAction).toHaveBeenCalledWith({ kind: 'command', command: 'gamemode survival Steve' })
  })

  it('游戏模式：原模式全部未知 → 不给撤销入口，但回执说明原因（不静默排除）', async () => {
    setup([makePlayer({ gameMode: null })])
    await user.click(screen.getByRole('button', { name: '游戏模式' }))
    await user.click(await screen.findByRole('menuitem', { name: '创造' }))

    await screen.findByText('批量切换游戏模式完成：成功 1，失败 0')
    // 没有可回滚目标 ⇒ 不挂撤销入口，但必须讲明为什么（不猜默认档）
    expect(screen.queryByRole('button', { name: '撤销' })).not.toBeInTheDocument()
    expect(screen.getByText(/1 名玩家的原游戏模式未知，本次不提供撤销/)).toBeInTheDocument()
  })

  it('游戏模式：仅部分原模式已知 → 撤销入口在，但回执说明覆盖面', async () => {
    setup([
      makePlayer({ gameMode: 'survival' }),
      makePlayer({ name: 'Bob', uuid: '00000000-0000-4000-8000-000000000004', gameMode: null }),
    ])
    await user.click(screen.getByRole('button', { name: '游戏模式' }))
    await user.click(await screen.findByRole('menuitem', { name: '创造' }))

    await screen.findByText('批量切换游戏模式完成：成功 2，失败 0')
    // 撤销只覆盖原模式已知的那一名，回执要说清，否则用户以为能整体回滚
    expect(screen.getByText(/撤销只覆盖原模式已知的 1 名，另有 1 名原模式未知/)).toBeInTheDocument()
    clickUndo()
    expect(onAction).toHaveBeenLastCalledWith({
      kind: 'command',
      command: 'gamemode survival Steve',
    })
  })

  it('撤销只回滚下发成功的目标（首名失败 → 不在回滚集内）', async () => {
    setup([makePlayer(), makePlayer({ name: 'Bob', uuid: '00000000-0000-4000-8000-000000000004' })])
    onAction.mockRejectedValueOnce(new Error('boom'))
    await user.click(screen.getByRole('button', { name: '白名单' }))
    await screen.findByText('批量添加白名单完成：成功 1，失败 1')
    expect(onAction).toHaveBeenNthCalledWith(1, { kind: 'whitelistAdd', playerName: 'Steve' })
    expect(onAction).toHaveBeenNthCalledWith(2, { kind: 'whitelistAdd', playerName: 'Bob' })

    clickUndo()
    await waitFor(() => expect(onAction).toHaveBeenCalledTimes(3))
    // 仅 Bob 下发成功 → 只回滚 Bob；Steve 失败不回滚（回滚一条不存在的变更会掩盖失败）
    expect(onAction).toHaveBeenLastCalledWith({ kind: 'whitelistRemove', playerName: 'Bob' })
  })

  it('执行期间全部动作按钮禁用（running 门控），完成后恢复；aria-busy 随执行翻转', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    onAction.mockImplementation(() => gate)
    setup([makePlayer()])
    await user.click(screen.getByRole('button', { name: '踢出' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '传送' })).toBeDisabled())
    expect(screen.getByRole('button', { name: '清空背包' })).toBeDisabled()
    // 读屏的「操作进行中」信号：执行中 busy，完成后复位
    expect(screen.getByText(/已选择 1 名玩家/).parentElement).toHaveAttribute('aria-busy', 'true')
    release()
    await screen.findByText('批量踢出完成：成功 1，失败 0')
    await waitFor(() => expect(screen.getByRole('button', { name: '传送' })).toBeEnabled())
    expect(screen.getByText(/已选择 1 名玩家/).parentElement).toHaveAttribute('aria-busy', 'false')
  })

  it('清除选择：点击后清空 store 选中集', async () => {
    setup([makePlayer()])
    await user.click(screen.getByRole('button', { name: '清除选择' }))
    expect(usePlayersUiStore.getState().selectedUuids).toEqual([])
  })

  it('执行期间「清除选择」禁用，点击不清空选中（与同条其余控件同口径）', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    onAction.mockImplementation(() => gate)
    setup([makePlayer()])
    await user.click(screen.getByRole('button', { name: '踢出' }))

    const clear = screen.getByRole('button', { name: '清除选择' })
    // fireEvent 直派 click（绕过 userEvent 的 pointer-events 守卫）：禁用态下 handler 不得执行
    fireEvent.click(clear)
    expect(usePlayersUiStore.getState().selectedUuids).toEqual([
      '00000000-0000-4000-8000-000000000002',
    ])
    await waitFor(() => expect(clear).toBeDisabled())

    release()
    await screen.findByText('批量踢出完成：成功 1，失败 0')
    await waitFor(() => expect(screen.getByRole('button', { name: '清除选择' })).toBeEnabled())
  })
})
