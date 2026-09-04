/**
 * PluginDetailSheet 组件级测试（issue 442：插件域剩余洼地覆盖收口）
 * 纯展示组件（无网络/store 依赖），radix Sheet open 受控渲染，覆盖：
 * - 渲染守卫：plugin=null 不渲染；meta=null 标题回退文件名
 * - 元数据条件渲染：版本/API 版本/加载时机（LOAD_LABEL 映射 + 未知值回退）/主类/作者/官网/描述，缺省字段不出现在文档
 * - 依赖关系区：硬依赖/软依赖三态组合（双有/只硬/只软）
 * - 文件信息：大小/修改时间/路径（复用 lib/mc-files 真实实现计算期望值，零时区风险）
 * - 行内启停：启用→禁用按钮（onToggle(plugin,false)）与禁用→启用按钮（onToggle(plugin,true)）、toggling 禁用、关闭按钮透传 onOpenChange
 * 文件名与玩家数据均为虚构示例，严禁真实服务器数据
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PluginDetailSheet } from '../components/plugin-detail-sheet'
import { formatFileSize, formatModifiedAt } from '@/lib/mc-files'
import type { PluginInfo, PluginMeta } from '@/api/types'

// ── fixture（虚构数据） ──

const FULL_META: PluginMeta = {
  name: 'EssentialsX',
  version: '2.21.0',
  main: 'com.example.essentials.Essentials',
  apiVersion: '1.21',
  description: '核心基础插件套件（虚构示例）',
  authors: ['Steve', 'Alex'],
  depend: ['Vault'],
  softdepend: ['PlaceholderAPI'],
  website: 'https://example.com/essentials',
  load: 'POSTWORLD',
}

const BARE_META: PluginMeta = {
  name: 'BareCore',
  version: null,
  main: null,
  apiVersion: null,
  description: null,
  authors: [],
  depend: [],
  softdepend: [],
  website: null,
  load: null,
}

const MTIME_MS = 1760000000000

function mkPlugin(overrides: Partial<PluginInfo> = {}): PluginInfo {
  return {
    file: 'EssentialsX-2.21.0.jar',
    name: 'EssentialsX-2.21.0.jar',
    enabled: true,
    sizeBytes: 4605977,
    mtimeMs: MTIME_MS,
    meta: FULL_META,
    ...overrides,
  }
}

interface SetupOpts {
  plugin?: PluginInfo | null
  open?: boolean
  toggling?: boolean
}

function setup({ plugin = mkPlugin(), open = true, toggling = false }: SetupOpts = {}) {
  const onOpenChange = vi.fn()
  const onToggle = vi.fn()
  const view = render(
    <PluginDetailSheet
      plugin={plugin}
      open={open}
      onOpenChange={onOpenChange}
      onToggle={onToggle}
      toggling={toggling}
    />,
  )
  return { view, onOpenChange, onToggle }
}

// ── 渲染守卫与缺省回退 ──

describe('PluginDetailSheet · 渲染守卫与缺省回退', () => {
  it('plugin=null 时不渲染任何内容', () => {
    const { view } = setup({ plugin: null })
    expect(view.container.innerHTML).toBe('')
  })

  it('meta=null 时标题回退为文件名，元数据与依赖区不渲染', () => {
    setup({ plugin: mkPlugin({ meta: null }) })
    // 文件名同时出现在标题（回退）与 SheetDescription，限定标题 slot 断言
    expect(document.querySelector('[data-slot="sheet-title"]')).toHaveTextContent(
      'EssentialsX-2.21.0.jar',
    )
    // 元数据字段（dt 文本）全部缺席
    for (const label of ['版本', 'API 版本', '加载时机', '主类', '作者', '官网']) {
      expect(screen.queryByText(label)).not.toBeInTheDocument()
    }
    // 依赖关系区整体缺席
    expect(screen.queryByText('依赖关系')).not.toBeInTheDocument()
    // 文件信息仍然渲染
    expect(screen.getByText('文件信息')).toBeInTheDocument()
  })

  it('meta 字段全空时各 dt 缺席，仅渲染 section 骨架与文件信息', () => {
    setup({ plugin: mkPlugin({ meta: BARE_META }) })
    expect(screen.getByText('基本信息')).toBeInTheDocument()
    for (const label of ['版本', 'API 版本', '加载时机', '主类', '作者', '官网']) {
      expect(screen.queryByText(label)).not.toBeInTheDocument()
    }
    // depend/softdepend 均为空数组 → 依赖关系区缺席
    expect(screen.queryByText('依赖关系')).not.toBeInTheDocument()
  })

  it('meta.name 存在时标题优先用 meta.name 而非文件名', () => {
    setup()
    const title = document.querySelector('[data-slot="sheet-title"]')
    expect(title).toHaveTextContent('EssentialsX')
    expect(title!.textContent).not.toContain('EssentialsX-2.21.0.jar')
    // 文件名仍出现在 SheetDescription（插件文件名行）
    expect(screen.getByText('EssentialsX-2.21.0.jar')).toBeInTheDocument()
  })
})

// ── 元数据渲染 ──

describe('PluginDetailSheet · 元数据渲染', () => {
  it('完整 meta 渲染描述/版本/API 版本/主类/作者（、连接）', () => {
    setup()
    expect(screen.getByText(FULL_META.description!)).toBeInTheDocument()
    expect(screen.getByText('v2.21.0')).toBeInTheDocument()
    expect(screen.getByText('API 1.21')).toBeInTheDocument()
    expect(screen.getByText('com.example.essentials.Essentials')).toBeInTheDocument()
    expect(screen.getByText('Steve、Alex')).toBeInTheDocument()
  })

  it('load=POSTWORLD 映射为「世界加载后，默认」文案', () => {
    setup()
    expect(screen.getByText('POSTWORLD（世界加载后，默认）')).toBeInTheDocument()
  })

  it('load=STARTUP 映射为「世界加载前」文案', () => {
    setup({ plugin: mkPlugin({ meta: { ...FULL_META, load: 'STARTUP' } }) })
    expect(screen.getByText('STARTUP（世界加载前）')).toBeInTheDocument()
  })

  it('load 未知值回退显示原值（LOAD_LABEL ?? 兜底）', () => {
    const legacy = { ...FULL_META, load: 'LEGACY' as PluginMeta['load'] }
    setup({ plugin: mkPlugin({ meta: legacy }) })
    expect(screen.getByText('LEGACY')).toBeInTheDocument()
  })

  it('官网渲染为安全外链（href/target/rel + 域内文本）', () => {
    setup()
    const link = screen.getByRole('link', { name: /example\.com\/essentials/ })
    expect(link).toHaveAttribute('href', 'https://example.com/essentials')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noreferrer noopener')
  })
})

// ── 依赖关系区 ──

describe('PluginDetailSheet · 依赖关系区', () => {
  it('硬依赖与软依赖同时存在时分别渲染两组徽章', () => {
    setup()
    const section = screen.getByLabelText('依赖关系')
    expect(within(section).getByText('硬依赖（缺失时插件无法加载）')).toBeInTheDocument()
    expect(within(section).getByText('Vault')).toBeInTheDocument()
    expect(within(section).getByText('软依赖（缺失不影响加载）')).toBeInTheDocument()
    expect(within(section).getByText('PlaceholderAPI')).toBeInTheDocument()
  })

  it('仅有硬依赖时不渲染软依赖分组', () => {
    setup({ plugin: mkPlugin({ meta: { ...FULL_META, softdepend: [] } }) })
    expect(screen.getByText('硬依赖（缺失时插件无法加载）')).toBeInTheDocument()
    expect(screen.queryByText('软依赖（缺失不影响加载）')).not.toBeInTheDocument()
  })

  it('仅有软依赖时不渲染硬依赖分组', () => {
    setup({ plugin: mkPlugin({ meta: { ...FULL_META, depend: [] } }) })
    expect(screen.getByText('软依赖（缺失不影响加载）')).toBeInTheDocument()
    expect(screen.queryByText('硬依赖（缺失时插件无法加载）')).not.toBeInTheDocument()
  })
})

// ── 文件信息与行内启停 ──

describe('PluginDetailSheet · 文件信息', () => {
  it('渲染大小/修改时间/路径，时间期望值复用同一实现计算', () => {
    setup()
    const section = screen.getByLabelText('文件信息')
    expect(within(section).getByText(formatFileSize(4605977))).toBeInTheDocument()
    expect(
      within(section).getByText(formatModifiedAt(new Date(MTIME_MS).toISOString())),
    ).toBeInTheDocument()
    expect(within(section).getByText('plugins/EssentialsX-2.21.0.jar')).toBeInTheDocument()
  })
})

describe('PluginDetailSheet · 行内启停', () => {
  it('启用中的插件展示「禁用插件」按钮，点击回传 onToggle(plugin,false)', async () => {
    const user = userEvent.setup()
    const plugin = mkPlugin({ enabled: true })
    const { onToggle } = setup({ plugin })
    expect(screen.getByText('已启用')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '禁用插件' }))
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onToggle).toHaveBeenCalledWith(plugin, false)
  })

  it('禁用中的插件展示「启用插件」按钮，点击回传 onToggle(plugin,true)', async () => {
    const user = userEvent.setup()
    const plugin = mkPlugin({ enabled: false })
    const { onToggle } = setup({ plugin })
    expect(screen.getByText('已禁用')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '启用插件' }))
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onToggle).toHaveBeenCalledWith(plugin, true)
  })

  it('toggling=true 时启停按钮禁用，点击不触发回调', async () => {
    const user = userEvent.setup()
    const { onToggle } = setup({ toggling: true })
    const button = screen.getByRole('button', { name: '禁用插件' })
    expect(button).toBeDisabled()
    await user.click(button)
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('点击关闭按钮透传 onOpenChange(false)', async () => {
    const user = userEvent.setup()
    const { onOpenChange } = setup()
    await user.click(screen.getByRole('button', { name: '关闭弹窗' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('面板底部渲染启停生效时机提示', () => {
    setup()
    expect(screen.getByText('启停与增删在重启实例后生效（Bukkit 插件仅启动时加载）')).toBeInTheDocument()
  })
})
