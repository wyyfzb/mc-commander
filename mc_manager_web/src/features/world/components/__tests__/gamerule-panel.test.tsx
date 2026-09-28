/**
 * GamerulePanel 测试（世界页「游戏规则」面板）：
 * 挂载自动查询/列表渲染/行级编辑（保存-取消 Tasteful Friction）/解析失败降级/搜索+分类/RCON 未连接
 * 说明：parseGameruleOutput 有 1/3 降级阈值（解析不足 defs 1/3 → null），
 * 查询响应 mock 必须覆盖 defs 1/3 以上的规则（与 MSW command 端点 mock 的
 * keepInventory/randomTickSpeed/doDaylightCycle/mobGriefing 同源值），否则按「解析失败」走降级态
 * （该态由独立用例覆盖）。mock 数据全部为虚构占位（规则名/值来自公开 Wiki 数据，无真实服务器信息）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Toaster, toast as sonnerToast } from 'sonner'
import { GamerulePanel } from '../gamerule-panel'
import { LEGACY_GAMERULES, MINECRAFT_GAMERULES } from '@/lib/mc-gamerules'

/** 旧集全量查询响应（含 MSW 端点同源 4 条：keepInventory=false/randomTickSpeed=3/doDaylightCycle=true/mobGriefing=true） */
function legacyOutput(): string {
  return LEGACY_GAMERULES.map((d) => `${d.name} = ${String(d.defaultValue)}`).join('\n')
}

/** 新集全量查询响应 */
function newOutput(): string {
  return MINECRAFT_GAMERULES.map((d) => `${d.name} = ${String(d.defaultValue)}`).join('\n')
}

/** onSendCommand 契约（与组件 Props 一致） */
type SendCommand = (command: string) => Promise<string | null>

interface RenderOptions {
  mcVersion?: string
  isRconConnected?: boolean
  onSendCommand?: SendCommand
}

function renderPanel(opts: RenderOptions = {}) {
  const onSendCommand = opts.onSendCommand ?? vi.fn<SendCommand>().mockResolvedValue(legacyOutput())
  render(
    <>
      <GamerulePanel
        instanceId="demo"
        mcVersion={opts.mcVersion ?? '1.20.5'}
        isRconConnected={opts.isRconConnected ?? true}
        onSendCommand={onSendCommand}
      />
      <Toaster />
    </>,
  )
  return { onSendCommand }
}

beforeEach(() => {
  // sonner toast 存于模块级 store，跨测试残留会导致同文案 toast 重复匹配
  sonnerToast.dismiss()
})

// ── 挂载自动查询与列表渲染 ─────────────────────────────────────────

describe('GamerulePanel 挂载查询与列表', () => {
  it('挂载自动查询（gamerule 无参）→ 渲染旧集列表 + 旧版规则徽章 + 仅「全部/其他」分类', async () => {
    const { onSendCommand } = renderPanel()
    expect(await screen.findByText('keepInventory')).toBeInTheDocument()
    expect(screen.getByText('randomTickSpeed')).toBeInTheDocument()
    expect(screen.getByText('doDaylightCycle')).toBeInTheDocument()
    expect(screen.getByText('mobGriefing')).toBeInTheDocument()
    // 无参查询一次（GAMERULE_QUERY_COMMAND）
    expect(onSendCommand).toHaveBeenCalledTimes(1)
    expect(onSendCommand).toHaveBeenCalledWith('gamerule')
    // 版本徽章：1.20.5 → 旧版规则
    expect(screen.getByText('旧版规则')).toBeInTheDocument()
    // 解析成功 → 无 warning 提示
    expect(screen.queryByText(/无法解析 gamerule 列表/)).not.toBeInTheDocument()
    // 生效方式标识（与属性面板同一口径）：gamerule 全部即时生效
    expect(screen.getByText('规则修改保存后即时生效，无需重启实例')).toBeInTheDocument()
    // 旧集分类全部为空串 → chips 仅「全部 + 其他」
    expect(screen.getByRole('button', { name: '其他' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '玩家' })).not.toBeInTheDocument()
  })

  it('查询中显示 Skeleton 行', () => {
    const onSendCommand = vi.fn<SendCommand>().mockReturnValue(new Promise<string | null>(() => {}))
    renderPanel({ onSendCommand })
    expect(onSendCommand).toHaveBeenCalledWith('gamerule')
    expect(screen.getByTestId('gamerule-skeletons')).toBeInTheDocument()
    expect(screen.queryByText('keepInventory')).not.toBeInTheDocument()
  })

  it('1.21.11+ 版本 → 新集 + 「1.21.11+ 新规则」徽章', async () => {
    renderPanel({ mcVersion: '26.1', onSendCommand: vi.fn().mockResolvedValue(newOutput()) })
    expect(await screen.findByText('keep_inventory')).toBeInTheDocument()
    expect(screen.getByText('1.21.11+ 新规则')).toBeInTheDocument()
    // 新集无 doDaylightCycle（改用资源位置名 advance_time）
    expect(screen.queryByText('doDaylightCycle')).not.toBeInTheDocument()
    expect(screen.getByText('advance_time')).toBeInTheDocument()
  })
})

// ── 行级编辑（Tasteful Friction）──────────────────────────────────

describe('GamerulePanel 行级编辑', () => {
  it('bool：点击 Switch → 保存/取消出现 → 确认下发 gamerule keepInventory true + 成功 toast + 本地值更新', async () => {
    const user = userEvent.setup()
    const { onSendCommand } = renderPanel()
    await screen.findByText('keepInventory')
    // 初始 false（默认值）
    const sw = screen.getByRole('switch', { name: 'keepInventory 开关' })
    expect(sw).toHaveAttribute('data-state', 'unchecked')
    // 未编辑态行尾无保存按钮
    expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument()
    await user.click(sw)
    // 值改动 → 行尾出现保存/取消
    expect(screen.getByRole('button', { name: '保存' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSendCommand).toHaveBeenCalledWith('gamerule keepInventory true'))
    expect(await screen.findByText('已更新规则 keepInventory = true')).toBeInTheDocument()
    // 编辑态退出，本地值已更新为 true
    expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'keepInventory 开关' })).toHaveAttribute(
      'data-state',
      'checked',
    )
  })

  it('bool：取消 → 回滚草稿（开关回到原值）', async () => {
    const user = userEvent.setup()
    const { onSendCommand } = renderPanel()
    await screen.findByText('keepInventory')
    await user.click(screen.getByRole('switch', { name: 'keepInventory 开关' }))
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'keepInventory 开关' })).toHaveAttribute(
      'data-state',
      'unchecked',
    )
    expect(onSendCommand).not.toHaveBeenCalledWith('gamerule keepInventory true')
  })

  it('int：输入新值 → 保存下发 gamerule randomTickSpeed 2', async () => {
    const user = userEvent.setup()
    const { onSendCommand } = renderPanel()
    await screen.findByText('randomTickSpeed')
    const input = screen.getByLabelText('randomTickSpeed 值')
    expect(input).toHaveValue('3') // 默认值
    await user.clear(input)
    await user.type(input, '2')
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSendCommand).toHaveBeenCalledWith('gamerule randomTickSpeed 2'))
    expect(await screen.findByText('已更新规则 randomTickSpeed = 2')).toBeInTheDocument()
  })

  it('保存失败：toast 友好错误 + 回滚值（编辑态退出、开关回到已提交值）', async () => {
    const user = userEvent.setup()
    const onSendCommand = vi
      .fn()
      .mockResolvedValueOnce(legacyOutput()) // 挂载查询
      .mockRejectedValueOnce(new Error('boom')) // 保存失败
    renderPanel({ onSendCommand })
    await screen.findByText('keepInventory')
    await user.click(screen.getByRole('switch', { name: 'keepInventory 开关' }))
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('规则更新失败：网络错误')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'keepInventory 开关' })).toHaveAttribute(
      'data-state',
      'unchecked',
    )
  })
})

// ── 解析失败降级 ───────────────────────────────────────────────────

describe('GamerulePanel 解析失败降级', () => {
  it('乱文本响应 → warning 提示 + 默认值态（「默认」标记，仍可编辑）', async () => {
    const user = userEvent.setup()
    const { onSendCommand } = renderPanel({
      onSendCommand: vi.fn().mockResolvedValue('无法识别的内容哦\nnothing = here'),
    })
    expect(await screen.findByText('无法解析 gamerule 列表，请点击刷新重试')).toBeInTheDocument()
    // 列表仍显示默认值态
    expect(screen.getByText('keepInventory')).toBeInTheDocument()
    expect(screen.getAllByText('默认').length).toBeGreaterThan(0)
    // 仍可编辑：保存即下发命令
    const sw = screen.getByRole('switch', { name: 'keepInventory 开关' })
    expect(sw).toHaveAttribute('data-state', 'unchecked') // 默认 false
    await user.click(sw)
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSendCommand).toHaveBeenCalledWith('gamerule keepInventory true'))
    expect(await screen.findByText('已更新规则 keepInventory = true')).toBeInTheDocument()
  })

  it('查询抛错（调用方已 toast）→ 同样走解析失败降级态', async () => {
    renderPanel({ onSendCommand: vi.fn().mockRejectedValue(new Error('network')) })
    expect(await screen.findByText('无法解析 gamerule 列表，请点击刷新重试')).toBeInTheDocument()
    expect(screen.getByText('keepInventory')).toBeInTheDocument()
  })
})

// ── 搜索 + 分类筛选 ────────────────────────────────────────────────

describe('GamerulePanel 搜索与分类', () => {
  it('新集（1.21.11）：搜索按 name 过滤 + 分类 chips 筛选', async () => {
    const user = userEvent.setup()
    renderPanel({ mcVersion: '1.21.11', onSendCommand: vi.fn().mockResolvedValue(newOutput()) })
    await screen.findByText('keep_inventory')
    // 搜索过滤（keep_inventory 命中，mob_griefing 不命中）
    await user.type(screen.getByLabelText('搜索规则'), 'keep')
    expect(screen.getByText('keep_inventory')).toBeInTheDocument()
    expect(screen.queryByText('mob_griefing')).not.toBeInTheDocument()
    await user.clear(screen.getByLabelText('搜索规则'))
    // 分类筛选：玩家 → keep_inventory（玩家）在，random_tick_speed（世界更新）不在
    await user.click(screen.getByRole('button', { name: '玩家' }))
    expect(screen.getByText('keep_inventory')).toBeInTheDocument()
    expect(screen.queryByText('random_tick_speed')).not.toBeInTheDocument()
    // 全部恢复
    await user.click(screen.getByRole('button', { name: '全部' }))
    expect(screen.getByText('random_tick_speed')).toBeInTheDocument()
    expect(screen.getByText('mob_griefing')).toBeInTheDocument()
  })

  it('搜索无匹配显示空态', async () => {
    const user = userEvent.setup()
    renderPanel()
    await screen.findByText('keepInventory')
    await user.type(screen.getByLabelText('搜索规则'), '不存在的规则xyz')
    expect(screen.getByText('无匹配规则')).toBeInTheDocument()
  })
})

// ── RCON 未连接 ────────────────────────────────────────────────────

describe('GamerulePanel RCON 未连接', () => {
  it('info 提示 + 控件禁用 + 跳过自动查询 + 刷新禁用', async () => {
    const { onSendCommand } = renderPanel({ isRconConnected: false })
    expect(screen.getByText('gamerule 修改需要 RCON 连接')).toBeInTheDocument()
    await screen.findByText('keepInventory')
    // 不发起查询
    expect(onSendCommand).not.toHaveBeenCalled()
    // 控件禁用（switch / int 输入）
    expect(screen.getByRole('switch', { name: 'keepInventory 开关' })).toBeDisabled()
    expect(screen.getByLabelText('randomTickSpeed 值')).toBeDisabled()
    expect(screen.getByRole('button', { name: '刷新规则' })).toBeDisabled()
    // 默认值态（「默认」标记）
    expect(screen.getAllByText('默认').length).toBeGreaterThan(0)
    expect(screen.getByRole('switch', { name: 'keepInventory 开关' })).toHaveAttribute(
      'data-state',
      'unchecked',
    )
  })
})

// ── 刷新 ───────────────────────────────────────────────────────────

describe('GamerulePanel 刷新', () => {
  it('刷新按钮：重新查询并更新列表值', async () => {
    const user = userEvent.setup()
    const changed = LEGACY_GAMERULES.map((d) =>
      d.name === 'keepInventory' ? 'keepInventory = true' : `${d.name} = ${String(d.defaultValue)}`,
    ).join('\n')
    const onSendCommand = vi
      .fn()
      .mockResolvedValueOnce(legacyOutput())
      .mockResolvedValueOnce(changed)
    renderPanel({ onSendCommand })
    await screen.findByText('keepInventory')
    expect(screen.getByRole('switch', { name: 'keepInventory 开关' })).toHaveAttribute(
      'data-state',
      'unchecked',
    )
    await user.click(screen.getByRole('button', { name: '刷新规则' }))
    await waitFor(() => expect(onSendCommand).toHaveBeenCalledTimes(2))
    expect(onSendCommand).toHaveBeenNthCalledWith(2, 'gamerule')
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'keepInventory 开关' })).toHaveAttribute(
        'data-state',
        'checked',
      ),
    )
  })
})
