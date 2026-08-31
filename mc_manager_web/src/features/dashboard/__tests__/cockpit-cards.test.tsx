import type { ReactNode } from 'react'
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setupServer } from 'msw/node'
import { Toaster } from 'sonner'
import { handlers } from '@/test/mocks/handlers'
import { McClockCard, dayCycle, interpolateTick } from '../components/mc-clock-card'
import { EventsCard } from '../components/events-card'
import { AnnouncementCard } from '../components/announcement-card'
import { useServerStore } from '@/stores/server'
import { useConnectionStore } from '@/stores/connection'
import { useTerminalStore } from '@/stores/terminal'
import { useUiStore } from '@/stores/ui'
import { useNotificationStore } from '@/stores/notifications'
import type { AppNotification } from '@/lib/notifications'
import { mockInstanceStatus } from '@/test/mocks/handlers'

/**
 * 驾驶舱右栏三卡组件测试：MC 时钟（纯函数 + 联动发送）/ 事件与待办（抽屉深链）/ 公告发送
 */

const server = setupServer(...handlers)
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())

function renderWithProviders(ui: ReactNode) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      {ui}
      <Toaster />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  localStorage.clear()
  useConnectionStore.setState({ baseUrl: '', apiKey: 'test-key', status: 'ready' })
  useServerStore.setState({
    status: mockInstanceStatus,
    systemStats: null,
    instanceId: 'demo',
    socketConnected: true,
    lastStatusEvent: null,
  })
  useTerminalStore.setState({ buffer: [], instanceId: 'demo', suppressBackfill: false })
  useUiStore.setState({ notificationsOpen: false })
  useNotificationStore.setState({ items: [], unreadCount: 0, activeAlerts: new Set() })
})

describe('MC 时钟纯函数', () => {
  it('dayCycle：昼夜边界 13000（与 worldTimePhase 对齐）+ 半段进度', () => {
    expect(dayCycle(0)).toEqual({ day: true, progress: 0 })
    expect(dayCycle(6000).day).toBe(true)
    expect(dayCycle(6000).progress).toBeCloseTo(6000 / 13000, 10)
    expect(dayCycle(12000).day).toBe(true) // 黄昏仍属白天弧
    expect(dayCycle(12000).progress).toBeCloseTo(12000 / 13000, 10)
    expect(dayCycle(13000)).toEqual({ day: false, progress: 0 }) // 夜晚起点与相位一致
    const night = dayCycle(20000)
    expect(night.day).toBe(false)
    expect(night.progress).toBeCloseTo(7000 / 11000, 10)
  })

  it('interpolateTick：运行中 20 tick/秒推进，停止时冻结', () => {
    expect(interpolateTick(6000, 10_000, 10_500, true)).toBe(6010)
    expect(interpolateTick(20000, 0, 100_000, true)).toBe((20000 + 2000) % 24000)
    expect(interpolateTick(6000, 10_000, 99_999, false)).toBe(6000)
  })
})

describe('McClockCard 世界控制', () => {
  it('渲染昼夜弧标尺、天气/时间 chips 与选中态（正午 + 晴天）', () => {
    renderWithProviders(<McClockCard />)
    expect(screen.getByText('第 42 天')).toBeInTheDocument()
    expect(screen.getByText(/6000 tick/)).toBeInTheDocument()
    expect(screen.getAllByText('正午').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: '晴天' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '雨天' })).toHaveAttribute('aria-pressed', 'false')
    const noon = screen.getAllByRole('button', { name: '正午' }).pop()!
    expect(noon).toHaveAttribute('aria-pressed', 'true')
  })

  it('点击雨天发送 weather rain 并回显终端（成功不弹 toast，终端为反馈源）', async () => {
    renderWithProviders(<McClockCard />)
    fireEvent.click(screen.getByRole('button', { name: '雨天' }))
    await waitFor(() =>
      expect(useTerminalStore.getState().buffer.some((e) => e.text === 'weather rain')).toBe(true),
    )
  })

  it('实例停止时控件禁用', () => {
    useServerStore.setState({ status: { ...mockInstanceStatus, isRunning: false, weather: null, worldTime: null } })
    renderWithProviders(<McClockCard />)
    expect(screen.getByRole('button', { name: '晴天' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '白天' })).toBeDisabled()
  })
})

describe('EventsCard 事件与待办', () => {
  const item = (id: string, read: boolean, content = `事件 ${id}`): AppNotification =>
    ({ id, type: 'join', category: 'game', content, timestamp: Date.now(), count: 1, read })

  it('未读角标 + 最新事件行；点「全部」开通知抽屉', () => {
    useNotificationStore.setState({
      items: [item('a', false, 'Steve 加入服务器'), item('b', true, 'Alex 加入服务器')],
      unreadCount: 1,
    })
    renderWithProviders(<EventsCard />)
    expect(screen.getByText('1 未读')).toBeInTheDocument()
    expect(screen.getByText('Steve 加入服务器')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '全部动态' }))
    expect(useUiStore.getState().notificationsOpen).toBe(true)
  })

  it('点击事件行标记已读并开抽屉', () => {
    useNotificationStore.setState({ items: [item('a', false, 'Steve 加入服务器')], unreadCount: 1 })
    renderWithProviders(<EventsCard />)
    fireEvent.click(screen.getByRole('button', { name: /Steve 加入服务器/ }))
    expect(useUiStore.getState().notificationsOpen).toBe(true)
    expect(useNotificationStore.getState().items[0]?.read).toBe(true)
  })

  it('空态显示「暂无动态」', () => {
    renderWithProviders(<EventsCard />)
    expect(screen.getByText('暂无动态')).toBeInTheDocument()
  })
})

describe('AnnouncementCard 公告发送', () => {
  it('模板填充 → Enter 发送 say 公告 → 清空输入并回显终端', async () => {
    renderWithProviders(<AnnouncementCard />)
    fireEvent.click(screen.getByRole('button', { name: /服务器将在 5 分钟后重启/ }))
    const input = screen.getByLabelText('公告内容')
    expect(input).toHaveValue('服务器将在 5 分钟后重启，请及时停靠')
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() =>
      expect(useTerminalStore.getState().buffer.some((e) => e.text.includes('say 服务器将在'))).toBe(true),
    )
    expect(input).toHaveValue('')
    expect(useTerminalStore.getState().buffer.some((e) => e.text.includes('say 服务器将在'))).toBe(true)
  })

  it('空输入不发命令', () => {
    renderWithProviders(<AnnouncementCard />)
    const input = screen.getByLabelText('公告内容')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.queryByText(/命令已发送/)).not.toBeInTheDocument()
    expect(useTerminalStore.getState().buffer.length).toBe(0)
  })
})
