import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
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
  stats: {
    totalOnline: 3600,
    loginCount: 1,
    offlineSince: 0,
    deathCount: 0,
    achievementCount: 0,
    sleepCount: 0,
  },
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

  it('设置经验值生成 /xp set 语法', async () => {
    const user = userEvent.setup()
    render(<ActionForms {...defaultProps} />, { wrapper })
    await user.click(screen.getByText('设置'))
    expect(screen.getByText(/\/xp set TestPlayer 10$/)).toBeTruthy()
  })

  it('设置等级生成 /xp set ...L 语法', async () => {
    const user = userEvent.setup()
    render(<ActionForms {...defaultProps} />, { wrapper })
    await user.click(screen.getByText('等级'))
    await user.click(screen.getByText('设置'))
    expect(screen.getByText(/\/xp set TestPlayer 10L/)).toBeTruthy()
  })

  it('移除经验值生成带负号命令', async () => {
    const user = userEvent.setup()
    render(<ActionForms {...defaultProps} />, { wrapper })
    await user.click(screen.getByText('移除'))
    expect(screen.getByText(/\/xp -10 TestPlayer/)).toBeTruthy()
  })

  it('移除等级生成带负号 L 命令', async () => {
    const user = userEvent.setup()
    render(<ActionForms {...defaultProps} />, { wrapper })
    await user.click(screen.getByText('等级'))
    await user.click(screen.getByText('移除'))
    expect(screen.getByText(/\/xp -10L TestPlayer/)).toBeTruthy()
  })

  it('给予等级生成正确 L 命令', async () => {
    const user = userEvent.setup()
    render(<ActionForms {...defaultProps} />, { wrapper })
    await user.click(screen.getByText('等级'))
    expect(screen.getByText(/\/xp 10L TestPlayer/)).toBeTruthy()
  })

  it('设置快捷数量更新预览', async () => {
    const user = userEvent.setup()
    render(<ActionForms {...defaultProps} />, { wrapper })
    await user.click(screen.getByText('设置'))
    await user.click(screen.getByText('30'))
    expect(screen.getByText(/\/xp set TestPlayer 30$/)).toBeTruthy()
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

  // ── 单选组键盘模型：组语义 + roving tabindex + 方向键移动即选中 ──
  it('经验表单三组是单选组：方向键移动即选中且焦点跟随', async () => {
    const user = userEvent.setup()
    render(<ActionForms {...defaultProps} />, { wrapper })

    const modeGroup = screen.getByRole('radiogroup', { name: '类型' })
    expect(screen.getByRole('radio', { name: '经验值' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(modeGroup, { key: 'ArrowRight' })
    const levelRadio = screen.getByRole('radio', { name: '等级' })
    expect(levelRadio).toHaveAttribute('aria-checked', 'true')
    expect(document.activeElement).toBe(levelRadio) // 切换回经验值前先验证焦点

    fireEvent.keyDown(modeGroup, { key: 'ArrowLeft' })
    expect(screen.getByRole('radio', { name: '经验值' })).toHaveAttribute('aria-checked', 'true')

    const actionGroup = screen.getByRole('radiogroup', { name: '操作' })
    fireEvent.keyDown(actionGroup, { key: 'ArrowRight' })
    expect(screen.getByRole('radio', { name: '设置' })).toHaveAttribute('aria-checked', 'true')

    await user.click(screen.getByRole('tab', { name: /经验/ }))
    const quickGroup = screen.getByRole('radiogroup', { name: '快捷经验值' })
    const presets = within(quickGroup).getAllByRole('radio')
    // 快捷数值是填数按钮：手输值命中预设才有选中，未命中是无选中态（合法）——
    // 故用 Home 归一后断言，而不是假定某一项初始即选中
    fireEvent.keyDown(quickGroup, { key: 'Home' })
    expect(presets[0]).toHaveAttribute('aria-checked', 'true')
    expect(document.activeElement).toBe(presets[0])
    fireEvent.keyDown(quickGroup, { key: 'ArrowRight' })
    expect(presets[1]).toHaveAttribute('aria-checked', 'true')
    expect(presets[0]).toHaveAttribute('aria-checked', 'false')
    expect(document.activeElement).toBe(presets[1])
  })

  it('效果表单：操作模式与效果网格（跨分类一个组）方向键可用', async () => {
    const user = userEvent.setup()
    render(<ActionForms {...defaultProps} />, { wrapper })
    await user.click(screen.getByRole('tab', { name: /效果/ }))

    const modeGroup = screen.getByRole('radiogroup', { name: '操作模式' })
    expect(screen.getByRole('radio', { name: '赋予效果' })).toHaveAttribute('aria-checked', 'true')

    const effectGroup = screen.getByRole('radiogroup', { name: '状态效果' })
    const effects = within(effectGroup).getAllByRole('radio')
    expect(effects[0]).toHaveAttribute('aria-checked', 'false') // 默认未选任何效果
    expect(effects[0]).toHaveAttribute('tabindex', '0') // 停靠点落首项但不谎报选中
    fireEvent.keyDown(effectGroup, { key: 'ArrowRight' })
    // 无选中：首次方向键落在首项本身（不是停靠点 0 再加一格的第 2 项）
    expect(effects[0]).toHaveAttribute('aria-checked', 'true')
    expect(document.activeElement).toBe(effects[0])
    fireEvent.keyDown(effectGroup, { key: 'ArrowRight' })
    expect(effects[1]).toHaveAttribute('aria-checked', 'true')
    expect(document.activeElement).toBe(effects[1])
    // 操作模式组同样接了线（默认「赋予效果」选中 → 停靠点落它，其余为 -1）
    const modes = within(modeGroup).getAllByRole('radio')
    expect(modes[0]).toHaveAttribute('aria-checked', 'true')
    expect(modes[0]).toHaveAttribute('tabindex', '0')
    expect(modes[1]).toHaveAttribute('tabindex', '-1')
  })

  it('效果表单：等级与持续时间组方向键可用（两组仅在选中非瞬时效果后渲染）', async () => {
    const user = userEvent.setup()
    render(<ActionForms {...defaultProps} />, { wrapper })
    await user.click(screen.getByRole('tab', { name: /效果/ }))

    // 这两组有条件渲染：不先选中一个非瞬时效果根本不存在
    await user.click(screen.getByRole('radio', { name: '迅捷' }))

    const levelGroup = screen.getByRole('radiogroup', { name: '等级' })
    const levels = within(levelGroup).getAllByRole('radio')
    fireEvent.keyDown(levelGroup, { key: 'Home' })
    expect(levels[0]).toHaveAttribute('aria-checked', 'true')
    expect(document.activeElement).toBe(levels[0])
    fireEvent.keyDown(levelGroup, { key: 'ArrowRight' })
    expect(levels[1]).toHaveAttribute('aria-checked', 'true')
    expect(levels[0]).toHaveAttribute('aria-checked', 'false')
    expect(document.activeElement).toBe(levels[1])

    const durationGroup = screen.getByRole('radiogroup', { name: '持续时间' })
    const durations = within(durationGroup).getAllByRole('radio')
    fireEvent.keyDown(durationGroup, { key: 'Home' })
    expect(durations[0]).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(durationGroup, { key: 'End' })
    expect(durations[durations.length - 1]).toHaveAttribute('aria-checked', 'true')
    expect(document.activeElement).toBe(durations[durations.length - 1])
  })

  it('召唤表单：实体网格（跨分类一个组）方向键移动即选中', async () => {
    const user = userEvent.setup()
    render(<ActionForms {...defaultProps} />, { wrapper })
    await user.click(screen.getByRole('tab', { name: /召唤/ }))

    const entityGroup = screen.getByRole('radiogroup', { name: '实体' })
    const entities = within(entityGroup).getAllByRole('radio')
    // 默认未选实体：首次方向键落首项，再按一次才到第 2 项
    fireEvent.keyDown(entityGroup, { key: 'ArrowRight' })
    expect(entities[0]).toHaveAttribute('aria-checked', 'true')
    expect(document.activeElement).toBe(entities[0])
    fireEvent.keyDown(entityGroup, { key: 'ArrowRight' })
    expect(entities[1]).toHaveAttribute('aria-checked', 'true')
    expect(document.activeElement).toBe(entities[1])
    fireEvent.keyDown(entityGroup, { key: 'End' })
    expect(entities[entities.length - 1]).toHaveAttribute('aria-checked', 'true')
  })
})
