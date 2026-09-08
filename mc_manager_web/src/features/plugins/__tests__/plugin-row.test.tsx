/**
 * PluginRow 行为级测试（issue 449：插件行组件 funcs 洼地覆盖收口）
 * 纯展示组件（props 全回调注入，无网络/store 依赖），覆盖：
 * - 渲染与 meta 回退：displayName（meta.name ?? 文件名）、版本/API 徽章条件渲染、
 *   启停状态徽章、作者/依赖列表、缺省字段不出现在文档
 * - 行键盘导航：Enter/Space 打开详情（preventDefault 语义）、其他键不触发
 * - 复选框：勾选/取消语义（radix 'indeterminate' 归一为 false）、容器点击与 keydown 双向冒泡阻断
 * - 「可更新」徽章：hasNewer 渲染、点击 stopPropagation 后 onUpdate、未命中不渲染
 * - 启停状态机：enabled→禁用（onToggle(plugin,false)）/禁用→启用（onToggle(plugin,true)）、
 *   toggling 禁用、操作列点击与 keydown 冒泡阻断
 * - 删除：onClick 透传、deleting 禁用
 * 文件名与玩家数据均为虚构示例，严禁真实服务器数据
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PluginRow } from '../components/plugin-row'
import type { PluginInfo, PluginUpdateStatus } from '@/api/types'

// ── fixture（虚构数据） ──

const META = {
  name: 'EssentialsX',
  version: '2.21.0',
  main: 'com.example.essentials.Essentials',
  apiVersion: '1.21',
  description: '核心基础插件套件（虚构示例）',
  authors: ['Steve', 'Alex'],
  depend: ['Vault'],
  softdepend: [],
  website: null,
  load: 'POSTWORLD' as const,
}

function mkPlugin(overrides: Partial<PluginInfo> = {}): PluginInfo {
  return {
    file: 'EssentialsX-2.21.0.jar',
    name: 'EssentialsX-2.21.0.jar',
    enabled: true,
    sizeBytes: 4605977,
    mtimeMs: 1760000000000,
    meta: META,
    ...overrides,
  }
}

function mkUpdateStatus(overrides: Partial<PluginUpdateStatus> = {}): PluginUpdateStatus {
  return {
    file: 'EssentialsX-2.21.0.jar',
    name: 'EssentialsX',
    installedVersion: '2.21.0',
    enabled: true,
    matched: true,
    slug: 'essentialsx',
    title: 'EssentialsX',
    iconUrl: null,
    latestVersion: '2.22.0',
    updateAvailable: true,
    hasNewer: true,
    ...overrides,
  }
}

interface SetupOpts {
  plugin?: PluginInfo
  checked?: boolean
  toggling?: boolean
  deleting?: boolean
  updateInfo?: PluginUpdateStatus
}

function setup({
  plugin = mkPlugin(),
  checked = false,
  toggling = false,
  deleting = false,
  updateInfo,
}: SetupOpts = {}) {
  const onCheckedChange = vi.fn()
  const onToggle = vi.fn()
  const onDelete = vi.fn()
  const onOpenDetail = vi.fn()
  const onUpdate = vi.fn()
  const view = render(
    <ul>
      <PluginRow
        plugin={plugin}
        checked={checked}
        onCheckedChange={onCheckedChange}
        toggling={toggling}
        deleting={deleting}
        onToggle={onToggle}
        onDelete={onDelete}
        onOpenDetail={onOpenDetail}
        updateInfo={updateInfo}
        onUpdate={onUpdate}
      />
    </ul>,
  )
  return { view, onCheckedChange, onToggle, onDelete, onOpenDetail, onUpdate }
}

// ── 渲染与 meta 回退 ──

describe('PluginRow · 渲染与 meta 回退', () => {
  it('meta.name 存在时展示名用 meta.name，行 aria-label 指向详情语义', () => {
    setup()
    expect(screen.getByRole('button', { name: '查看插件 EssentialsX 详情' })).toBeInTheDocument()
    expect(screen.queryByText('EssentialsX-2.21.0.jar')).toBeInTheDocument()
  })

  it('meta=null 时展示名回退为文件名（meta?.name ?? plugin.name）', () => {
    setup({ plugin: mkPlugin({ meta: null }) })
    expect(screen.getByRole('button', { name: '查看插件 EssentialsX-2.21.0.jar 详情' })).toBeInTheDocument()
    // 元数据派生内容缺席：版本/API 徽章、作者、依赖
    expect(screen.queryByText('v2.21.0')).not.toBeInTheDocument()
    expect(screen.queryByText('API 1.21')).not.toBeInTheDocument()
    expect(screen.queryByText('作者 Steve, Alex')).not.toBeInTheDocument()
    expect(screen.queryByText(/依赖：/)).not.toBeInTheDocument()
  })

  it('完整 meta 渲染版本/API/作者/依赖区与说明文案', () => {
    setup()
    expect(screen.getByText('v2.21.0')).toBeInTheDocument()
    expect(screen.getByText('API 1.21')).toBeInTheDocument()
    expect(screen.getByText('作者 Steve, Alex')).toBeInTheDocument()
    expect(screen.getByText(/依赖：Vault/)).toBeInTheDocument()
    expect(screen.getByText('（不做自动解析，缺失时插件可能无法加载）')).toBeInTheDocument()
  })

  it('meta.name 为 null 时回退文件名，但版本等仍可渲染', () => {
    setup({ plugin: mkPlugin({ meta: { ...META, name: null } }) })
    expect(screen.getByRole('button', { name: '查看插件 EssentialsX-2.21.0.jar 详情' })).toBeInTheDocument()
    expect(screen.getByText('v2.21.0')).toBeInTheDocument()
  })

  it('启停状态徽章随 enabled 切换文案', () => {
    const enabled = setup({ plugin: mkPlugin({ enabled: true }) })
    expect(screen.getByText('已启用')).toBeInTheDocument()
    enabled.view.unmount()
    setup({ plugin: mkPlugin({ enabled: false }) })
    expect(screen.getByText('已禁用')).toBeInTheDocument()
  })
})

// ── 行键盘导航与点击 ──

describe('PluginRow · 行键盘导航', () => {
  it('聚焦行后按 Enter 打开详情', async () => {
    const user = userEvent.setup()
    const { onOpenDetail } = setup()
    const row = screen.getByRole('button', { name: /查看插件 EssentialsX 详情/ })
    await user.click(row)
    // user.click 已触发一次 onClick 打开详情，重置后验证键盘路径
    onOpenDetail.mockClear()
    row.focus()
    await user.keyboard('{Enter}')
    expect(onOpenDetail).toHaveBeenCalledTimes(1)
  })

  it('聚焦行后按 Space 打开详情', async () => {
    const user = userEvent.setup()
    const { onOpenDetail } = setup()
    const row = screen.getByRole('button', { name: /查看插件 EssentialsX 详情/ })
    row.focus()
    await user.keyboard(' ')
    expect(onOpenDetail).toHaveBeenCalledTimes(1)
  })

  it('其他键不触发打开详情', async () => {
    const user = userEvent.setup()
    const { onOpenDetail } = setup()
    const row = screen.getByRole('button', { name: /查看插件 EssentialsX 详情/ })
    row.focus()
    await user.keyboard('{Escape}')
    expect(onOpenDetail).not.toHaveBeenCalled()
  })
})

// ── 复选框 ──

describe('PluginRow · 复选框', () => {
  it('未勾选点击回传 onCheckedChange(true)', async () => {
    const user = userEvent.setup()
    const { onCheckedChange } = setup({ checked: false })
    await user.click(screen.getByRole('checkbox', { name: '选择 EssentialsX' }))
    expect(onCheckedChange).toHaveBeenCalledWith(true)
  })

  it('已勾选再点击回传 onCheckedChange(false)', async () => {
    const user = userEvent.setup()
    const { onCheckedChange } = setup({ checked: true })
    await user.click(screen.getByRole('checkbox', { name: '选择 EssentialsX' }))
    expect(onCheckedChange).toHaveBeenCalledWith(false)
  })

  it('点击复选框容器不触发行 onClick 打开详情（stopPropagation 语义）', async () => {
    const user = userEvent.setup()
    const { onOpenDetail } = setup()
    await user.click(screen.getByRole('checkbox', { name: '选择 EssentialsX' }))
    expect(onOpenDetail).not.toHaveBeenCalled()
  })

  it('容器内 keydown 被阻断，不触发行键盘导航', () => {
    const { onOpenDetail } = setup()
    const container = screen.getByRole('checkbox', { name: '选择 EssentialsX' }).parentElement!
    fireEvent.keyDown(container, { key: 'Enter' })
    expect(onOpenDetail).not.toHaveBeenCalled()
  })
})

// ── 「可更新」徽章 ──

describe('PluginRow · 可更新徽章', () => {
  it('hasNewer=true 渲染徽章并展示 Modrinth 最新版本号', () => {
    setup({ updateInfo: mkUpdateStatus() })
    const badge = screen.getByTestId('update-badge')
    expect(badge).toHaveTextContent('可更新 → 2.22.0')
    expect(badge).toHaveAttribute('title', 'Modrinth 最新版 2.22.0，点击前往市场更新')
  })

  it('点击徽章回传 onUpdate(plugin) 且不触发行 onClick（stopPropagation 语义）', async () => {
    const user = userEvent.setup()
    const plugin = mkPlugin()
    const { onUpdate, onOpenDetail } = setup({ plugin, updateInfo: mkUpdateStatus() })
    await user.click(screen.getByTestId('update-badge'))
    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(onUpdate).toHaveBeenCalledWith(plugin)
    expect(onOpenDetail).not.toHaveBeenCalled()
  })

  it('hasNewer=false 时不渲染徽章', () => {
    setup({ updateInfo: mkUpdateStatus({ hasNewer: false, updateAvailable: false }) })
    expect(screen.queryByTestId('update-badge')).not.toBeInTheDocument()
  })

  it('未传入 updateInfo 时不渲染徽章', () => {
    setup()
    expect(screen.queryByTestId('update-badge')).not.toBeInTheDocument()
  })
})

// ── 启停操作 ──

describe('PluginRow · 启停操作', () => {
  it('启用中的插件展示「禁用」，点击回传 onToggle(plugin,false)', async () => {
    const user = userEvent.setup()
    const plugin = mkPlugin({ enabled: true })
    const { onToggle } = setup({ plugin })
    await user.click(screen.getByRole('button', { name: '禁用 EssentialsX' }))
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onToggle).toHaveBeenCalledWith(plugin, false)
  })

  it('禁用中的插件展示「启用」，点击回传 onToggle(plugin,true)', async () => {
    const user = userEvent.setup()
    const plugin = mkPlugin({ enabled: false })
    const { onToggle } = setup({ plugin })
    await user.click(screen.getByRole('button', { name: '启用 EssentialsX' }))
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onToggle).toHaveBeenCalledWith(plugin, true)
  })

  it('toggling=true 时启停按钮禁用，点击不触发 onToggle', async () => {
    const user = userEvent.setup()
    const { onToggle } = setup({ toggling: true })
    expect(screen.getByRole('button', { name: '禁用 EssentialsX' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: '禁用 EssentialsX' }))
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('操作列内点击不触发行 onClick 打开详情（stopPropagation 语义）', async () => {
    const user = userEvent.setup()
    const { onOpenDetail } = setup()
    await user.click(screen.getByRole('button', { name: '禁用 EssentialsX' }))
    expect(onOpenDetail).not.toHaveBeenCalled()
  })

  it('操作列内 keydown 被阻断，不触发行键盘导航', () => {
    const { onOpenDetail } = setup()
    const container = screen.getByRole('button', { name: '禁用 EssentialsX' }).parentElement!
    fireEvent.keyDown(container, { key: 'Enter' })
    expect(onOpenDetail).not.toHaveBeenCalled()
  })
})

// ── 删除 ──

describe('PluginRow · 删除', () => {
  it('点击删除按钮透传 onDelete 且不触发行 onClick', async () => {
    const user = userEvent.setup()
    const { onDelete, onOpenDetail } = setup()
    await user.click(screen.getByRole('button', { name: '删除 EssentialsX' }))
    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(onOpenDetail).not.toHaveBeenCalled()
  })

  it('deleting=true 时删除按钮禁用，点击不触发 onDelete', async () => {
    const user = userEvent.setup()
    const { onDelete } = setup({ deleting: true })
    expect(screen.getByRole('button', { name: '删除 EssentialsX' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: '删除 EssentialsX' }))
    expect(onDelete).not.toHaveBeenCalled()
  })
})
