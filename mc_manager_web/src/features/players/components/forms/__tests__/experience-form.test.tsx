import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Player } from '@/api/types'
import { ExperienceForm } from '../experience-form'

const ONLINE_PLAYER: Player = {
  name: 'TestPlayer',
  uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  isOnline: true,
  ip: '127.0.0.1',
  joinTime: 1700000000000,
  onlineTime: 3600,
  totalPlayTime: 3600,
  isOp: false,
  isWhitelisted: false,
  isBanned: false,
  banExpiresAt: null,
  isIpBanned: false,
  ipBanExpiresAt: null,
  isFakePlayer: false,
  lastSeen: null,
  health: 20,
  maxHealth: 20,
  hunger: 20,
  xpLevel: 5,
  xpProgress: 0,
  spawnPoint: null,
  respawnPoint: null,
  position: { x: 100, y: 64, z: -200 },
  gameMode: 'survival',
  dimension: 'overworld',
  armor: 0,
  ping: 50,
  isSleeping: false,
  isAfk: false,
  isFlying: false,
  isSneaking: false,
  isSprinting: false,
  isBurning: false,
  isFrozen: false,
  inventory: null,
  events: [],
  sessions: [],
  stats: {
    totalOnline: 3600,
    loginCount: 1,
    offlineSince: 0,
    deathCount: 0,
    achievementCount: 0,
    sleepCount: 0,
  },
}

describe('ExperienceForm（issue 480 拆分后组件行为级测试）', () => {
  it('单模式提交路径：默认 10 经验值提交，onAction 收到 /xp 命令', async () => {
    const user = userEvent.setup()
    const onAction = vi.fn(async () => {})
    render(
      <ExperienceForm
        player={ONLINE_PLAYER}
        batchTargets={[ONLINE_PLAYER]}
        isBatchMode={false}
        instanceId="inst-1"
        isRconConnected={true}
        onAction={onAction}
      />,
    )

    await user.click(screen.getByRole('button', { name: /给予经验/ }))

    expect(onAction).toHaveBeenCalledTimes(1)
    expect(onAction).toHaveBeenCalledWith({ kind: 'command', command: '/xp 10 TestPlayer' })
  })

  it('批量模式提交路径：对每个批量目标执行命令', async () => {
    const user = userEvent.setup()
    const onAction = vi.fn(async () => {})
    render(
      <ExperienceForm
        player={null}
        batchTargets={[ONLINE_PLAYER]}
        isBatchMode={true}
        instanceId="inst-1"
        isRconConnected={true}
        onAction={onAction}
      />,
    )

    const submit = screen.getByRole('button', { name: /给予经验（1 名玩家）/ })
    await user.click(submit)

    expect(onAction).toHaveBeenCalledTimes(1)
    expect(onAction).toHaveBeenCalledWith({ kind: 'command', command: '/xp 10 TestPlayer' })
  })

  it('离线防护：RCON 未连接时提交按钮禁用且不触发 onAction', async () => {
    const user = userEvent.setup()
    const onAction = vi.fn(async () => {})
    render(
      <ExperienceForm
        player={ONLINE_PLAYER}
        batchTargets={[ONLINE_PLAYER]}
        isBatchMode={false}
        instanceId="inst-1"
        isRconConnected={false}
        onAction={onAction}
      />,
    )

    expect(screen.getByText('RCON 未连接，无法执行操作')).toBeTruthy()
    const submit = screen.getByRole('button', { name: /给予经验/ })
    expect(submit.hasAttribute('disabled')).toBe(true)

    await user.click(submit).catch(() => {})
    expect(onAction).not.toHaveBeenCalled()
  })
})
