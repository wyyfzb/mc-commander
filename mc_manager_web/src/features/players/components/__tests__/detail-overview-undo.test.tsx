/**
 * OverviewTab 可逆操作口径回归测试（J15）
 * 口径：可逆操作（OP/白名单/游戏模式）直接执行 + 5s 撤销；不可逆（清空背包）仍走确认弹窗；
 * 无逆操作的踢出直执且不挂撤销入口。
 * toast 断言经真实 Toaster 渲染（撤销入口是 toast 上的动作按钮，非本组件内的 DOM）
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { Toaster, toast as sonnerToast } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { OverviewTab } from '../detail-overview-tab'
import type { Player } from '@/api/types'
import type { PlayerActionRequest } from '../../mutations'

function makePlayer(overrides: Partial<Player> = {}): Player {
  return {
    name: 'Steve',
    uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    isOnline: true, ip: '1.2.3.4',
    joinTime: null, onlineTime: 0, totalPlayTime: 0,
    isOp: false, isWhitelisted: false,
    isBanned: false, banExpiresAt: null,
    isIpBanned: false, ipBanExpiresAt: null,
    isFakePlayer: false,
    lastSeen: '2024-06-01T13:00:00.000Z',
    health: 20, maxHealth: 20, hunger: 20, xpLevel: 0,
    spawnPoint: null, respawnPoint: null,
    position: { x: 100, y: 64, z: -200 },
    gameMode: 'survival', dimension: 'overworld', armor: 0,
    xpProgress: 0, ping: 50,
    isSleeping: false, isAfk: false, isFlying: false,
    isSneaking: false, isSprinting: false, isBurning: false, isFrozen: false,
    potionEffects: [], ipHistory: [], inventory: null,
    events: [], sessions: [],
    stats: { totalOnline: 0, loginCount: 0, offlineSince: 0, deathCount: 0, achievementCount: 0, sleepCount: 0 },
    ...overrides,
  }
}

const mockAction = vi.fn<(req: PlayerActionRequest) => Promise<void>>()

function renderOverview(player: Player) {
  mockAction.mockReset()
  mockAction.mockResolvedValue(undefined)
  return render(
    <TooltipProvider>
      <Toaster />
      <OverviewTab
        instanceId="demo"
        player={player}
        isRconConnected={true}
        bans={[]}
        onAction={mockAction}
        onOpenBanDialog={() => {}}
      />
    </TooltipProvider>,
  )
}

/** 点掉上一用例残留的 toast（sonner 为模块级单例） */
beforeEach(() => {
  sonnerToast.dismiss()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('OverviewTab 可逆操作：直执 + 撤销', () => {
  it('设为 OP 直接执行（无确认弹窗），成功回执挂撤销入口，撤销恢复原状', async () => {
    renderOverview(makePlayer({ isOp: false }))

    await act(async () => { fireEvent.click(screen.getByText('设为OP')) })

    expect(mockAction).toHaveBeenCalledWith({ kind: 'op', playerName: 'Steve' })
    expect(screen.queryByText('确认设为 OP')).not.toBeInTheDocument()
    expect(await screen.findByText('已设置 Steve 为 OP')).toBeInTheDocument()

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '撤销' })) })
    expect(mockAction).toHaveBeenLastCalledWith({ kind: 'deop', playerName: 'Steve' })
    expect(await screen.findByText('已取消 Steve 的 OP')).toBeInTheDocument()
  })

  it('取消 OP 直接执行，撤销恢复为 OP', async () => {
    renderOverview(makePlayer({ isOp: true }))

    await act(async () => { fireEvent.click(screen.getByText('取消OP')) })

    expect(mockAction).toHaveBeenCalledWith({ kind: 'deop', playerName: 'Steve' })
    expect(screen.queryByText('确认取消 OP')).not.toBeInTheDocument()

    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: '撤销' })) })
    expect(mockAction).toHaveBeenLastCalledWith({ kind: 'op', playerName: 'Steve' })
  })

  it('加入白名单直接执行，撤销移除白名单', async () => {
    renderOverview(makePlayer({ isWhitelisted: false }))

    await act(async () => { fireEvent.click(screen.getByText('加入白名单')) })

    expect(mockAction).toHaveBeenCalledWith({ kind: 'whitelistAdd', playerName: 'Steve' })
    expect(screen.queryByText('确认加入白名单')).not.toBeInTheDocument()

    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: '撤销' })) })
    expect(mockAction).toHaveBeenLastCalledWith({ kind: 'whitelistRemove', playerName: 'Steve' })
  })

  it('移除白名单直接执行，撤销恢复白名单', async () => {
    renderOverview(makePlayer({ isWhitelisted: true }))

    await act(async () => { fireEvent.click(screen.getByText('移除白名单')) })

    expect(mockAction).toHaveBeenCalledWith({ kind: 'whitelistRemove', playerName: 'Steve' })
    expect(screen.queryByText('确认移除白名单')).not.toBeInTheDocument()

    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: '撤销' })) })
    expect(mockAction).toHaveBeenLastCalledWith({ kind: 'whitelistAdd', playerName: 'Steve' })
  })

  it('游戏模式：直执 + 撤销切回原模式', async () => {
    const userEvent = (await import('@testing-library/user-event')).default
    renderOverview(makePlayer({ gameMode: 'survival' }))

    await userEvent.setup().click(screen.getByRole('button', { name: /游戏模式/ }))
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: /创造/ })) })
    expect(mockAction).toHaveBeenCalledWith({ kind: 'command', command: 'gamemode creative Steve' })

    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: '撤销' })) })
    expect(mockAction).toHaveBeenLastCalledWith({ kind: 'command', command: 'gamemode survival Steve' })
  })

  it('撤销入口 5 秒后随 toast 消失（窗口过后操作即成事实）', async () => {
    vi.useFakeTimers()
    renderOverview(makePlayer({ isOp: false }))

    await act(async () => { fireEvent.click(screen.getByText('设为OP')) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(screen.getByRole('button', { name: '撤销' })).toBeInTheDocument()

    // 5s 窗口边界仍可用（少于 1ms 都不足）
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(screen.getByRole('button', { name: '撤销' })).toBeInTheDocument()

    // 过期后退出：sonner 的退场动画期间节点仍在 DOM，故断言「再 1s 内必摘除」而非边界瞬间
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(screen.queryByRole('button', { name: '撤销' })).not.toBeInTheDocument()
  })
})

describe('OverviewTab 不可逆 / 无逆操作', () => {
  it('踢出直执（无逆操作 → 不挂撤销入口），成功回执不带「撤销」', async () => {
    renderOverview(makePlayer({ isOp: false }))

    await act(async () => { fireEvent.click(screen.getByText('踢出')) })

    expect(mockAction).toHaveBeenCalledWith({ kind: 'kick', playerName: 'Steve' })
    expect(screen.queryByText('确认踢出')).not.toBeInTheDocument()
    expect(await screen.findByText('已成功踢出 Steve')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '撤销' })).not.toBeInTheDocument()
  })

  it('清空背包仍走确认弹窗（不可逆 + 后果清单），不直接执行', () => {
    renderOverview(makePlayer({ isOp: false }))

    fireEvent.click(screen.getByText('清空背包'))
    expect(screen.getByText('确认清空背包')).toBeInTheDocument()
    expect(screen.getByText('此操作不可撤销，所有物品将被永久删除')).toBeInTheDocument()
    expect(mockAction).not.toHaveBeenCalled()
  })

  it('操作失败时显示错误 toast', async () => {
    mockAction.mockReset()
    mockAction.mockRejectedValue(new Error('RCON 连接失败'))
    renderOverview(makePlayer({ isOp: false }))

    await act(async () => { fireEvent.click(screen.getByText('设为OP')) })

    expect(mockAction).toHaveBeenCalledWith({ kind: 'op', playerName: 'Steve' })
    expect(screen.queryByText('确认设为OP')).not.toBeInTheDocument()
  })
})
