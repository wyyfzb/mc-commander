/**
 * OverviewTab 组件测试（生产 bug 回归：真实服务端详情接口不返回
 * potionEffects/ipHistory 字段，类型却声明为必填数组 → 渲染 .length 崩溃）
 * - 真实服务端契约形态（缺字段）渲染不崩溃
 * - 提供字段时正常展示 IP 登录历史 / 药水效果
 * 数据全部为虚构占位
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { Player } from '@/api/types'
import { TooltipProvider } from '@/components/ui/tooltip'
import { OverviewTab } from '../detail-overview-tab'

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

function renderOverview(player: Player) {
  return render(
    <TooltipProvider>
      <OverviewTab
        instanceId="demo"
        player={player}
        isRconConnected={false}
        bans={[]}
        onAction={async () => {}}
        onOpenBanDialog={() => {}}
      />
    </TooltipProvider>,
  )
}

describe('OverviewTab 生产契约回归', () => {
  it('真实服务端契约：无 potionEffects/ipHistory 字段（undefined）渲染不崩溃', () => {
    // 模拟真实详情接口 JSON：这两个键根本不存在（= undefined），
    // 类型断言仅为通过编译——运行时形态与生产一致
    const minimal = {
      ...makePlayer({}),
      potionEffects: undefined,
      ipHistory: undefined,
    } as unknown as Player
    renderOverview(minimal)
    expect(screen.getByText('基本信息')).toBeInTheDocument()
    expect(screen.queryByText('IP 登录历史')).not.toBeInTheDocument()
  })

  it('在线玩家同样缺 potionEffects（isOnline=true 分支）不崩溃', () => {
    const minimal = {
      ...makePlayer({ isOnline: true, isSleeping: true, isAfk: true }),
      potionEffects: undefined,
      ipHistory: undefined,
    } as unknown as Player
    renderOverview(minimal)
    expect(screen.getByText('基本信息')).toBeInTheDocument()
    expect(screen.queryByText('药水效果')).not.toBeInTheDocument()
  })

  it('提供字段时展示 IP 登录历史', () => {
    renderOverview(
      makePlayer({
        ipHistory: [{ ip: '203.0.113.1', lastSeen: '2024-06-01', count: 2 }],
      }),
    )
    expect(screen.getByText('IP 登录历史')).toBeInTheDocument()
    expect(screen.getByText('203.0.113.1')).toBeInTheDocument()
  })
})
