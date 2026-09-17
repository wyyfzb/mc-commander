/**
 * PropertiesPanel 测试：渲染/敏感键锁定/编辑流程（快照-取消-保存）/restartRequired toast/搜索分类过滤
 * mock 属性为虚构占位值，无真实服务器数据
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Toaster, toast as sonnerToast } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { PropertiesPanel } from '../properties-panel'

// 虚构属性（结构与 mock-server/MSW 同步；敏感键掩码）
const mockProps: Record<string, string> = {
  difficulty: 'normal',
  gamemode: 'survival',
  'white-list': 'false',
  pvp: 'true',
  motd: 'Welcome',
  'max-players': '20',
  'view-distance': '10',
  'rcon.password': '********',
  'enable-rcon': '********',
  'server-port': '********',
  'custom-unknown-key': 'true',
}

function renderPanel(onSave = vi.fn().mockResolvedValue([])) {
  render(
    <TooltipProvider>
      <PropertiesPanel properties={mockProps} isLoading={false} onSave={onSave} />
      <Toaster />
    </TooltipProvider>,
  )
}

beforeEach(() => {
  sonnerToast.dismiss()
})

describe('PropertiesPanel 渲染', () => {
  it('渲染属性行：键名 + 分类默认全部 + 敏感键锁定', () => {
    renderPanel()
    expect(screen.getByText('difficulty')).toBeInTheDocument()
    expect(screen.getByText('max-players')).toBeInTheDocument()
    // 敏感键显示占位符 + 锁定图标
    const locks = screen.getAllByLabelText('敏感属性')
    expect(locks.length).toBe(3)
    expect(screen.getAllByText('********').length).toBe(3)
    // 未知属性自动追加
    expect(screen.getByText('custom-unknown-key')).toBeInTheDocument()
  })

  it('生效方式：常态由面板说明行承担，只给热改例外逐项挂标（默认只读态即如此）', () => {
    const { container } = render(
      <TooltipProvider>
        <PropertiesPanel properties={mockProps} isLoading={false} onSave={vi.fn()} />
        <Toaster />
      </TooltipProvider>,
    )
    const row = (name: string) => container.querySelector(`[data-prop="${name}"]`) as HTMLElement

    // 例外：热改 4 键（difficulty 是其一）逐项挂「即时生效」
    expect(within(row('difficulty')).getByText('即时生效')).toBeInTheDocument()
    // 常态：可写但非热改的项不逐项挂标（320px 下会把键名挤到 2 字可见），由说明行统一讲清
    expect(within(row('max-players')).queryByText('重启生效')).not.toBeInTheDocument()
    expect(screen.getByText(/除标记「即时生效」的属性外，其余可写属性改动后需重启实例生效/)).toBeInTheDocument()
    // 不可写/未知键改不动，谈不上生效方式，也不该挂例外标
    expect(within(row('custom-unknown-key')).queryByText('即时生效')).not.toBeInTheDocument()
  })

  it('分类筛选 + 搜索过滤', async () => {
    const user = userEvent.setup()
    renderPanel()
    await user.click(screen.getByRole('button', { name: '游戏玩法' }))
    expect(screen.getByText('difficulty')).toBeInTheDocument()
    expect(screen.queryByText('view-distance')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '全部' }))
    await user.type(screen.getByLabelText('搜索属性'), 'motd')
    expect(screen.getByText('motd')).toBeInTheDocument()
    expect(screen.queryByText('pvp')).not.toBeInTheDocument()
  })

  it('加载态渲染骨架块', () => {
    render(
      <TooltipProvider>
        <PropertiesPanel properties={undefined} isLoading onSave={vi.fn()} />
      </TooltipProvider>,
    )
    expect(screen.queryByText('difficulty')).not.toBeInTheDocument()
  })
})

describe('PropertiesPanel 编辑流程', () => {
  it('编辑 → 修改 → 保存（payload 含 bool 规范化 + 敏感键占位符）→ 成功 toast', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn().mockResolvedValue([])
    renderPanel(onSave)
    await user.click(screen.getByRole('button', { name: '编辑' }))
    expect(screen.getByText(/编辑模式已开启/)).toBeInTheDocument()
    // 修改 bool 开关
    await user.click(screen.getByLabelText('PvP 开关'))
    // 修改输入值
    const motdInput = screen.getByLabelText('MOTD 输入')
    await user.clear(motdInput)
    await user.type(motdInput, 'Hello MC')
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const payload = onSave.mock.calls[0]![0] as Record<string, string>
    expect(payload['pvp']).toBe('false')
    expect(payload['motd']).toBe('Hello MC')
    // 敏感键恒回传占位符
    expect(payload['rcon.password']).toBe('********')
    expect(await screen.findByText('规则已保存到服务器')).toBeInTheDocument()
  })

  it('restartRequired 非空：简化 toast + Dialog 清单展示', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn().mockResolvedValue(['pvp', 'motd', 'max-players'])
    renderPanel(onSave)
    await user.click(screen.getByRole('button', { name: '编辑' }))
    await user.click(screen.getByRole('button', { name: '保存' }))
    // 简化 toast
    expect(await screen.findByText(/已保存.*3 项需重启/)).toBeInTheDocument()
    // Dialog 展示需重启项清单（旧值 → 新值）
    expect(screen.getByText('以下属性需重启后生效')).toBeInTheDocument()
    expect(screen.getByText('PvP')).toBeInTheDocument()
    expect(screen.getByText('MOTD')).toBeInTheDocument()
    expect(screen.getByText('最大玩家数')).toBeInTheDocument()
    // 复制按钮
    expect(screen.getByRole('button', { name: '复制清单' })).toBeInTheDocument()
    // 未运行时不显示重启按钮（isRunning 默认 false）
    expect(screen.queryByRole('button', { name: '立即重启' })).not.toBeInTheDocument()
  })

  it('取消恢复快照：修改后取消 → 再进编辑显示原值', async () => {
    const user = userEvent.setup()
    renderPanel()
    await user.click(screen.getByRole('button', { name: '编辑' }))
    await user.click(screen.getByLabelText('PvP 开关'))
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByText(/编辑模式已开启/)).not.toBeInTheDocument()
    // 重新进入编辑：pvp 恢复 true（快照）
    await user.click(screen.getByRole('button', { name: '编辑' }))
    expect(screen.getByLabelText('PvP 开关')).toHaveAttribute('data-state', 'checked')
  })

  it('保存失败：错误 toast + 保持编辑态', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn().mockRejectedValue(new Error('boom'))
    renderPanel(onSave)
    await user.click(screen.getByRole('button', { name: '编辑' }))
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText(/保存失败/)).toBeInTheDocument()
    expect(screen.getByText(/编辑模式已开启/)).toBeInTheDocument()
  })
})
