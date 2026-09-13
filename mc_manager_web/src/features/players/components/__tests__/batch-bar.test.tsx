/**
 * BatchBar 行为级补测（issue 506）
 * - 9 动作入口三通道：导航类（传送/给予直接回调）、确认类（白名单±/OP±/清空背包/踢出经 ConfirmDialog）、
 *   游戏模式（DropdownMenu 选模式 → ConfirmDialog → gamemode 命令）
 * - 离线策略经真实 runBatchForTargets：名单类离线仍执行、在线类跳过离线、全离线不执行任何命令
 * - toast 汇总经真实 Toaster 渲染断言，sonner spy 观察调用类型
 * mock 数据为虚构玩家（Steve/Alex），严禁真实玩家/服务器信息
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
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
        <BatchBar selectedPlayers={players} onOpenBatchDetail={onOpenBatchDetail} onAction={onAction} />
      </>,
    )
  }

  async function confirmInDialog() {
    await user.click(await screen.findByRole('button', { name: '确认操作' }))
  }

  it('渲染已选择计数与全部动作入口（导航/名单/游戏模式/危险/清除）', () => {
    setup([makePlayer(), makePlayer({ name: 'Alex', uuid: '00000000-0000-4000-8000-000000000003' })])
    expect(screen.getByText('已选择 2 名玩家')).toBeInTheDocument()
    for (const label of ['传送', '给予物品', '白名单', '移除白名单', 'OP', '取消OP', '游戏模式', '清空背包', '踢出']) {
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
    ['白名单', 'whitelistAdd', '批量添加白名单', '添加白名单'],
    ['移除白名单', 'whitelistRemove', '批量移除白名单', '移除白名单'],
    ['OP', 'op', '批量设置OP', '设置OP'],
    ['取消OP', 'deop', '批量取消OP', '取消OP'],
  ])('名单类 %s：确认后离线玩家仍执行（requireOnline=false）', async (label, kind, title, actionLabel) => {
    setup([makePlayer({ name: 'Alex', uuid: '00000000-0000-4000-8000-000000000003', isOnline: false })])
    await user.click(screen.getByRole('button', { name: label }))
    expect(await screen.findByText(title)).toBeInTheDocument()
    expect(screen.getByText(`即将对 1 名玩家执行：${actionLabel}`)).toBeInTheDocument()
    expect(screen.getByText('离线玩家将跳过（名单类操作除外）')).toBeInTheDocument()
    await confirmInDialog()
    await screen.findByText(`批量${actionLabel}完成：成功 1，失败 0`)
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(onAction).toHaveBeenCalledWith({ kind, playerName: 'Alex' })
  })

  it('在线类踢出：离线玩家跳过（真实 runBatchForTargets 过滤）', async () => {
    setup([
      makePlayer(),
      makePlayer({ name: 'Alex', uuid: '00000000-0000-4000-8000-000000000003', isOnline: false }),
    ])
    await user.click(screen.getByRole('button', { name: '踢出' }))
    expect(await screen.findByText('批量踢出')).toBeInTheDocument()
    await confirmInDialog()
    await screen.findByText('批量踢出完成：成功 1，失败 0，跳过离线 1')
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(onAction).toHaveBeenCalledWith({ kind: 'kick', playerName: 'Steve' })
  })

  it('全离线：不执行任何命令并提示所选玩家均已离线', async () => {
    setup([makePlayer({ name: 'Alex', uuid: '00000000-0000-4000-8000-000000000003', isOnline: false })])
    await user.click(screen.getByRole('button', { name: '踢出' }))
    expect(await screen.findByText('批量踢出')).toBeInTheDocument()
    await confirmInDialog()
    await screen.findByText('所选玩家均已离线，无法执行')
    expect(onAction).not.toHaveBeenCalled()
  })

  it('清空背包：危险警告文案 + clear 命令；个体失败走 warning 且带失败详情', async () => {
    setup([makePlayer()])
    await user.click(screen.getByRole('button', { name: '清空背包' }))
    expect(await screen.findByText('批量清空背包')).toBeInTheDocument()
    expect(screen.getByText('此操作不可撤销，所有物品将被永久删除；离线玩家将跳过')).toBeInTheDocument()
    onAction.mockRejectedValueOnce(new Error('boom'))
    await confirmInDialog()
    await screen.findByText('批量清空背包完成：成功 0，失败 1')
    expect(screen.getByText('• Steve：boom')).toBeInTheDocument()
    expect(onAction).toHaveBeenCalledWith({ kind: 'command', command: 'clear Steve' })
  })

  it('游戏模式：下拉选择创造 → 确认 → gamemode creative 命令', async () => {
    setup([makePlayer()])
    await user.click(screen.getByRole('button', { name: '游戏模式' }))
    await user.click(await screen.findByRole('menuitem', { name: '创造' }))
    expect(await screen.findByText('批量切换游戏模式')).toBeInTheDocument()
    await confirmInDialog()
    await screen.findByText('批量切换游戏模式完成：成功 1，失败 0')
    expect(onAction).toHaveBeenCalledWith({ kind: 'command', command: 'gamemode creative Steve' })
  })

  it('游戏模式多目标含离线：在线执行、离线跳过并汇总', async () => {
    setup([
      makePlayer(),
      makePlayer({ name: 'Alex', uuid: '00000000-0000-4000-8000-000000000003', isOnline: false }),
    ])
    await user.click(screen.getByRole('button', { name: '游戏模式' }))
    await user.click(await screen.findByRole('menuitem', { name: '生存' }))
    await confirmInDialog()
    await screen.findByText('批量切换游戏模式完成：成功 1，失败 0，跳过离线 1')
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(onAction).toHaveBeenCalledWith({ kind: 'command', command: 'gamemode survival Steve' })
  })

  it('游戏模式弹窗取消：不执行、状态重置后可重新选择执行', async () => {
    setup([makePlayer()])
    await user.click(screen.getByRole('button', { name: '游戏模式' }))
    await user.click(await screen.findByRole('menuitem', { name: '冒险' }))
    expect(await screen.findByText('批量切换游戏模式')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByText('批量切换游戏模式')).not.toBeInTheDocument())
    expect(onAction).not.toHaveBeenCalled()
    // 状态已重置：重新选择后弹窗可再次打开并正常执行
    await user.click(screen.getByRole('button', { name: '游戏模式' }))
    await user.click(await screen.findByRole('menuitem', { name: '旁观' }))
    expect(await screen.findByText('批量切换游戏模式')).toBeInTheDocument()
    await confirmInDialog()
    await screen.findByText('批量切换游戏模式完成：成功 1，失败 0')
    expect(onAction).toHaveBeenCalledWith({ kind: 'command', command: 'gamemode spectator Steve' })
  })

  it('执行期间全部动作按钮禁用（running 门控），完成后恢复；aria-busy 随执行翻转（J18）', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    onAction.mockImplementation(() => gate)
    setup([makePlayer()])
    await user.click(screen.getByRole('button', { name: '踢出' }))
    await confirmInDialog()
    await waitFor(() => expect(screen.getByRole('button', { name: '传送' })).toBeDisabled())
    expect(screen.getByRole('button', { name: '清空背包' })).toBeDisabled()
    // 读屏的「操作进行中」信号（J18）：执行中 busy，完成后复位
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

  it('确认弹窗取消：不执行动作且弹窗关闭', async () => {
    setup([makePlayer()])
    await user.click(screen.getByRole('button', { name: '白名单' }))
    expect(await screen.findByText('批量添加白名单')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByText('批量添加白名单')).not.toBeInTheDocument())
    expect(onAction).not.toHaveBeenCalled()
  })
})
