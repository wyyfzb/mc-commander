import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { BigStatCards, PlayersCard, RuntimeInfoCard, tpsColor } from '../components/stat-cards'
import { useServerStore } from '@/stores/server'
import { mockInstanceStatus } from '@/test/mocks/handlers'

// ECharts 在 jsdom 无 canvas：sparkline 在组件测试中替换为空实现（E2E 覆盖真实渲染）
vi.mock('@/components/mcs/sparkline', () => ({
  Sparkline: () => null,
}))

/**
 * 统计卡组件测试：TPS 阈值变色 / 顶部四卡大数字 / 在线玩家整行可点 / 运行信息
 */

const emptyHistory = { cpu: [], mem: [], tps: [] }

function setState(status = mockInstanceStatus) {
  useServerStore.setState({
    status,
    systemStats: { cpuUsage: 12.5, memoryUsage: 4.2, totalMemory: 16, memoryPercent: 26.3, cpuCores: 4, loadAvg: [0.1], uptime: 86400 },
    instanceId: 'demo',
    socketConnected: true,
    lastStatusEvent: null,
  })
}

describe('tpsColor 阈值规则（≥19 健康 / 15-19 卡顿 / <15 严重）', () => {
  it('阈值分档', () => {
    expect(tpsColor(20, true)).toBe('text-mcs-success-fg')
    expect(tpsColor(19, true)).toBe('text-mcs-success-fg')
    expect(tpsColor(18, true)).toBe('text-mcs-warning-fg')
    expect(tpsColor(15, true)).toBe('text-mcs-warning-fg')
    expect(tpsColor(14, true)).toBe('text-mcs-error-fg')
  })

  it('未运行或 TPS 缺失 → 灰', () => {
    expect(tpsColor(null, false)).toBe('text-mcs-text-subtle')
    expect(tpsColor(20, false)).toBe('text-mcs-text-subtle')
  })
})

describe('BigStatCards 顶部四卡', () => {
  beforeEach(() => setState())

  it('在线玩家大数字 + online/max + 头像帽', () => {
    render(<BigStatCards history={emptyHistory} />)
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('3/20')).toBeInTheDocument()
    expect(screen.getByText('OP 1 · 入睡 1 · 今日新增 2')).toBeInTheDocument()
  })

  it('TPS 大数字 + 健康标签 + CPU/内存数值与进度条', () => {
    render(<BigStatCards history={emptyHistory} />)
    expect(screen.getByText('20.0')).toBeInTheDocument()
    expect(screen.getByText('健康')).toBeInTheDocument()
    expect(screen.getByText('12.5')).toBeInTheDocument()
    expect(screen.getByText('4 核')).toBeInTheDocument()
    expect(screen.getByText('4.2')).toBeInTheDocument()
    expect(screen.getByText((content) => content.includes('/ 16G'))).toBeInTheDocument()
    // 进度条语义
    expect(screen.getAllByRole('progressbar').length).toBe(2)
  })

  it('TPS 卡顿显示「卡顿」+ warning 色', () => {
    setState({ ...mockInstanceStatus, tps: 17 })
    render(<BigStatCards history={emptyHistory} />)
    expect(screen.getByText('卡顿')).toBeInTheDocument()
    expect(screen.getByText('17.0').className).toContain('text-mcs-warning-fg')
  })

  it('未运行时 TPS 显示 -- 且无健康标签', () => {
    setState({ ...mockInstanceStatus, isRunning: false, tps: 0 })
    render(<BigStatCards history={emptyHistory} />)
    expect(screen.queryByText('健康')).not.toBeInTheDocument()
    expect(screen.queryByText('卡顿')).not.toBeInTheDocument()
    expect(screen.getByText('--')).toBeInTheDocument()
  })
})

describe('PlayersCard（右栏可点行）', () => {
  beforeEach(() => setState())

  const renderCard = () =>
    render(
      <MemoryRouter>
        <PlayersCard />
      </MemoryRouter>,
    )

  it('正常态：online/max + OP 徽章 + 每行直达详情 + 入睡/清醒计数', () => {
    renderCard()
    expect(screen.getByText('3/20')).toBeInTheDocument()
    expect(screen.getByText('OP 1/3')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '查看 Steve 详情' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '查看 Alex 详情' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '查看 Bob 详情' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '查看全部玩家' })).toBeInTheDocument()
    expect(screen.getAllByText('入睡').length).toBeGreaterThan(0)
    expect(screen.getAllByText('清醒').length).toBeGreaterThan(0)
  })

  it('无玩家 + 运行中 → 「暂无玩家在线」', () => {
    setState({
      ...mockInstanceStatus,
      playerCount: 0,
      opCount: 0,
      opNames: [],
      sleepingPlayers: 0,
      sleepingPlayerNames: [],
      awakePlayerNames: [],
    })
    renderCard()
    expect(screen.getByText('暂无玩家在线')).toBeInTheDocument()
  })

  it('无玩家 + 停止 → 「实例已停止，暂无玩家数据」', () => {
    setState({
      ...mockInstanceStatus,
      isRunning: false,
      playerCount: 0,
      opCount: 0,
      opNames: [],
      sleepingPlayers: 0,
      sleepingPlayerNames: [],
      awakePlayerNames: [],
    })
    renderCard()
    expect(screen.getByText('实例已停止，暂无玩家数据')).toBeInTheDocument()
  })

  it('RCON 未连接 → 提示启用 RCON', () => {
    setState({ ...mockInstanceStatus, isRconConnected: false, sleepingPlayerNames: [], awakePlayerNames: [] })
    renderCard()
    expect(screen.getByText('需启用 RCON 才能读取在线玩家')).toBeInTheDocument()
  })
})

describe('RuntimeInfoCard', () => {
  beforeEach(() => setState())

  it('显示本次运行时长/累计运行/启动时间/上次存档', () => {
    render(<RuntimeInfoCard />)
    expect(screen.getByText('2h 0m')).toBeInTheDocument() // 7200s
    expect(screen.getByText('1天 0小时')).toBeInTheDocument() // 86400s=1天整
    expect(screen.getByText('上次存档')).toBeInTheDocument()
    expect(screen.getByText('5分钟前')).toBeInTheDocument()
  })

  it('未运行时显示「未运行」', () => {
    setState({ ...mockInstanceStatus, isRunning: false, uptime: 0 })
    render(<RuntimeInfoCard />)
    expect(screen.getByText('未运行')).toBeInTheDocument()
  })
})
