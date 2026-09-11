/**
 * MonacoEditorPane 组件测试
 * Monaco 在 jsdom 不可渲染（依赖 canvas/DOM 测量）——测试策略：
 * 1. vi.mock('@monaco-editor/react')：占位 textarea（onChange 透传）+ 捕获最近一次 Editor props
 *    （language/theme/value/path 断言）+ 挂载后模拟 onMount（假编辑器记录 Ctrl+S 命令注册与释放）
 * 2. vi.mock('monaco-editor')：规避真实包在 jsdom 的加载副作用（组件仅消费 KeyMod/KeyCode 常量）
 * 3. languageForFile 为纯函数独立 export，直接单测
 * 测试路径全部为虚构示例（示例世界/示例文件名），禁真实服务器数据
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { MonacoEditorPaneProps } from '../monaco-editor-pane'
import { MonacoEditorPane, languageForFile } from '../monaco-editor-pane'

// ── 虚构示例文件路径（禁真实数据）──
const PATH_PROPERTIES = '/示例世界/config/server.properties'
const PATH_YAML = '/示例世界/config/paper.yml'
const PATH_JSON = '/示例世界/ops.json'
const PATH_CONF = '/示例世界/plugins/custom.conf'
const PATH_LOG = '/示例世界/logs/latest.log'
const PATH_TXT = '/示例世界/readme.txt'

// ── @monaco-editor/react mock：捕获 props + 模拟 onMount（假编辑器/假 monaco 常量）──
const editorCall = vi.hoisted(() => ({
  props: null as null | {
    path?: string
    language?: string
    theme?: string
    value?: string
    onChange?: (v: string) => void
    onMount?: (editor: unknown, monaco: unknown) => void
  },
  addCommand: vi.fn(),
  loaderConfig: vi.fn(),
}))

// ── monaco-editor mock：组件仅消费 KeyMod/KeyCode 常量与类型 ──
const monacoMock = vi.hoisted(() => ({
  KeyMod: { CtrlCmd: 2048 },
  KeyCode: { KeyS: 49 },
}))

vi.mock('@monaco-editor/react', async () => {
  const React = await import('react')
  return {
    loader: { config: editorCall.loaderConfig },
    // 函数名大写开头：满足 rules-of-hooks 的组件识别（mock 内使用 useEffect 模拟 onMount）
    default: function MockEditor(props: {
      value?: string
      onChange?: (v: string) => void
      onMount?: (editor: unknown, monaco: unknown) => void
    }) {
      editorCall.props = props
      React.useEffect(() => {
        // 模拟真实挂载：假编辑器 + 假 monaco（提供按键常量）记录 Ctrl+S 命令注册
        props.onMount?.(
          { addCommand: editorCall.addCommand },
          { KeyMod: { CtrlCmd: 2048 }, KeyCode: { KeyS: 49 } },
        )
        // mock 组件：仅首次挂载模拟一次 onMount（依赖数组留空是刻意为之）
        // oxlint-disable-next-line react-hooks/exhaustive-deps -- 测试 mock 精确模拟首次挂载 onMount（依赖数组留空是刻意设计）
      }, [])
      return React.createElement('textarea', {
        'data-testid': 'monaco-editor',
        value: String(props.value ?? ''),
        onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => props.onChange?.(e.target.value),
      })
    },
  }
})

vi.mock('monaco-editor', () => monacoMock)

/** 构造组件 props（默认全空态，override 覆盖；onSave/onClose/onRetry 可单独注入断言） */
function makeProps(overrides: Partial<MonacoEditorPaneProps> = {}): MonacoEditorPaneProps {
  return {
    path: '',
    content: '',
    encoding: 'utf-8',
    theme: 'dark',
    isLoading: false,
    loadError: null,
    isSaving: false,
    dirty: false,
    onChange: vi.fn(),
    onSave: vi.fn(),
    onRestore: vi.fn(),
    onClose: vi.fn(),
    onRetry: vi.fn(),
    ...overrides,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

beforeEach(() => {
  editorCall.props = null
  editorCall.addCommand.mockClear()
  // 注意：loaderConfig 由组件模块导入期调用（模块级 loader.config），
  // 每测试文件仅一次，禁止 mockClear（会抹掉记录）
})

// ── 纯函数：语言映射 ──
describe('languageForFile', () => {
  it('.properties → properties（大小写不敏感，含目录前缀）', () => {
    expect(languageForFile(PATH_PROPERTIES)).toBe('properties')
    expect(languageForFile('SERVER.PROPERTIES')).toBe('properties')
    expect(languageForFile('config/server.properties')).toBe('properties')
  })

  it('.conf / .cfg → ini', () => {
    expect(languageForFile(PATH_CONF)).toBe('ini')
    expect(languageForFile('/示例世界/plugins/custom.cfg')).toBe('ini')
    expect(languageForFile('CUSTOM.CFG')).toBe('ini')
  })

  it('.json → json', () => {
    expect(languageForFile(PATH_JSON)).toBe('json')
    expect(languageForFile('/示例世界/data/settings.json')).toBe('json')
  })

  it('.yml / .yaml → yaml（大小写不敏感）', () => {
    expect(languageForFile(PATH_YAML)).toBe('yaml')
    expect(languageForFile('/示例世界/config/paper.yaml')).toBe('yaml')
    expect(languageForFile('Paper.YML')).toBe('yaml')
  })

  it('.log → plaintext（Monaco 无 accesslog 语言，降级）', () => {
    expect(languageForFile(PATH_LOG)).toBe('plaintext')
    expect(languageForFile('LATEST.LOG')).toBe('plaintext')
  })

  it('其他扩展名/无扩展名 → plaintext', () => {
    expect(languageForFile(PATH_TXT)).toBe('plaintext')
    expect(languageForFile('/示例世界/server.jar')).toBe('plaintext')
    expect(languageForFile('/示例世界/README')).toBe('plaintext')
  })
})

// ── Monaco 本地化（禁 CDN）+ worker 配置 ──
describe('Monaco 本地化配置（禁 CDN）', () => {
  it('loader.config 调用一次且注入本地 monaco 包', () => {
    render(<MonacoEditorPane {...makeProps({ path: PATH_PROPERTIES, content: 'a=b' })} />)
    expect(editorCall.loaderConfig).toHaveBeenCalledTimes(1)
    expect(editorCall.loaderConfig.mock.calls[0]?.[0]).toEqual({ monaco: monacoMock })
  })

  it('self.MonacoEnvironment 已配置本地 worker 工厂（editor 通用 + json 按需）', () => {
    render(<MonacoEditorPane {...makeProps({ path: PATH_PROPERTIES })} />)
    expect(self.MonacoEnvironment?.getWorker).toBeTypeOf('function')
  })
})

// ── 空态 ──
describe('空态（无选中文件）', () => {
  it('path 为空 → 「选择文件进行编辑」+ FileEdit 图标，无编辑器/头部按钮', () => {
    const { container } = render(<MonacoEditorPane {...makeProps()} />)
    expect(screen.getByText('选择文件进行编辑')).toBeInTheDocument()
    expect(container.querySelector('svg')).not.toBeNull()
    expect(screen.queryByTestId('monaco-editor')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '关闭编辑器' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /保存/ })).not.toBeInTheDocument()
  })
})

// ── 加载态 ──
describe('加载态（isLoading）', () => {
  it('显示文件名 + Skeleton 占位，隐藏 encoding 徽章与编辑器', () => {
    const { container } = render(
      <MonacoEditorPane
        {...makeProps({ path: PATH_PROPERTIES, isLoading: true, dirty: true })}
      />,
    )
    expect(screen.getByText('server.properties')).toBeInTheDocument()
    expect(container.querySelector('[data-slot="skeleton"]')).not.toBeNull()
    expect(screen.queryByText('UTF-8')).not.toBeInTheDocument()
    expect(screen.queryByTestId('monaco-editor')).not.toBeInTheDocument()
    // 加载中保存按钮禁用（dirty=true 也不可保存，内容未就绪）
    expect(screen.getByRole('button', { name: /保存/ })).toBeDisabled()
  })
})

// ── 错误态 ──
describe('错误态（loadError）', () => {
  it('显示错误文案 + 重试按钮（点击触发 onRetry），编辑器不渲染', () => {
    const onRetry = vi.fn()
    render(
      <MonacoEditorPane
        {...makeProps({ path: PATH_PROPERTIES, loadError: '文件过大，无法编辑', onRetry })}
      />,
    )
    expect(screen.getByText('文件过大，无法编辑')).toBeInTheDocument()
    expect(screen.queryByTestId('monaco-editor')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /重试/ }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('错误态下保存按钮禁用', () => {
    render(
      <MonacoEditorPane
        {...makeProps({ path: PATH_PROPERTIES, loadError: '加载失败', dirty: true })}
      />,
    )
    expect(screen.getByRole('button', { name: /保存/ })).toBeDisabled()
  })
})

// ── 头部条 ──
describe('头部条', () => {
  it('文件名截断展示 + title 为完整路径', () => {
    render(<MonacoEditorPane {...makeProps({ path: PATH_PROPERTIES })} />)
    const name = screen.getByText('server.properties')
    expect(name).toHaveAttribute('title', PATH_PROPERTIES)
    expect(name.className).toContain('font-mono')
  })

  it('encoding 徽章：utf-8 → 「UTF-8」，gbk → 「GBK」', () => {
    const { rerender } = render(
      <MonacoEditorPane {...makeProps({ path: PATH_PROPERTIES, encoding: 'utf-8' })} />,
    )
    expect(screen.getByText('UTF-8')).toBeInTheDocument()
    rerender(<MonacoEditorPane {...makeProps({ path: PATH_PROPERTIES, encoding: 'gbk' })} />)
    expect(screen.getByText('GBK')).toBeInTheDocument()
    expect(screen.queryByText('UTF-8')).not.toBeInTheDocument()
  })

  it('脏标记：dirty=true 显示「未保存」warning 徽章，false 不显示', () => {
    const { rerender } = render(
      <MonacoEditorPane {...makeProps({ path: PATH_PROPERTIES, dirty: false })} />,
    )
    expect(screen.queryByText('未保存')).not.toBeInTheDocument()
    rerender(<MonacoEditorPane {...makeProps({ path: PATH_PROPERTIES, dirty: true })} />)
    const badge = screen.getByText('未保存')
    expect(badge.className).toContain('text-mcs-warning-fg')
    expect(badge.className).toContain('bg-mcs-warning-bg-subtle')
    expect(badge.className).toContain('border-mcs-warning-border')
  })

  it('保存按钮：dirty=false 禁用；dirty=true 启用且含 Ctrl+S 提示；点击触发 onSave', () => {
    const onSave = vi.fn()
    const { rerender } = render(
      <MonacoEditorPane {...makeProps({ path: PATH_PROPERTIES, onSave, dirty: false })} />,
    )
    expect(screen.getByRole('button', { name: /保存/ })).toBeDisabled()
    expect(screen.getByText('Ctrl+S')).toBeInTheDocument()

    rerender(<MonacoEditorPane {...makeProps({ path: PATH_PROPERTIES, onSave, dirty: true })} />)
    const save = screen.getByRole('button', { name: /保存/ })
    expect(save).toBeEnabled()
    fireEvent.click(save)
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('保存提示按平台取词：macOS 显示 ⌘+S（Monaco 的 CtrlCmd 在 mac 即 Cmd）', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
    render(<MonacoEditorPane {...makeProps({ path: PATH_PROPERTIES, dirty: true })} />)

    expect(screen.getByText('⌘+S')).toBeInTheDocument()
    expect(screen.queryByText('Ctrl+S')).not.toBeInTheDocument()
    // 按钮 title 同口径（悬停提示同样不能给 mac 用户错键位）
    expect(screen.getByRole('button', { name: /保存/ })).toHaveAttribute('title', '保存（⌘+S）')
  })

  it('isSaving=true → 保存按钮禁用并显示「保存中…」', () => {
    render(
      <MonacoEditorPane {...makeProps({ path: PATH_PROPERTIES, dirty: true, isSaving: true })} />,
    )
    const save = screen.getByRole('button', { name: /保存/ })
    expect(save).toBeDisabled()
    expect(screen.getByText('保存中…')).toBeInTheDocument()
  })

  it('关闭按钮点击触发 onClose', () => {
    const onClose = vi.fn()
    render(<MonacoEditorPane {...makeProps({ path: PATH_PROPERTIES, onClose })} />)
    fireEvent.click(screen.getByRole('button', { name: '关闭编辑器' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

// ── 编辑器 props（mock 捕获断言）──
describe('编辑器（@monaco-editor/react mock）', () => {
  it('暗色主题 → mcs-dark；语言按扩展名映射；value/path 透传', () => {
    render(
      <MonacoEditorPane
        {...makeProps({ path: PATH_PROPERTIES, content: 'a=b', theme: 'dark' })}
      />,
    )
    expect(editorCall.props?.theme).toBe('mcs-dark')
    expect(editorCall.props?.language).toBe('properties')
    expect(editorCall.props?.value).toBe('a=b')
    expect(editorCall.props?.path).toBe(PATH_PROPERTIES)
  })

  it('亮色主题 → vs', () => {
    render(<MonacoEditorPane {...makeProps({ path: PATH_PROPERTIES, theme: 'light' })} />)
    expect(editorCall.props?.theme).toBe('vs')
  })

  it('切换文件 → language 随新路径重算（.yml → yaml）', () => {
    const props = makeProps({ path: PATH_PROPERTIES })
    const { rerender } = render(<MonacoEditorPane {...props} />)
    expect(editorCall.props?.language).toBe('properties')
    rerender(<MonacoEditorPane {...makeProps({ path: PATH_YAML, content: 'a: b' })} />)
    expect(editorCall.props?.language).toBe('yaml')
    expect(editorCall.props?.path).toBe(PATH_YAML)
  })

  it('编辑器输入 → onChange 透传新值', () => {
    const onChange = vi.fn()
    render(
      <MonacoEditorPane
        {...makeProps({ path: PATH_PROPERTIES, content: 'a=b', onChange })}
      />,
    )
    const textarea = screen.getByTestId('monaco-editor')
    fireEvent.change(textarea, { target: { value: 'a=c' } })
    expect(onChange).toHaveBeenCalledWith('a=c')
  })

  it('Ctrl+S 命令注册（CtrlCmd|KeyS）并触发 onSave（卸载移除由编辑器销毁承担）', () => {
    const onSave = vi.fn()
    render(<MonacoEditorPane {...makeProps({ path: PATH_PROPERTIES, dirty: true, onSave })} />)
    // 模拟 onMount 已注册命令：2048 | 49 = KeyMod.CtrlCmd | KeyCode.KeyS
    expect(editorCall.addCommand).toHaveBeenCalledTimes(1)
    const [keybinding, handler] = editorCall.addCommand.mock.calls[0] ?? []
    expect(keybinding).toBe(2048 | 49)
    expect(typeof handler).toBe('function')

    ;(handler as () => void)()
    expect(onSave).toHaveBeenCalledTimes(1)
  })
})
