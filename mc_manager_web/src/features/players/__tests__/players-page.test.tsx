/**
 * 玩家页集成测试：表格渲染/筛选/行点击详情/批量选择/深链接
 * MSW 拦截（mockPlayers 结构占位数据，无真实服务器信息）
 */
import { describe, it, expect, beforeEach, afterAll, beforeAll } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setupServer } from 'msw/node'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { Toaster } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { handlers } from '@/test/mocks/handlers'
import { PlayersPage } from '../players-page'
import { usePlayersUiStore } from '../store'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'

const server = setupServer(...handlers)
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())

function renderPage(initialPath = '/players') {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const router = createMemoryRouter(
    [
      {
        path: '/players',
        element: (
          <QueryClientProvider client={qc}>
            <TooltipProvider>
              <PlayersPage />
              <Toaster />
            </TooltipProvider>
          </QueryClientProvider>
        ),
      },
    ],
    { initialEntries: [initialPath] },
  )
  return render(<RouterProvider router={router} />)
}

beforeEach(() => {
  localStorage.clear()
  usePlayersUiStore.setState({ selectedUuids: [], filter: { q: '', mode: 'all', gameMode: '', dimension: '' }, detail: null })
  useConnectionStore.setState({ baseUrl: '', apiKey: 'test-key', status: 'ready' })
  useServerStore.setState({
    status: null,
    systemStats: null,
    instanceId: 'demo',
    socketConnected: true,
    lastStatusEvent: null,
  })
})

describe('PlayersPage', () => {
  it('渲染玩家表格（在线/离线/封禁/假人）', async () => {
    renderPage()
    expect(await screen.findByText('Steve')).toBeInTheDocument()
    // 默认排序：在线优先（Steve/Alex/Bot_farm1 在线 → Bob/Charlie 离线）
    expect(screen.getByText('Charlie')).toBeInTheDocument()
    expect(screen.getByText('Bot_farm1')).toBeInTheDocument()
    // 封禁徽章
    expect(screen.getByText(/封禁·剩/)).toBeInTheDocument()
    // 离线玩家显示「离线」
    expect(screen.getAllByText('离线').length).toBeGreaterThan(0)
  })

  it('搜索筛选：输入名字过滤', async () => {
    renderPage()
    await screen.findByText('Steve')
    const search = screen.getByPlaceholderText('搜索玩家名或 UUID…')
    fireEvent.change(search, { target: { value: 'charlie' } })
    expect(screen.getByText('Charlie')).toBeInTheDocument()
    expect(screen.queryByText('Steve')).not.toBeInTheDocument()
    // 计数更新
    expect(screen.getByText('1 / 5 名玩家')).toBeInTheDocument()
    // 清空搜索按钮恢复全量
    fireEvent.click(screen.getByRole('button', { name: '清空搜索' }))
    expect(screen.getByText('Steve')).toBeInTheDocument()
  })

  it('无匹配时显示「没有匹配的玩家」', async () => {
    renderPage()
    await screen.findByText('Steve')
    fireEvent.change(screen.getByPlaceholderText('搜索玩家名或 UUID…'), { target: { value: 'zzz-not-exist' } })
    expect(await screen.findByText('没有匹配的玩家')).toBeInTheDocument()
  })

  it('点击行打开详情面板（概览 Tab：操作按钮组与基本信息）', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('Steve')
    await user.click(screen.getByText('Steve').closest('tr')!)
    // 详情面板出现（概览操作组；Steve 为 OP → 显示「取消OP」）
    expect(await screen.findByRole('button', { name: /取消OP|设为OP/ })).toBeInTheDocument()
    expect(screen.getByText('基本信息')).toBeInTheDocument()
    // 关闭按钮
    fireEvent.click(screen.getByRole('button', { name: '关闭详情面板' }))
    expect(screen.queryByText('基本信息')).not.toBeInTheDocument()
  })

  it('键盘 Enter/Space 打开行详情（无障碍键盘路径）', async () => {
    renderPage()
    await screen.findByText('Steve')
    const row = screen.getByText('Steve').closest('tr')!
    row.focus()
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(await screen.findByRole('button', { name: /取消OP|设为OP/ })).toBeInTheDocument()
  })

  it('行内溢出菜单：封禁入口打开封禁对话框', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('Steve')
    const row = screen.getByText('Steve').closest('tr')!
    await user.click(within(row).getByRole('button', { name: /Steve 操作菜单/ }))
    await user.click(await screen.findByText('封禁…'))
    expect(await screen.findByText('封禁 Steve')).toBeInTheDocument()
    // 时长档 6 项与理由 9 项渲染
    expect(screen.getByRole('button', { name: '1小时' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '永久' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '作弊' })).toBeInTheDocument()
  })

  it('批量选择出现底部操作条（9 动作）', async () => {
    renderPage()
    await screen.findByText('Steve')
    // 勾选两行（Steve + Alex）
    const steveRow = screen.getByText('Steve').closest('tr')!
    const alexRow = screen.getByText('Alex').closest('tr')!
    fireEvent.click(within(steveRow).getByRole('checkbox'))
    fireEvent.click(within(alexRow).getByRole('checkbox'))
    // 批量操作条：已选择 2 名玩家 + 9 动作
    expect(await screen.findByText('已选择 2 名玩家')).toBeInTheDocument()
    for (const label of ['传送', '给予物品', '白名单', '移除白名单', 'OP', '取消OP', '清空背包', '踢出']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
  })

  it('深链接 ?player=Steve 打开详情', async () => {
    renderPage('/players?player=Steve')
    expect(await screen.findByText('基本信息')).toBeInTheDocument()
  })

  it('封禁记录弹窗：全量列表 + 解封确认', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('Steve')
    // 筛选栏入口打开弹窗
    await user.click(screen.getByRole('button', { name: '封禁记录' }))
    const dialog = await screen.findByRole('dialog')
    // 列表：Charlie（生效中剩 12 小时）+ Ghost（已解除）
    expect(await within(dialog).findByText('Charlie')).toBeInTheDocument()
    expect(within(dialog).getByText('Ghost')).toBeInTheDocument()
    expect(within(dialog).getByText('已解封')).toBeInTheDocument()
    expect(within(dialog).getByText(/剩\d+小时/)).toBeInTheDocument()
    // 仅生效中记录显示解封按钮
    expect(within(dialog).getAllByRole('button', { name: '解封' })).toHaveLength(1)
    // 解封确认 → 执行 → 成功 toast
    await user.click(within(dialog).getByRole('button', { name: '解封' }))
    expect(await screen.findByText('确定要解封 Charlie 吗？解封后对方可重新连接。')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '确认解封' }))
    expect(await screen.findByText('已解封 Charlie')).toBeInTheDocument()
    // 关闭弹窗（footer 按钮，X 按钮 sr-only 同名需排除）
    const closeButtons = within(dialog).getAllByRole('button', { name: '关闭' })
    await user.click(closeButtons[closeButtons.length - 1]!)
    expect(screen.queryByRole('heading', { name: '封禁记录' })).not.toBeInTheDocument()
  })
})
