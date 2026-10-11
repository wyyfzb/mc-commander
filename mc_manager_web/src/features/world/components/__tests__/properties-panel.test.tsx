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
  difficulty: 'easy',
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

  it('生效方式：常态说明收进面板头部信息入口，只给热改例外逐项挂标（默认只读态即如此）', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <TooltipProvider>
        <PropertiesPanel properties={mockProps} isLoading={false} onSave={vi.fn()} />
        <Toaster />
      </TooltipProvider>,
    )
    const row = (name: string) => container.querySelector(`[data-prop="${name}"]`) as HTMLElement

    // 例外：热改 4 键（difficulty 是其一）逐项挂「即时生效」
    expect(within(row('difficulty')).getByText('即时生效')).toBeInTheDocument()
    // 常态：可写但非热改的项不逐项挂标（320px 下会把键名挤到 2 字可见），由信息入口统一讲清
    expect(within(row('max-players')).queryByText('重启生效')).not.toBeInTheDocument()
    // 正文不常驻，点开入口才读到全文
    expect(
      screen.queryByText(/除标记「即时生效」的属性外，其余可写属性改动后需重启实例生效/),
    ).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '生效方式说明' }))
    expect(await screen.findByRole('dialog', { name: '生效方式说明' })).toHaveTextContent(
      '除标记「即时生效」的属性外，其余可写属性改动后需重启实例生效',
    )
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
  it('编辑 → 修改 → 保存（payload 只含改动键 + bool 规范化）→ 成功 toast', async () => {
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
    // 载荷只含改动键：未改动的敏感键（占位符）与面板管不到的键都不回传——
    // 整份回传会把后者送进服务端逐键白名单校验，导致整批 400
    expect(Object.keys(payload).sort()).toEqual(['motd', 'pvp'])
    expect(payload['rcon.password']).toBeUndefined()
    expect(payload['white-list']).toBeUndefined()
    expect(payload['custom-unknown-key']).toBeUndefined()
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

/**
 * 服务端在新版本不再读取的键（本例：pvp 在 1.21.9 起由游戏规则接管、spawn-npcs 更早被移除）：
 * 面板必须锁死并说明去向，否则用户改完不生效却被告知「重启后生效」。
 * 版本未知时不许替服务器下结论——与顶栏刷新语义同一取舍。
 */
describe('已迁出的属性键按实例版本锁定', () => {
  const renderWithVersion = (mcVersion: string | undefined, props = mockProps) => {
    const { container } = render(
      <TooltipProvider>
        <PropertiesPanel
          properties={props}
          isLoading={false}
          onSave={vi.fn()}
          mcVersion={mcVersion}
        />
        <Toaster />
      </TooltipProvider>,
    )
    return container
  }
  const row = (container: HTMLElement, name: string) =>
    container.querySelector(`[data-prop="${name}"]`) as HTMLElement
  const hintName = '本版本服务端已不再读取此项'

  it('26.3：已迁出键在编辑态下仍锁死并说明改由哪条游戏规则接管；其余键不受影响', async () => {
    const user = userEvent.setup()
    const container = renderWithVersion('26.3')
    await user.click(screen.getByRole('button', { name: '编辑' }))
    // 编辑态才分得清「因为不能再改」与「因为还没进编辑」——未失效键此时可用
    expect(within(row(container, 'pvp')).getByRole('switch')).toBeDisabled()
    expect(within(row(container, 'max-players')).getByRole('textbox')).toBeEnabled()
    expect(
      within(row(container, 'max-players')).queryByRole('button', { name: hintName }),
    ).toBeNull()
    await user.click(within(row(container, 'pvp')).getByRole('button', { name: hintName }))
    expect(await screen.findByRole('dialog', { name: hintName })).toHaveTextContent(
      '1.21.9 起服务端不再读取 server.properties 里的这一项，改由游戏规则 pvp 控制',
    )
  })

  it('1.21.8：该版本服务端仍读取此键 ⇒ 保持可改，且不挂解释入口', async () => {
    const user = userEvent.setup()
    const container = renderWithVersion('1.21.8')
    await user.click(screen.getByRole('button', { name: '编辑' }))
    expect(within(row(container, 'pvp')).getByRole('switch')).toBeEnabled()
    expect(within(row(container, 'pvp')).queryByRole('button', { name: hintName })).toBeNull()
  })

  it.each([
    ['未传', undefined],
    ['空串', ''],
  ])('版本%s：不下结论——既不锁死也不挂解释', async (_label, mcVersion) => {
    const user = userEvent.setup()
    const container = renderWithVersion(mcVersion)
    await user.click(screen.getByRole('button', { name: '编辑' }))
    expect(within(row(container, 'pvp')).getByRole('switch')).toBeEnabled()
    expect(within(row(container, 'pvp')).queryByRole('button', { name: hintName })).toBeNull()
  })

  it.each([
    ['1.21.10', 'allow-nether', 'allowEnteringNetherUsingPortals'],
    ['1.21.10', 'enable-command-block', 'commandBlocksEnabled'],
    ['1.21.10', 'spawn-monsters', 'spawnMonsters'],
    ['26.3', 'allow-nether', 'allow_entering_nether_using_portals'],
    ['26.3', 'enable-command-block', 'command_blocks_work'],
    ['26.3', 'spawn-monsters', 'spawn_monsters'],
  ])('%s：%s 的接替规则点名 %s（名字与该版本规则表同源）', async (version, key, ruleName) => {
    const user = userEvent.setup()
    // 1.21.9/1.21.10 正是这几个键首次被弃用的版本，而那时规则名还是 camelCase——
    // 提示若写死新名，就会对这两个版本点名一条不存在的规则
    const container = renderWithVersion(version, { [key]: 'false' })
    await user.click(within(row(container, key)).getByRole('button', { name: hintName }))
    expect(await screen.findByRole('dialog', { name: hintName })).toHaveTextContent(
      `改由游戏规则 ${ruleName} 控制`,
    )
  })

  it('状态迟到：编辑之后才知道该键已迁出 ⇒ 保存也不下发它', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn().mockResolvedValue([])
    const { container, rerender } = render(
      <TooltipProvider>
        <PropertiesPanel properties={mockProps} isLoading={false} onSave={onSave} />
        <Toaster />
      </TooltipProvider>,
    )
    await user.click(screen.getByRole('button', { name: '编辑' }))
    await user.click(within(row(container, 'pvp')).getByRole('switch'))
    // 实例状态此刻才返回 ⇒ 该行转为锁定；但改动已经在编辑态里了
    rerender(
      <TooltipProvider>
        <PropertiesPanel
          properties={mockProps}
          isLoading={false}
          onSave={onSave}
          mcVersion="26.3"
        />
        <Toaster />
      </TooltipProvider>,
    )
    expect(within(row(container, 'pvp')).getByRole('switch')).toBeDisabled()
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    // 下发只会拿到 200 而服务器根本不读 ⇒ 必须滤掉（pvp 确实改过，不滤就会在里面）
    expect(onSave.mock.calls[0][0]).not.toHaveProperty('pvp')
  })

  it('无接替规则的键：说明它被移除且没有替代项', async () => {
    const user = userEvent.setup()
    const container = renderWithVersion('26.3', { 'spawn-npcs': 'true' })
    await user.click(within(row(container, 'spawn-npcs')).getByRole('button', { name: hintName }))
    expect(await screen.findByRole('dialog', { name: hintName })).toHaveTextContent(
      '1.21.2 起服务端已移除这一项，且没有接替它的游戏规则',
    )
  })
})
