/**
 * EmergencyPage 行为级补测（issue 433）
 * - 渲染：健康/卡顿/已停止 chip、TPS 大字、Stat 组、四主按钮、迷你终端
 * - 高危操作确认链路：停止/重启走 ConfirmDialog（确认与取消双分支），描述含在线玩家
 * - 直发操作：存档（save-all）无确认直发；玩家 Tab 踢出；控制台命令发送（含空命令防线）
 * - 错误态：状态查询失败（重试按钮 + refetch）、日志查询失败文案、操作失败 toast
 * 数据全部虚构（inst-1 / Steve / Alex / 1.2.3.4），hooks 桩不触网
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { EmergencyPage } from '../emergency-page'
import { useServerStore } from '@/stores/server'
import { useConnectionStore } from '@/stores/connection'
import { useUiStore } from '@/stores/ui'
import { ApiError } from '@/api/client'
import type { InstanceStatus } from '@/api/types'

// ── sonner toast 桩（不渲染 Toaster，直接断言调用；vi.hoisted 避免工厂引用 TDZ） ──
const { toastSuccess, toastError, statusRefetch, apiPostMock, apiGetMock } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  statusRefetch: vi.fn(),
  apiPostMock: vi.fn<(url: string, body?: unknown) => Promise<unknown>>(),
  apiGetMock: vi.fn<(url: string, ...rest: unknown[]) => Promise<unknown>>(),
}))
vi.mock('sonner', () => ({
  toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) },
}))

// ── queries hooks 桩：useInstances/useInstanceStatus 可控，queryKeys 保留真实实现 ──
let instancesData: unknown = undefined
let statusResult: {
  data?: InstanceStatus
  isError: boolean
  isLoading: boolean
  refetch: () => void
} = { isError: false, isLoading: false, refetch: statusRefetch }
vi.mock('@/api/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/queries')>()
  return {
    ...actual,
    useInstances: () => ({ data: instancesData, isLoading: false, isError: false }),
    useInstanceStatus: () => statusResult,
  }
})

// ── HTTP 层桩：apiPost 全记录；apiGet 可失败（logs 端点错误态） ──
vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>()
  return {
    ...actual,
    apiPost: (url: string, _config: unknown, body?: unknown) => apiPostMock(url, body),
    apiGet: (url: string, ...rest: unknown[]) => apiGetMock(url, ...rest),
  }
})

function makeStatus(over: Partial<InstanceStatus> = {}): InstanceStatus {
  return {
    id: 'inst-1',
    name: 'Survival',
    isRunning: true,
    isRconConnected: true,
    autoRestart: false,
    autoStart: false,
    circuitBreakerTripped: false,
    consecutiveCrashes: 0,
    uptime: 3600,
    address: '1.2.3.4:25565',
    players: [{ name: 'Steve' }, { name: 'Alex' }],
    playerCount: 2,
    maxPlayers: 20,
    mcVersion: '26.1',
    modLoader: 'vanilla',
    tps: 20,
    mspt: 12,
    cpuUsage: 12.5,
    memoryUsage: 2.1,
    totalMemory: 8,
    worldSize: null,
    seed: null,
    lastSave: null,
    lastOutput: null,
    gameMode: 'survival',
    difficulty: 'normal',
    whitelisted: false,
    onlineMode: true,
    viewDistance: 10,
    spawnProtection: 16,
    ...over,
  } as unknown as InstanceStatus
}

function setStatus(over: Partial<InstanceStatus> = {}) {
  statusResult = { data: makeStatus(over), isError: false, isLoading: false, refetch: statusRefetch }
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <EmergencyPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  instancesData = undefined
  setStatus()
  apiPostMock.mockResolvedValue(undefined)
  apiGetMock.mockResolvedValue([])
  useConnectionStore.setState({ baseUrl: '', apiKey: 'test-key', status: 'ready' })
  useServerStore.setState({ instanceId: 'inst-1', status: null, phase: {} })
  useUiStore.setState({ theme: 'dark' })
})

describe('EmergencyPage · 仪表 Tab 渲染', () => {
  it('统计未就绪（memoryUsage=0）时内存显示 —，不报「0 GB」', () => {
    setStatus({ memoryUsage: 0 })
    renderPage()
    // 与 TPS 同用 — 兜底：运行中却报 0 GB 会被读成「内存耗光」
    expect(screen.queryByText('0 GB')).not.toBeInTheDocument()
    expect(screen.getByText('内存').parentElement).toHaveTextContent('—')
  })

  it('健康态：TPS 大字 + 健康 chip + 在线/CPU/内存 Stat + 四主按钮', () => {
    renderPage()
    expect(screen.getByText('Survival')).toBeInTheDocument()
    expect(screen.getByText('健康')).toBeInTheDocument()
    expect(screen.getByText('20.0')).toBeInTheDocument()
    expect(screen.getByText('2/20')).toBeInTheDocument()
    expect(screen.getByText('12.5%')).toBeInTheDocument()
    expect(screen.getByText('2.1 GB')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重启' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '停止' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '存档' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '玩家操作' })).toBeInTheDocument()
    expect(screen.getByText('SERVER CONSOLE')).toBeInTheDocument()
  })

  it('卡顿态：tps<19 → chip「卡顿」（非健康）', () => {
    setStatus({ tps: 15.2 })
    renderPage()
    expect(screen.getByText('卡顿')).toBeInTheDocument()
    expect(screen.queryByText('健康')).not.toBeInTheDocument()
    expect(screen.getByText('15.2')).toBeInTheDocument()
  })

  it('已停止态：chip「已停止」+ 破坏性按钮禁用 + 终端空态提示', () => {
    setStatus({ isRunning: false, tps: 0, players: [], playerCount: 0 })
    renderPage()
    expect(screen.getByText('已停止')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重启' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '停止' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '存档' })).toBeDisabled()
    // 玩家操作入口不受运行态限制（仅切 Tab）
    expect(screen.getByRole('button', { name: '玩家操作' })).toBeEnabled()
    expect(screen.getByText('服务器已停止，启动后可查看日志')).toBeInTheDocument()
  })

  it('日志查询成功：终端行渲染（mini 终端与控制台 Tab 共用端点）', async () => {
    apiGetMock.mockResolvedValue([
      { text: '[Server] Starting...', type: 'info' },
      { text: '[Server] Done!', type: 'info' },
    ])
    renderPage()
    expect(await screen.findByText('[Server] Starting...')).toBeInTheDocument()
    expect(screen.getByText('[Server] Done!')).toBeInTheDocument()
    // 控制台 Tab 同源日志
    fireEvent.click(screen.getByRole('button', { name: '控制台' }))
    expect(screen.getByText('[Server] Starting...')).toBeInTheDocument()
  })

  it('状态查询失败：明确报错文案 + 重试按钮触发 refetch（不呈现假死「—」）', () => {
    statusResult = { data: undefined, isError: true, isLoading: false, refetch: statusRefetch }
    renderPage()
    expect(screen.getByText('服务器状态获取失败')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(statusRefetch).toHaveBeenCalledTimes(1)
  })

  it('日志查询失败：迷你终端明确报错文案', async () => {
    apiGetMock.mockRejectedValue(new ApiError(50000, 500, 'boom', null))
    renderPage()
    expect(await screen.findByText('日志获取失败，正在重试…')).toBeInTheDocument()
  })
})

describe('EmergencyPage · 高危操作确认链路', () => {
  it('停止-确认分支：弹窗描述含在线玩家名单，确认后发送 stop 并进入 busy', async () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    // 弹窗出现：标题 + 玩家名单描述（B8：显示在线玩家数）
    expect(screen.getByText('停止服务器')).toBeInTheDocument()
    expect(screen.getByText(/2 名玩家当前在线（Steve、Alex）/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '存档并停止' }))
    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalledWith('/api/v1/instances/inst-1/stop', undefined)
    })
    // 成功反馈 + 弹窗已关 + busy 复位（mock 立即 resolve，busy 瞬态后按钮恢复可用）
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('指令已发送'))
    await waitFor(() => expect(screen.getByRole('button', { name: '重启' })).toBeEnabled())
    expect(screen.queryByText('停止服务器')).not.toBeInTheDocument()
  })

  it('停止-取消分支：取消后不发送任何请求且弹窗关闭', () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    expect(screen.getByText('停止服务器')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(apiPostMock).not.toHaveBeenCalled()
    expect(screen.queryByText('停止服务器')).not.toBeInTheDocument()
  })

  it('停止-无玩家时描述为通用文案（不出现玩家数）', () => {
    setStatus({ players: [], playerCount: 0 })
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    expect(screen.getByText('确定要停止服务器吗？')).toBeInTheDocument()
  })

  it('重启-确认分支：弹窗标题「重启服务器」，确认后发送 restart', async () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: '重启' }))
    expect(screen.getByText('重启服务器')).toBeInTheDocument()
    expect(screen.getByText(/2 名玩家当前在线，重启期间他们将断开连接/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '存档并重启' }))
    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalledWith('/api/v1/instances/inst-1/restart', undefined)
    })
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('指令已发送'))
  })

  it('重启-取消分支：取消后不发送', () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: '重启' }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(apiPostMock).not.toHaveBeenCalled()
  })

  it('存档：高频动作不设确认，直接发送 save-all 指令 + 专属成功文案', async () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: '存档' }))
    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalledWith('/api/v1/instances/inst-1/command', { command: 'save-all' })
    })
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('存档指令已发送'))
  })

  it('操作失败：ApiError → toast.error 走友好文案通道', async () => {
    apiPostMock.mockRejectedValue(new ApiError(50000, 500, 'server exploded', null))
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: '存档' }))
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1))
    // 失败后 busy 复位，按钮恢复可用
    await waitFor(() => expect(screen.getByRole('button', { name: '存档' })).toBeEnabled())
  })
})

describe('EmergencyPage · 玩家 Tab', () => {
  it('「玩家操作」主按钮直达玩家 Tab（与底部导航等价）', () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: '玩家操作' }))
    expect(screen.getByText('Steve')).toBeInTheDocument()
  })

  it('在线玩家列表渲染 + 踢出直发（无确认）', async () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: '玩家' }))
    expect(screen.getByText('Steve')).toBeInTheDocument()
    expect(screen.getByText('Alex')).toBeInTheDocument()
    // 踢出 Steve：行渲染顺序随 players 数组，首行即 Steve
    const kickBtns = screen.getAllByRole('button', { name: '踢出' })
    expect(kickBtns).toHaveLength(2)
    fireEvent.click(kickBtns[0]!)
    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalledWith('/api/v1/instances/inst-1/players/Steve/kick', {
        reason: '管理员通过紧急视图踢出',
      })
    })
  })

  it('空态：运行中但无玩家 → 「当前没有在线玩家」', () => {
    setStatus({ players: [], playerCount: 0 })
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: '玩家' }))
    expect(screen.getByText('当前没有在线玩家')).toBeInTheDocument()
  })
})

describe('EmergencyPage · 控制台 Tab', () => {
  it('命令输入 + 发送：POST command + 成功 toast 回显 + 输入清空', async () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: '控制台' }))
    const input = screen.getByLabelText('终端命令输入')
    fireEvent.change(input, { target: { value: 'list' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalledWith('/api/v1/instances/inst-1/command', { command: 'list' })
    })
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('已执行：list'))
    expect(input).toHaveValue('')
  })

  it('Enter 键发送（键盘路径）', async () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: '控制台' }))
    const input = screen.getByLabelText('终端命令输入')
    fireEvent.change(input, { target: { value: 'time set day' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalledWith('/api/v1/instances/inst-1/command', { command: 'time set day' })
    })
  })

  it('空命令（trim 后为空）不发送', () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: '控制台' }))
    const input = screen.getByLabelText('终端命令输入')
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(apiPostMock).not.toHaveBeenCalled()
  })

  it('命令发送失败 → toast.error 兜底', async () => {
    apiPostMock.mockRejectedValue(new ApiError(40401, 404, 'gone', null))
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: '控制台' }))
    const input = screen.getByLabelText('终端命令输入')
    fireEvent.change(input, { target: { value: 'stop' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1))
  })
})

describe('EmergencyPage · 更多 Tab 与导航', () => {
  it('主题切换：toggleTheme 生效（dark → light）', () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    fireEvent.click(screen.getByRole('button', { name: '切换到亮色主题' }))
    expect(useUiStore.getState().theme).toBe('light')
  })

  it('完整设置入口为 Link 语义（href=/settings）', () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    expect(screen.getByRole('link', { name: '打开完整设置' })).toHaveAttribute('href', '/settings')
  })

  it('底部导航 aria-current 随切换更新', () => {
    renderPage()
    const playersTab = screen.getByRole('button', { name: '玩家' })
    expect(playersTab).not.toHaveAttribute('aria-current')
    fireEvent.click(playersTab)
    expect(playersTab).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: '仪表' })).not.toHaveAttribute('aria-current')
  })

  it('顶栏返回主面板链接（href=/dashboard）', () => {
    renderPage()
    expect(screen.getByRole('link', { name: '返回主面板' })).toHaveAttribute('href', '/dashboard')
  })
})
