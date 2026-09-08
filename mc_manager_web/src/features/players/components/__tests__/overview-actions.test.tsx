/**
 * OverviewActions 操作按钮组行为级测试（issue 489 拆分交付）
 * - 危险操作按钮（清空背包/踢出）点击上抛回调
 * - 游戏模式菜单项触发 runAction 携带 gamemode 命令
 * - 发送消息按钮上抛回调；OP 态切换文案与可逆操作对
 * 数据全部为虚构占位
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Player } from '@/api/types'
import type { PlayerActionRequest } from '../../mutations'
import { OverviewActions } from '../overview-actions'

function makePlayer(overrides: Partial<Player>): Player {
  return {
    name: 'Steve',
    uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    isOnline: false,
    ip: '',
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
    lastSeen: '2024-06-01T13:00:00.000Z',
    health: null,
    maxHealth: null,
    hunger: null,
    xpLevel: null,
    spawnPoint: null,
    respawnPoint: null,
    position: null,
    gameMode: null,
    dimension: null,
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
    stats: { totalOnline: 0, loginCount: 0, offlineSince: 0, deathCount: 0, achievementCount: 0, sleepCount: 0 },
    ...overrides,
  }
}

function renderActions(player: Player, overrides: Partial<Parameters<typeof OverviewActions>[0]> = {}) {
  const mocks = {
    runAction: vi.fn<(key: string, req: PlayerActionRequest, successText?: string) => Promise<void>>(),
    runReversibleAction: vi.fn<
      (key: string, req: PlayerActionRequest, undoReq: PlayerActionRequest, successText: string, undoText: string) => Promise<void>
    >(),
    onSendMessage: vi.fn(),
    onClearInventory: vi.fn(),
    onKick: vi.fn(),
    onOpenBanDialog: vi.fn(),
  }
  render(
    <TooltipProvider>
      <OverviewActions player={player} running={null} {...mocks} {...overrides} />
    </TooltipProvider>,
  )
  return mocks
}

describe('OverviewActions 危险区与回调上抛', () => {
  it('清空背包/踢出按钮点击上抛对应回调', () => {
    const props = renderActions(makePlayer({ isOnline: true }))
    fireEvent.click(screen.getByRole('button', { name: /清空背包/ }))
    fireEvent.click(screen.getByRole('button', { name: /踢出/ }))
    expect(props.onClearInventory).toHaveBeenCalledTimes(1)
    expect(props.onKick).toHaveBeenCalledTimes(1)
  })

  it('发送消息按钮点击上抛 onSendMessage；封禁按钮携带 player', () => {
    const player = makePlayer({ isOnline: true })
    const props = renderActions(player)
    fireEvent.click(screen.getByRole('button', { name: /发送消息/ }))
    fireEvent.click(screen.getByRole('button', { name: /封禁/ }))
    expect(props.onSendMessage).toHaveBeenCalledTimes(1)
    expect(props.onOpenBanDialog).toHaveBeenCalledWith(player)
  })
})

describe('OverviewActions 游戏模式菜单', () => {
  it('展开菜单后点击「创造」触发 runAction 携带 gamemode creative 命令', async () => {
    const userEvent = (await import('@testing-library/user-event')).default
    const props = renderActions(makePlayer({ isOnline: true, gameMode: 'survival' }))
    await userEvent.setup().click(screen.getByRole('button', { name: /游戏模式/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /创造/ }))
    expect(props.runAction).toHaveBeenCalledTimes(1)
    const [key, req, successText] = props.runAction.mock.calls[0]!
    expect(key).toBe('gamemode-creative')
    expect(req).toMatchObject({ kind: 'command', command: 'gamemode creative Steve' })
    expect(successText).toContain('创造模式')
  })

  it('当前模式菜单项禁用（survival 玩家菜单中生存项带 data-disabled）', async () => {
    const userEvent = (await import('@testing-library/user-event')).default
    renderActions(makePlayer({ isOnline: true, gameMode: 'survival' }))
    await userEvent.setup().click(screen.getByRole('button', { name: /游戏模式/ }))
    expect(screen.getByRole('menuitem', { name: /生存/ }).getAttribute('data-disabled')).not.toBeNull()
  })
})

describe('OverviewActions OP/白名单切换', () => {
  it('非 OP 玩家点击「设为OP」触发 runReversibleAction op→deop 对', () => {
    const props = renderActions(makePlayer({ isOp: false }))
    fireEvent.click(screen.getByRole('button', { name: /设为OP/ }))
    expect(props.runReversibleAction).toHaveBeenCalledTimes(1)
    const [key, req, undoReq] = props.runReversibleAction.mock.calls[0]!
    expect(key).toBe('op')
    expect(req).toMatchObject({ kind: 'op', playerName: 'Steve' })
    expect(undoReq).toMatchObject({ kind: 'deop', playerName: 'Steve' })
  })
})
