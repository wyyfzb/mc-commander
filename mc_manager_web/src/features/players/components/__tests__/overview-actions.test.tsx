/**
 * OverviewActions 操作按钮组行为级测试（issue 489 拆分交付）
 * - 清空背包上抛宿主（不可逆 → 后果清单确认）；踢出直执（无逆操作 → 不挂撤销）
 * - 游戏模式菜单项直执 + 逆操作（切回原模式，可逆口径）
 * - 发送消息按钮上抛回调；OP 态切换文案与逆操作对
 * 数据全部为虚构占位
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Player } from '@/api/types'
import type { PlayerActionRequest } from '../../mutations'
import { OverviewActions, type ActionOutcome } from '../overview-actions'

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

function renderActions(
  player: Player,
  overrides: Partial<Parameters<typeof OverviewActions>[0]> = {},
) {
  const mocks = {
    runAction:
      vi.fn<(key: string, req: PlayerActionRequest, outcome?: ActionOutcome) => Promise<void>>(),
    onSendMessage: vi.fn(),
    onClearInventory: vi.fn(),
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
  it('清空背包上抛宿主确认；踢出直执且不挂撤销（无逆操作）', () => {
    const props = renderActions(makePlayer({ isOnline: true }))
    fireEvent.click(screen.getByRole('button', { name: /清空背包/ }))
    expect(props.onClearInventory).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: /踢出/ }))
    expect(props.runAction).toHaveBeenCalledWith(
      'kick',
      { kind: 'kick', playerName: 'Steve' },
      { successText: '已成功踢出 Steve' },
    )
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
  it('展开菜单后点击「创造」直执 gamemode creative，并带切回原模式的逆操作', async () => {
    const userEvent = (await import('@testing-library/user-event')).default
    const props = renderActions(makePlayer({ isOnline: true, gameMode: 'survival' }))
    await userEvent.setup().click(screen.getByRole('button', { name: /游戏模式/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /创造/ }))
    expect(props.runAction).toHaveBeenCalledTimes(1)
    const [key, req, outcome] = props.runAction.mock.calls[0]!
    expect(key).toBe('gamemode-creative')
    expect(req).toMatchObject({ kind: 'command', command: 'gamemode creative Steve' })
    expect(outcome?.successText).toContain('创造模式')
    expect(outcome?.undo?.req).toMatchObject({
      kind: 'command',
      command: 'gamemode survival Steve',
    })
  })

  it('原模式未知（服务端未采集）时不提供逆操作（不猜默认档）', async () => {
    const userEvent = (await import('@testing-library/user-event')).default
    const props = renderActions(makePlayer({ isOnline: true, gameMode: null }))
    await userEvent.setup().click(screen.getByRole('button', { name: /游戏模式/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /创造/ }))
    expect(props.runAction.mock.calls[0]![2]?.undo).toBeUndefined()
  })

  it('当前模式菜单项禁用（survival 玩家菜单中生存项带 data-disabled）', async () => {
    const userEvent = (await import('@testing-library/user-event')).default
    renderActions(makePlayer({ isOnline: true, gameMode: 'survival' }))
    await userEvent.setup().click(screen.getByRole('button', { name: /游戏模式/ }))
    expect(
      screen.getByRole('menuitem', { name: /生存/ }).getAttribute('data-disabled'),
    ).not.toBeNull()
  })

  it('当前模式菜单项禁用：点击不触发 runAction（门控由 onSelect 收口，不靠 CSS 兜底）', async () => {
    const userEvent = (await import('@testing-library/user-event')).default
    const props = renderActions(makePlayer({ isOnline: true, gameMode: 'survival' }))
    await userEvent.setup().click(screen.getByRole('button', { name: /游戏模式/ }))

    const current = screen.getByRole('menuitem', { name: /生存/ })
    // 直派 click 绕过 data-disabled:pointer-events-none 的兜底
    fireEvent.click(current)
    expect(props.runAction).not.toHaveBeenCalled()
  })
})

describe('OverviewActions OP/白名单切换', () => {
  it('非 OP 玩家点击「设为OP」直执 op 并带 deop 逆操作（可逆口径）', () => {
    const props = renderActions(makePlayer({ isOp: false }))
    fireEvent.click(screen.getByRole('button', { name: /设为OP/ }))
    expect(props.runAction).toHaveBeenCalledTimes(1)
    const [key, req, outcome] = props.runAction.mock.calls[0]!
    expect(key).toBe('op')
    expect(req).toMatchObject({ kind: 'op', playerName: 'Steve' })
    expect(outcome?.undo?.req).toMatchObject({ kind: 'deop', playerName: 'Steve' })
  })
})
