import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Player } from '@/api/types'
import { ActionForms } from '../action-forms'

function wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
}

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
  stats: { totalOnline: 3600, loginCount: 1, offlineSince: 0, deathCount: 0, achievementCount: 0, sleepCount: 0 },
}

const defaultOnAction = async () => {}

const defaultProps = {
  player: ONLINE_PLAYER,
  batchTargets: [ONLINE_PLAYER],
  isBatchMode: false,
  instanceId: 'inst-1',
  isRconConnected: true,
  onAction: defaultOnAction,
}

describe('ActionForms', () => {
  it('渲染三个 Tab（经验/效果/召唤）', () => {
    render(<ActionForms {...defaultProps} />, { wrapper })
    expect(screen.getByRole('tab', { name: /经验/ })).toBeTruthy()
    expect(screen.getByRole('tab', { name: /效果/ })).toBeTruthy()
    expect(screen.getByRole('tab', { name: /召唤/ })).toBeTruthy()
  })

  it('经验表单默认显示 10 经验值', () => {
    render(<ActionForms {...defaultProps} />, { wrapper })
    expect(screen.getByDisplayValue('10')).toBeTruthy()
  })

  it('经验表单快捷数量点击更新值', async () => {
    const user = userEvent.setup()
    render(<ActionForms {...defaultProps} />, { wrapper })
    await user.click(screen.getByText('30'))
    expect(screen.getByDisplayValue('30')).toBeTruthy()
  })

  it('经验表单命令预览', () => {
    render(<ActionForms {...defaultProps} />, { wrapper })
    expect(screen.getByText('/xp 10 TestPlayer').textContent).toContain('/xp 10 TestPlayer')
  })

  it('切换到等级模式更新预览', async () => {
    const user = userEvent.setup()
    render(<ActionForms {...defaultProps} />, { wrapper })
    await user.click(screen.getByText('等级'))
    expect(screen.getByText(/\/xp 10L TestPlayer/)).toBeTruthy()
  })

  it('效果表单显示清除全部按钮', async () => {
    const user = userEvent.setup()
    render(<ActionForms {...defaultProps} />, { wrapper })
    await user.click(screen.getByRole('tab', { name: /效果/ }))
    expect(screen.getByText('清除全部')).toBeTruthy()
  })

  it('效果表单搜索过滤', async () => {
    const user = userEvent.setup()
    render(<ActionForms {...defaultProps} />, { wrapper })
    await user.click(screen.getByRole('tab', { name: /效果/ }))
    const searchInput = screen.getByPlaceholderText('搜索效果（中文/ID）')
    await user.type(searchInput, '迅捷')
    expect(screen.getByText('迅捷')).toBeTruthy()
  })

  it('召唤表单显示坐标输入', async () => {
    const user = userEvent.setup()
    render(<ActionForms {...defaultProps} />, { wrapper })
    await user.click(screen.getByRole('tab', { name: /召唤/ }))
    // 三个坐标输入框都有 ~ 默认值
    const tildeInputs = screen.getAllByDisplayValue('~')
    expect(tildeInputs.length).toBe(3)
  })

  it('RCON 未连接显示离线提示', () => {
    render(<ActionForms {...defaultProps} isRconConnected={false} />, { wrapper })
    expect(screen.getByText('RCON 未连接，无法执行操作')).toBeTruthy()
  })
})