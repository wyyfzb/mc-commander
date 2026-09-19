import type { ReactNode } from 'react'
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setupServer } from 'msw/node'
import { Toaster } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { handlers } from '@/test/mocks/handlers'
import { McClockCard, dayCycle, interpolateTick } from '../components/mc-clock-card'
import { AnnouncementCard } from '../components/announcement-card'
import { useServerStore } from '@/stores/server'
import { useConnectionStore } from '@/stores/connection'
import { useTerminalStore } from '@/stores/terminal'
import { useUiStore } from '@/stores/ui'
import { useNotificationStore } from '@/stores/notifications'
import { mockInstanceStatus } from '@/test/mocks/handlers'

/**
 * 驾驶舱右栏三卡组件测试：MC 时钟（纯函数 + 联动发送）/ 事件与待办（抽屉深链）/ 公告发送
 */

const server = setupServer(...handlers)
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())
// 用例中途断言失败时体内的还原语句不会执行，间谍会残留给后续用例（如平台 spy 让
// 后面的 placeholder 断言读到 ⌘）——集中在此还原，失败不放大成无关用例连带红
afterEach(() => vi.restoreAllMocks())

function renderWithProviders(ui: ReactNode) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        {ui}
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  localStorage.clear()
  // 占位凭据动态生成（mimosa 硬编码凭据规则对 apiKey 字面量告警，测试值虽虚构仍按源消除）
  useConnectionStore.setState({ baseUrl: '', apiKey: `test-key-${crypto.randomUUID()}`, status: 'ready' })
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
    expect(screen.getByRole('radio', { name: '晴天' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: '雨天' })).toHaveAttribute('aria-checked', 'false')
    const noon = screen.getAllByRole('radio', { name: '正午' }).pop()!
    expect(noon).toHaveAttribute('aria-checked', 'true')
  })

  it('点击雨天发送 weather rain 并回显终端（成功不弹 toast，终端为反馈源）', async () => {
    renderWithProviders(<McClockCard />)
    fireEvent.click(screen.getByRole('radio', { name: '雨天' }))
    await waitFor(() =>
      expect(useTerminalStore.getState().buffer.some((e) => e.text === 'weather rain')).toBe(true),
    )
  })

  it('实例停止时控件禁用', () => {
    useServerStore.setState({ status: { ...mockInstanceStatus, isRunning: false, weather: null, worldTime: null } })
    renderWithProviders(<McClockCard />)
    expect(screen.getByRole('radio', { name: '晴天' })).toBeDisabled()
    expect(screen.getByRole('radio', { name: '白天' })).toBeDisabled()
  })
})

describe('AnnouncementCard 公告发送', () => {
  it('预设胶囊填充 → Ctrl+Enter → 确认弹窗确认 → 发送 say 公告 → 清空输入并回显终端', async () => {
    renderWithProviders(<AnnouncementCard />)
    fireEvent.click(screen.getByRole('button', { name: '重启预告' }))
    const input = screen.getByLabelText('公告内容')
    expect(input).toHaveValue('服务器将在 5 分钟后重启，请及时停靠')
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
    // 二次确认：确认前不发送
    expect(useTerminalStore.getState().buffer.some((e) => e.text.includes('say 服务器将在'))).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: /^发送$/ }))
    await waitFor(() =>
      expect(useTerminalStore.getState().buffer.some((e) => e.text.includes('say 服务器将在'))).toBe(true),
    )
    expect(input).toHaveValue('')
    expect(useTerminalStore.getState().buffer.some((e) => e.text.includes('say 服务器将在'))).toBe(true)
  })

  it('预设管理：添加 → 胶囊与持久化；删除 → 胶囊消失', () => {
    renderWithProviders(<AnnouncementCard />)
    // 添加预设（名称+文案）
    fireEvent.click(screen.getByRole('button', { name: '添加预设' }))
    fireEvent.change(screen.getByLabelText('预设名'), { target: { value: '活动预告' } })
    fireEvent.change(screen.getByLabelText('公告文案'), { target: { value: '周末活动即将开始' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(screen.getByRole('button', { name: '活动预告' })).toBeInTheDocument()
    const stored = JSON.parse(localStorage.getItem('mcs-announcement-presets') ?? '[]') as { name: string }[]
    expect(stored.some((p) => p.name === '活动预告')).toBe(true)
    // 删除预设：经二次确认
    fireEvent.click(screen.getByRole('button', { name: '删除预设 活动预告' }))
    fireEvent.click(screen.getByRole('button', { name: /^删除$/ }))
    expect(screen.queryByRole('button', { name: '活动预告' })).not.toBeInTheDocument()
  })

  it('确认弹窗取消：不发送命令', () => {
    renderWithProviders(<AnnouncementCard />)
    fireEvent.click(screen.getByRole('button', { name: '重启预告' }))
    const input = screen.getByLabelText('公告内容')
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
    fireEvent.click(screen.getByRole('button', { name: /^取消$/ }))
    expect(useTerminalStore.getState().buffer.length).toBe(0)
    expect(input).toHaveValue('服务器将在 5 分钟后重启，请及时停靠')
  })

  it('公告框 placeholder 的发送快捷键按平台取词（macOS 是 ⌘，其余是 Ctrl）', () => {
    const { unmount } = renderWithProviders(<AnnouncementCard />)
    // jsdom 平台为 Linux：提示须与 handler 接受的修饰键（ctrl||meta）一致
    expect(screen.getByLabelText('公告内容')).toHaveAttribute(
      'placeholder',
      '输入公告内容…（Ctrl+Enter 发送，支持多行）',
    )

    unmount()
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
    renderWithProviders(<AnnouncementCard />)
    expect(screen.getByLabelText('公告内容')).toHaveAttribute(
      'placeholder',
      '输入公告内容…（⌘+Enter 发送，支持多行）',
    )
  })

  it('空输入不发命令', () => {
    renderWithProviders(<AnnouncementCard />)
    const input = screen.getByLabelText('公告内容')
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
    expect(screen.queryByText(/命令已发送/)).not.toBeInTheDocument()
    expect(useTerminalStore.getState().buffer.length).toBe(0)
  })

  it('天气/时间 chip 是单选组：方向键移动即选中且焦点跟随', () => {
    renderWithProviders(<McClockCard />)
    const weatherGroup = screen.getByRole('radiogroup', { name: '天气' })
    const weathers = within(weatherGroup).getAllByRole('radio')
    expect(weathers[0]).toHaveAttribute('aria-checked', 'true') // mock 天气为 clear

    fireEvent.keyDown(weatherGroup, { key: 'ArrowRight' })
    expect(weathers[1]).toHaveAttribute('aria-checked', 'true')
    expect(document.activeElement).toBe(weathers[1])

    const timeGroup = screen.getByRole('radiogroup', { name: '时间' })
    const times = within(timeGroup).getAllByRole('radio')
    // 选中项由 mock 的世界时间决定（可能是任一档），故按当前选中项推算目标
    const checked = times.findIndex((el) => el.getAttribute('aria-checked') === 'true')
    const from = checked >= 0 ? checked : 0
    fireEvent.keyDown(timeGroup, { key: 'ArrowLeft' })
    expect(times[(from - 1 + times.length) % times.length]).toHaveAttribute('aria-checked', 'true')
  })

})
