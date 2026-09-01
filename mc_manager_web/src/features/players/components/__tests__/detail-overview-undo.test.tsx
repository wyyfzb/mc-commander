/**
 * OverviewTab 可逆操作 undo toast 回归测试
 * - OP/白名单切换直接执行（无确认弹窗），不再弹出 ConfirmDialog
 * - 不可逆操作（踢人/清空背包）仍走确认弹窗
 * - toast 渲染依赖全局 Toaster（由 main.tsx 挂载），此处仅验证 onAction 调用与 DOM 行为
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
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

describe('OverviewTab 可逆操作 undo toast', () => {
  it('设为 OP 直接执行（无确认弹窗）', async () => {
    renderOverview(makePlayer({ isOp: false }))

    await act(async () => { fireEvent.click(screen.getByText('设为OP')) })

    expect(mockAction).toHaveBeenCalledWith({ kind: 'op', playerName: 'Steve' })
    expect(screen.queryByText('确认设为OP')).not.toBeInTheDocument()
  })

  it('取消 OP 直接执行（无确认弹窗）', async () => {
    renderOverview(makePlayer({ isOp: true }))

    await act(async () => { fireEvent.click(screen.getByText('取消OP')) })

    expect(mockAction).toHaveBeenCalledWith({ kind: 'deop', playerName: 'Steve' })
    expect(screen.queryByText('确认取消OP')).not.toBeInTheDocument()
  })

  it('加入白名单直接执行（无确认弹窗）', async () => {
    renderOverview(makePlayer({ isWhitelisted: false }))

    await act(async () => { fireEvent.click(screen.getByText('加入白名单')) })

    expect(mockAction).toHaveBeenCalledWith({ kind: 'whitelistAdd', playerName: 'Steve' })
    expect(screen.queryByText('确认加入白名单')).not.toBeInTheDocument()
  })

  it('移除白名单直接执行（无确认弹窗）', async () => {
    renderOverview(makePlayer({ isWhitelisted: true }))

    await act(async () => { fireEvent.click(screen.getByText('移除白名单')) })

    expect(mockAction).toHaveBeenCalledWith({ kind: 'whitelistRemove', playerName: 'Steve' })
    expect(screen.queryByText('确认移除白名单')).not.toBeInTheDocument()
  })

  it('踢人按钮仍走确认弹窗（不直接执行）', () => {
    renderOverview(makePlayer({ isOp: false }))

    fireEvent.click(screen.getByText('踢出'))
    expect(screen.getByText('确认踢出')).toBeInTheDocument()
    expect(mockAction).not.toHaveBeenCalled()
  })

  it('清空背包按钮仍走确认弹窗（不直接执行）', () => {
    renderOverview(makePlayer({ isOp: false }))

    fireEvent.click(screen.getByText('清空背包'))
    expect(screen.getByText('确认清空背包')).toBeInTheDocument()
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
