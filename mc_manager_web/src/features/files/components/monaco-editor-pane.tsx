/**
 * MonacoEditorPane —— 文件编辑窗格（三栏文件管理器右栏）
 *
 * 【实现契约】
 * 1. 头部条：文件名（mono 截断 + title 全路径）+ encoding 徽章（「UTF-8」/「GBK」text-mcs-2xs）
 *    + 脏标记「未保存」warning 徽章 + 关闭按钮 + 保存按钮（Ctrl+S 提示，dirty=false 禁用）
 * 2. Ctrl+S：编辑器内 addCommand（KeyMod.CtrlCmd | KeyCode.KeyS）→ onSave；组件卸载时释放命令
 * 3. 状态机：path 空 → 空态；isLoading → Skeleton；loadError → 错误文案 + 重试；否则渲染编辑器
 * 4. Monaco 本地化（禁 CDN 外联）：loader.config({ monaco }) 注入本地包 + self.MonacoEnvironment
 *    配置 Vite ?worker（editor 通用 worker + json 语言按需）
 * 5. 语言映射（.log：Monaco 无 accesslog 语言 → plaintext 降级）
 * 6. 设计纪律：全部 --mcs-* 语义 token；编辑区实底（Monaco vs / vs-dark 自带主题底色）；
 *    Monaco 在 jsdom 不可渲染，测试 mock @monaco-editor/react（见 __tests__/monaco-editor-pane.test.tsx）
 *
 * 注意：monaco-editor 0.56 的 exports map 为 "./*": "./esm/vs/*.js"，官方 README 的
 * "monaco-editor/esm/vs/editor/editor.worker?worker" 子路径会解析失败（Vite 报
 * 'Package subpath is not defined by "exports"'），此处用 exports 兼容形式
 * "monaco-editor/editor/editor.worker?worker"（等价落到同一文件）。
 */
import { useEffect, useMemo, useRef } from 'react'
import Editor, { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/language/json/json.worker?worker'
import { FileEdit, RotateCcw, Save, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

// ── Monaco worker 配置（Vite 必需，否则控制台报错 "Could not create web worker"）──
// self.MonacoEnvironment 由 monaco-editor 的 d.ts 声明为全局（Environment 接口），
// SSR 下无 self，加 typeof 守卫防止 Node 侧求值报错
if (typeof self !== 'undefined') {
  self.MonacoEnvironment = {
    // json 语言走独立 worker，其余语言（高亮在主线程完成）复用通用 editor worker
    getWorker: (_workerId: string, label: string) =>
      label === 'json' ? new jsonWorker() : new editorWorker(),
  }
}
// 本地 monaco 包注入 loader：@monaco-editor/react 不再动态 import CDN
loader.config({ monaco })

/** MCS 暗色主题已注册标记（defineTheme 幂等性由 monaco 保证，此处防重复读取 CSS 变量） */
let mcsDarkThemeDefined = false

/**
 * CSS 变量 → hex 色值。
 * Monaco 的 theme colors 不支持 CSS 颜色函数（"Illegal value for token color"），
 * 用 canvas 2D 把计算后的颜色解析为 hex；jsdom 无 canvas（getContext 返回 null）返回 null。
 */
function cssVarToHex(varName: string): string | null {
  const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim()
  if (!value) return null
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.fillStyle = value
  ctx.fillRect(0, 0, 1, 1)
  const data = ctx.getImageData(0, 0, 1, 1).data
  if (!data || data[3] === 0) return null
  const hex = (n: number) => n.toString(16).padStart(2, '0')
  return `#${hex(data[0]!)}${hex(data[1]!)}${hex(data[2]!)}`
}

/**
 * 注册 MCS 暗色编辑器主题：背景对齐 --mcs-bg-subtle（偏蓝深底），
 * 避免内置 vs-dark 中性灰底色与 MCS 面板色相割裂。
 * 颜色运行时读取 CSS 变量经 canvas 解析为 hex（token 唯一来源，源码无硬编码色值）；
 * 解析失败（jsdom/SSR）跳过，回退 vs-dark 主题继承。
 */
function defineMcsDarkTheme() {
  if (mcsDarkThemeDefined || typeof document === 'undefined') return
  mcsDarkThemeDefined = true
  const bgSubtle = cssVarToHex('--mcs-bg-subtle')
  const bgDefault = cssVarToHex('--mcs-bg-default')
  const borderSubtle = cssVarToHex('--mcs-border-subtle')
  const textMuted = cssVarToHex('--mcs-text-muted')
  const accent = cssVarToHex('--mcs-accent')
  if (!bgSubtle) return
  monaco.editor.defineTheme('mcs-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': bgSubtle,
      'editor.lineHighlightBackground': bgDefault || bgSubtle,
      'editor.lineHighlightBorder': borderSubtle || 'transparent',
      ...(textMuted ? { 'editorLineNumber.foreground': textMuted } : {}),
      ...(accent ? { 'editorCursor.foreground': accent } : {}),
    },
  })
}
defineMcsDarkTheme()

export interface MonacoEditorPaneProps {
  /** 当前编辑文件路径（'/' 前缀风格；'' = 未选中文件 → 空态） */
  path: string
  /** 文件内容（服务端已按 encoding 解码为文本） */
  content: string
  /** 文件编码（服务端探测，头部徽章展示） */
  encoding: 'utf-8' | 'gbk'
  /** 应用明暗主题（映射 Monaco 内置主题 vs / vs-dark） */
  theme: 'light' | 'dark'
  /** 内容加载中（Skeleton 占位，encoding 徽章隐藏） */
  isLoading: boolean
  /** 加载错误文案（非 null 显示错误态 + 重试按钮） */
  loadError: string | null
  /** 保存中（禁用保存按钮防重入） */
  isSaving: boolean
  /** 内容脏标记（「未保存」warning 徽章 + 保存按钮启用） */
  dirty: boolean
  /** 编辑器内容变化（Monaco 编辑事件 → 父组件更新内容） */
  onChange: (value: string) => void
  /** 保存（Ctrl+S 快捷键与保存按钮共用） */
  onSave: () => void
  /** 恢复上次保存版本（仅脏状态可用） */
  onRestore: () => void
  /** 关闭当前文件（父组件负责脏确认） */
  onClose: () => void
  /** 加载失败后重读文件（父组件重新拉取内容） */
  onRetry: () => void
}

/**
 * 文件路径 → Monaco language id（扩展名大小写不敏感）
 * 差异：Monaco 无 'accesslog' 语言，.log 降级 plaintext
 * （无色高亮；如需日志高亮可 defineTheme 自定义）
 */
export function languageForFile(filePath: string): string {
  const name = filePath.toLowerCase()
  if (name.endsWith('.properties')) return 'properties'
  if (name.endsWith('.conf') || name.endsWith('.cfg')) return 'ini'
  if (name.endsWith('.json')) return 'json'
  if (name.endsWith('.yml') || name.endsWith('.yaml')) return 'yaml'
  if (name.endsWith('.log')) return 'plaintext' // Monaco 无 accesslog 语言 → 降级
  return 'plaintext'
}

/** 文件路径 → 显示名（末段文件名；路径以 '/' 分隔） */
function fileNameOf(filePath: string): string {
  const idx = filePath.lastIndexOf('/')
  return idx >= 0 ? filePath.slice(idx + 1) : filePath
}

export function MonacoEditorPane({
  path,
  content,
  encoding,
  theme,
  isLoading,
  loadError,
  isSaving,
  dirty,
  onChange,
  onSave,
  onRestore,
  onClose,
  onRetry,
}: MonacoEditorPaneProps) {
  // 最新 onSave 引用：编辑器命令闭包在挂载时捕获，直用 props 会读到过期函数
  const onSaveRef = useRef(onSave)
  useEffect(() => {
    onSaveRef.current = onSave
  })

  /**
   * 编辑器挂载后注册 Ctrl+S（覆盖浏览器「保存网页」默认行为）。
   * 卸载移除语义：addCommand 仅返回命令 ID（string|null），无公开移除 API；
   * 动态键盘绑定作用域随编辑器实例——组件卸载时 @monaco-editor/react 销毁编辑器，
   * 绑定随之移除，无悬挂命令
   */
  const handleMount = (
    editor: monaco.editor.IStandaloneCodeEditor,
    monacoInstance: typeof monaco,
  ) => {
    editor.addCommand(
      monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyS,
      () => onSaveRef.current(),
    )
  }

  // 编辑器字体跟随 --mcs-font-mono token（Monaco options 需具体字体串，挂载时读取一次；
  // jsdom/SSR 取不到 token 时回退通用等宽栈）
  const monoFont = useMemo(() => {
    if (typeof document === 'undefined') return ''
    return (
      getComputedStyle(document.documentElement).getPropertyValue('--mcs-font-mono').trim() ||
      "'JetBrains Mono', ui-monospace, monospace"
    )
  }, [])

  // 空态：未选中文件
  if (!path) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-mcs-bg-subtle">
        <FileEdit className="size-6 text-mcs-text-muted" aria-hidden />
        <p className="text-mcs-sm text-mcs-text-muted">选择文件进行编辑</p>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ── 头部条：文件名 + encoding 徽章 + 脏标记 + 关闭 + 保存 ── */}
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-mcs-border-muted px-3">
        <span
          title={path}
          className="min-w-0 flex-1 truncate font-mono text-mcs-sm text-mcs-text-default"
        >
          {fileNameOf(path)}
        </span>
        {!isLoading && (
          <span className="rounded-mcs-xs border border-mcs-border-muted bg-mcs-bg-muted px-1.5 py-px font-mono text-mcs-2xs font-semibold text-mcs-text-muted">
            {encoding === 'utf-8' ? 'UTF-8' : 'GBK'}
          </span>
        )}
        {dirty && (
          <span className="rounded-mcs-xs border border-mcs-warning-border bg-mcs-warning-bg-subtle px-1.5 py-px text-mcs-2xs font-semibold text-mcs-warning-fg">
            未保存
          </span>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={onRestore}
          disabled={!dirty || isSaving || isLoading || Boolean(loadError)}
          title={dirty ? '回滚到上次保存版本' : '内容未修改，无需恢复'}
        >
          <RotateCcw aria-hidden />
          恢复
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="关闭编辑器"
          title="关闭编辑器"
          onClick={onClose}
        >
          <X aria-hidden />
        </Button>
        <Button
          size="sm"
          onClick={onSave}
          disabled={!dirty || isSaving || isLoading || Boolean(loadError)}
          title={dirty ? '保存（Ctrl+S）' : '内容未修改，无需保存'}
        >
          <Save aria-hidden />
          {isSaving ? '保存中…' : '保存'}
          <kbd className="rounded-mcs-xs border border-mcs-border-muted bg-mcs-bg-muted px-1 font-mono text-mcs-2xs text-mcs-text-muted">
            Ctrl+S
          </kbd>
        </Button>
      </header>

      {/* ── 内容区：加载 → 错误 → 编辑器 ── */}
      {isLoading ? (
        <div
          role="status"
          aria-label="正在加载文件内容"
          className="flex h-full flex-col gap-3 bg-mcs-bg-subtle p-4"
        >
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-full" />
        </div>
      ) : loadError ? (
        <div
          role="alert"
          className="flex h-full flex-col items-center justify-center gap-3 bg-mcs-bg-subtle px-6"
        >
          <X className="size-6 text-mcs-error-fg" aria-hidden />
          <p className="max-w-md text-center text-mcs-sm text-mcs-text-muted">{loadError}</p>
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RotateCcw aria-hidden />
            重试
          </Button>
        </div>
      ) : (
        <div className="min-h-0 flex-1 bg-mcs-bg-subtle">
          <Editor
            path={path}
            language={languageForFile(path)}
            value={content}
            theme={theme === 'dark' ? 'mcs-dark' : 'vs'}
            loading={null}
            options={{
              // 长行横向滚动（Monaco 默认 wordWrap off，此处显式声明契约）
              wordWrap: 'off',
              // 简约克制：禁小地图
              minimap: { enabled: false },
              // 底部不留滚动余量
              scrollBeyondLastLine: false,
              // 编辑器字体跟随 --mcs-font-mono token
              fontFamily: monoFont,
            }}
            onChange={(value) => onChange(value ?? '')}
            onMount={handleMount}
          />
        </div>
      )}
    </div>
  )
}
