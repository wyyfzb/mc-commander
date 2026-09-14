/**
 * 行内操作菜单的禁用门控（J71）
 * @radix-ui/react-menu 的 disabled 只拦内部 handleSelect（即 onSelect）；用 onClick 时
 * 「离线禁用」只剩基类 data-disabled:pointer-events-none 的 CSS 兜底，jsdom 与事件直派路径都验不到。
 * 本用例直派 click 事件，验证三个需在线的菜单项（传送/给予物品/踢出）不触发任何回调。
 * mock 数据为结构占位（虚构玩家 Bob），严禁真实玩家/服务器信息
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TooltipProvider } from '@/components/ui/tooltip'
import { PlayerTable } from '../player-table'
import { usePlayersUiStore } from '../../store'
import type { Player } from '@/api/types'

function makeOfflinePlayer(): Player {
  return {
    name: 'Bob',
    uuid: '00000000-0000-4000-8000-000000000004',
    isOnline: false,
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
    stats: { totalOnline: 0, loginCount: 0, offlineSince: 0, deathCount: 0, achievementCount: 0, sleepCount: 0 },
  }
}

function setup(player: Player) {
  const onOpenDetail = vi.fn()
  const onOpenBan = vi.fn()
  const onAction = vi.fn()
  const onKicked = vi.fn()
  render(
    <TooltipProvider>
      <PlayerTable
        players={[player]}
        isLoading={false}
        totalCount={1}
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

beforeEach(() => {
  usePlayersUiStore.setState({ selectedUuids: [] })
})

describe('行内操作菜单 · 需在线项的禁用门控（J71）', () => {
  it('离线玩家：传送/给予物品/踢出禁用，点击不触发回调、不打开确认弹窗', async () => {
    const user = userEvent.setup()
    const props = setup(makeOfflinePlayer())
    await user.click(screen.getByRole('button', { name: 'Bob 操作菜单' }))

    const items = await Promise.all(
      ['传送', '给予物品', '踢出'].map((name) => screen.findByRole('menuitem', { name })),
    )
    for (const item of items) {
      expect(item).toHaveAttribute('aria-disabled', 'true')
      // 直派 click 绕过 pointer-events 兜底：禁用门控必须由 JS 保证
      fireEvent.click(item)
    }

    expect(props.onOpenDetail).not.toHaveBeenCalled()
    expect(props.onAction).not.toHaveBeenCalled()
    expect(props.onKicked).not.toHaveBeenCalled()
    expect(screen.queryByText('确认踢出')).not.toBeInTheDocument()
  })

  it('在线玩家：同一批菜单项照常触发（门控不误伤可用路径）', async () => {
    const user = userEvent.setup()
    const props = setup({ ...makeOfflinePlayer(), name: 'Steve', isOnline: true })
    await user.click(screen.getByRole('button', { name: 'Steve 操作菜单' }))

    await user.click(await screen.findByRole('menuitem', { name: '传送' }))
    expect(props.onOpenDetail).toHaveBeenCalledWith('Steve', 'teleport')
  })
})
