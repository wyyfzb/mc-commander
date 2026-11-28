import { describe, it, expect, beforeEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import {
  BigStatCards,
  PlayersCard,
  RuntimeInfoCard,
  tpsColor,
} from '@/features/dashboard/components/stat-cards'
import { useServerStore } from '@/stores/server'
import { mockInstanceStatus } from '@tests/support/handlers'
import { formatStartTime } from '@/lib/format'

/**
 * 统计卡组件测试：TPS 阈值变色 / 资源卡三行 / 在线玩家整行可点 / 运行信息
 */

function setState(status = mockInstanceStatus) {
  useServerStore.setState({
    status,
    systemStats: {
      cpuUsage: 12.5,
      memoryUsage: 4.2,
      totalMemory: 16,
      memoryPercent: 26.3,
      cpuCores: 4,
      loadAvg: [0.1],
      uptime: 86400,
    },
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
    expect(tpsColor(null, false)).toBe('text-mcs-text-muted')
    expect(tpsColor(20, false)).toBe('text-mcs-text-muted')
  })
})

describe('BigStatCards 资源卡', () => {
  beforeEach(() => setState())

  it('TPS 信息 + 健康标签 + CPU/内存/磁盘数值与进度条', () => {
    render(<BigStatCards />)
    expect(screen.getByText('20.0')).toBeInTheDocument()
    expect(screen.getByText('健康')).toBeInTheDocument()
    expect(screen.getByText('12.5')).toBeInTheDocument()
    expect(screen.getByText('4 核')).toBeInTheDocument()
    expect(screen.getByText('4.2')).toBeInTheDocument()
    expect(screen.getByText((content) => content.includes('/ 16G'))).toBeInTheDocument()
    expect(screen.getByText('磁盘')).toBeInTheDocument()
    // 进度条语义：只有拿到数据的行才是 progressbar（本夹具无 diskUsage，磁盘行不带语义）
    expect(screen.getAllByRole('progressbar')).toHaveLength(2)
  })

  it('数据卡标签行走标签档，TPS 大数走数字档、单位留小档（Grafana 三段式）', () => {
    render(<BigStatCards />)
    // 标签行不得升为区块标题档（否则与真区块标题同级）
    const title = screen.getByRole('heading', { name: '资源使用' })
    expect(title.className).toContain('text-mcs-sm')
    expect(title.className).not.toContain('text-mcs-lg')
    // 大数：display 档 + .mcs-num；同一次 cn 调用里的阈值色不得吞掉字号档（同组互吞）
    const value = screen.getByText('20.0')
    expect(value.className).toContain('mcs-num')
    expect(value.className).toContain('text-mcs-display')
    expect(value.className).toContain('text-mcs-success-fg')
    expect(value.className).not.toContain('text-mcs-lg')
    // 单位/后缀不随数字放大
    expect(screen.getByText('TPS').className).toContain('text-mcs-lg')
  })

  it('顶排卡走紧凑卡档（p-3 / gap-2）：首屏高度必须还给终端', () => {
    render(<BigStatCards />)
    const card = screen.getByRole('heading', { name: '资源使用' }).closest('section')
    expect(card).not.toBeNull()
    expect(card!.className).toContain('p-3')
    expect(card!.className).toContain('gap-2')
    expect(card!.className).not.toContain('p-4')
  })

  it('整机数据未到：CPU/内存显示「暂无数据」，不拿实例口径（进程 RSS / 整机总量）顶替', () => {
    // 实例状态在（status 有 memoryUsage=3.2 / cpuUsage），但 /system-stats 尚未送达
    useServerStore.setState({ systemStats: null })
    render(<BigStatCards />)

    // 混用会渲染成「进程 RSS / 整机总量」的失真比例与百分比
    expect(screen.getAllByText('暂无数据')).toHaveLength(2)
    expect(screen.queryByText('3.2')).not.toBeInTheDocument()
    expect(screen.queryByText((content) => content.includes('/ 16G'))).not.toBeInTheDocument()
    // 无数据的行不得暴露进度语义：否则读屏播报「0%」，与可见文案「暂无数据」互相矛盾
    expect(screen.queryAllByRole('progressbar')).toHaveLength(0)
  })

  it('TPS 卡顿显示「卡顿」+ warning 色', () => {
    setState({ ...mockInstanceStatus, tps: 17 })
    render(<BigStatCards />)
    expect(screen.getByText('卡顿')).toBeInTheDocument()
    expect(screen.getByText('17.0').className).toContain('text-mcs-warning-fg')
  })

  it('未运行时无 TPS 信息与健康标签', () => {
    setState({ ...mockInstanceStatus, isRunning: false, tps: 0 })
    render(<BigStatCards />)
    expect(screen.queryByText('健康')).not.toBeInTheDocument()
    expect(screen.queryByText('卡顿')).not.toBeInTheDocument()
    expect(screen.queryByText('--')).not.toBeInTheDocument()
  })

  it('已就绪但 TPS 未采到时不显示 TPS 或健康结论', () => {
    setState({ ...mockInstanceStatus, startupState: 'ready', tps: null })
    render(<BigStatCards />)
    expect(screen.queryByText(/^(TPS|健康|卡顿)$/)).not.toBeInTheDocument()
  })

  it.each([
    { totalMemory: 0, memoryUsage: 0 },
    { totalMemory: -1, memoryUsage: 0 },
    { totalMemory: 16, memoryUsage: -1 },
  ])('缺少有效读数（$memoryUsage / $totalMemory）时不显示内存百分比或进度', (memory) => {
    const stats = useServerStore.getState().systemStats!
    useServerStore.setState({ systemStats: { ...stats, ...memory, memoryPercent: 0 } })
    render(<BigStatCards />)
    expect(screen.getByText('暂无数据')).toBeInTheDocument()
    expect(screen.queryByText('0%')).not.toBeInTheDocument()
    expect(screen.getAllByRole('progressbar')).toHaveLength(1)
  })

  it('总量有效时保留真实的 0% 用量', () => {
    const stats = useServerStore.getState().systemStats!
    useServerStore.setState({ systemStats: { ...stats, memoryUsage: 0, memoryPercent: 0 } })
    render(<BigStatCards />)
    expect(screen.getByText('0%')).toBeInTheDocument()
    expect(screen.getByText('0.0')).toBeInTheDocument()
    expect(screen.getAllByRole('progressbar')[1]).toHaveAttribute('aria-valuenow', '0')
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
    // 主数字分母独立节点（值大/分母小淡的分层排版），分别断言
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('/20')).toBeInTheDocument()
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
      startupState: 'stopped',
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

  it('已有在线人数但明细缺失时，不从 RCON 配置推断无人在线或强制用户启用 RCON', () => {
    setState({
      ...mockInstanceStatus,
      capabilities: { rcon: false, msmp: true, msmpPush: true },
      sleepingPlayerNames: [],
      awakePlayerNames: [],
    })
    renderCard()
    expect(screen.getByText('暂无玩家明细')).toBeInTheDocument()
    expect(screen.queryByText('暂无玩家在线')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '前往服务器属性' })).not.toBeInTheDocument()
  })

  it.each(['starting', 'unknown'] as const)(
    '状态 %s 不展示未确认的在线名单或 OP 数',
    (startupState) => {
      setState({ ...mockInstanceStatus, startupState })
      renderCard()
      expect(screen.getByText('尚未确认在线玩家')).toBeInTheDocument()
      expect(screen.queryByText('OP 1/3')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: '查看 Steve 详情' })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: '查看全部玩家' })).toBeEnabled()
    },
  )

  it('已切换实例但快照仍来自上一实例时不显示该快照', () => {
    useServerStore.setState({ instanceId: '另一个实例' })
    renderCard()
    expect(screen.getByText('尚未确认在线玩家')).toBeInTheDocument()
    expect(screen.queryByText('实例已停止，暂无玩家数据')).not.toBeInTheDocument()
    expect(screen.queryByText('OP 1/3')).not.toBeInTheDocument()
  })
})

describe('RuntimeInfoCard', () => {
  beforeEach(() => setState())

  it('显示本次运行时长/累计运行/启动时间/上次存档', () => {
    render(<RuntimeInfoCard />)
    expect(screen.getByText('2h 0m')).toBeInTheDocument() // 7200s
    expect(screen.getByText('1d 0h')).toBeInTheDocument() // 86400s=1天整
    expect(screen.getByText('上次存档')).toBeInTheDocument()
    // 上次存档改绝对时间显示（「5分钟前」类模糊值降级为悬停提示）
    expect(screen.getByText(formatStartTime(mockInstanceStatus.lastSave))).toBeInTheDocument()
    expect(screen.queryByText('5分钟前')).not.toBeInTheDocument()
    // 本卡关键数字与顶排另两卡同档（明细行留在 xs）
    expect(screen.getByText('2h 0m').className).toContain('text-mcs-display')
  })

  it('进程已运行时仅按服务端启动状态报告就绪，进程时长不受就绪影响', () => {
    setState({ ...mockInstanceStatus, startupState: 'starting' })
    render(
      <>
        <RuntimeInfoCard />
        <BigStatCards />
      </>,
    )
    expect(screen.getByRole('status')).toHaveTextContent('启动中')
    expect(screen.getByText('2h 0m')).toBeInTheDocument()
    expect(screen.queryByText('健康')).not.toBeInTheDocument()

    act(() => setState({ ...mockInstanceStatus, startupState: 'unknown' }))
    expect(screen.getByRole('status')).toHaveTextContent('就绪未知')
    expect(screen.queryByText('健康')).not.toBeInTheDocument()

    act(() => setState({ ...mockInstanceStatus, startupState: 'ready' }))
    expect(screen.getByRole('status')).toHaveTextContent('已就绪')
    expect(screen.getByText('健康')).toBeInTheDocument()
  })

  it('未运行时显示已停止与无运行时长', () => {
    setState({ ...mockInstanceStatus, isRunning: false, startupState: 'stopped', uptime: 0 })
    render(<RuntimeInfoCard />)
    expect(screen.getByRole('status')).toHaveTextContent('已停止')
    expect(screen.getByText('未运行')).toBeInTheDocument()
  })
})
