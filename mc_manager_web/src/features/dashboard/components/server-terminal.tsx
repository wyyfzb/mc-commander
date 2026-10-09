import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon, type ISearchDecorationOptions } from '@xterm/addon-search'
// 官方 CSS 必须引入：缺失会导致测量元素可见（32 个问号乱码行）+ 光标/选区样式缺失
import '@xterm/xterm/css/xterm.css'
import {
  ChevronDown,
  ChevronUp,
  Download,
  Eraser,
  Eye,
  EyeOff,
  Loader2,
  Search,
  TerminalSquare,
  Copy,
  Check,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { IconButton } from '@/components/mcs/icon-button'
import { InstanceControls } from '@/features/dashboard/components/instance-controls'
import { useTerminalStore } from '@/stores/terminal'
import { useServerStore } from '@/stores/server'
import { useConnectionStore } from '@/stores/connection'
import { useInstanceLogs } from '@/api/queries'
import { apiGet } from '@/api/client'
import { getFriendlyErrorText } from '@/api/errors'
import { formatLogFileName } from '@/lib/format'
import { primaryModifierLabel } from '@/lib/platform'
import { copyText } from '@/lib/clipboard'
import { useUiStore } from '@/stores/ui'
import type { LogEntry } from '@/api/types'
import type { LogLevel, TerminalLogEntry } from '@/lib/terminal-log'

/**
 * ServerTerminal —— xterm 终端（business 组件）
 * - 独立深底（--mcs-bg-subtle）+ 等宽；级别四色编码（无文字前缀，仅颜色）
 * - 缓冲 2000 条（store，切页不丢）；自动滚动（上滚 >60px 暂停）
 * - JVM 警告默认隐藏（眼睛切换）；清空；下载日志；终端内搜索
 *   （放大镜 / Ctrl/⌘+F 打开，SearchAddon 装饰高亮 + n/m 计数，Esc 关闭清除回焦点）
 */

/** 级别 → ANSI 前景色序号（xterm theme 调色板映射 token） */
const LEVEL_ANSI: Record<LogLevel, number> = {
  INFO: 37,
  WARN: 33,
  ERROR: 31,
  INPUT: 32,
}
/** 警示级加粗（视觉低项：WARN 黄色与 INFO 同重，粗体提升警示权重） */
const BOLD_LEVELS = new Set<LogLevel>(['WARN'])

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || undefined!
}

/** 终端主题与主主题解耦：独立深底 token（设计文档 4.6，亮暗同值；级别色用深底变体） */
function buildXtermTheme() {
  const accent = cssVar('--mcs-terminal-accent')
  const error = cssVar('--mcs-terminal-error')
  const warning = cssVar('--mcs-terminal-warning')
  const text = cssVar('--mcs-terminal-fg')
  const bg = cssVar('--mcs-terminal-bg')
  const subtle = cssVar('--mcs-terminal-subtle')
  const palette = Array.from({ length: 16 }, () => text)
  palette[31] = error
  palette[33] = warning
  palette[32] = accent
  palette[37] = text
  palette[8] = subtle
  return {
    background: bg,
    foreground: text,
    cursor: accent,
    cursorAccent: bg,
    selectionBackground: subtle,
    ansi: palette as unknown as string[],
  }
}

/** 屏读镜像：保留最近 N 行纯文本，供 aria-live 推送给屏幕阅读器 */
const SR_LINE_COUNT = 20

/**
 * 搜索装饰颜色（canvas 绘制需具体色值，cssVar 取 token 运行时值）：
 * 当前命中 accent 亮显、其余命中 subtle 弱显；overview ruler 两色对应（addon 要求必填）
 */
function buildSearchDecorations(): ISearchDecorationOptions {
  const accent = cssVar('--mcs-terminal-accent')
  const subtle = cssVar('--mcs-terminal-subtle')
  return {
    matchBackground: subtle,
    matchOverviewRuler: subtle,
    activeMatchBackground: accent,
    activeMatchColorOverviewRuler: accent,
  }
}

/** 搜索结果计数（addon resultIndex 从 0 起；-1 表示超过 highlightLimit 阈值） */
interface SearchResult {
  resultIndex: number
  resultCount: number
}

export function ServerTerminal({
  isLoading = false,
  headerNotice,
}: {
  isLoading?: boolean
  /**
   * 工具条左侧的附加内容（如崩溃指引条）：工具条高度固定，塞进来不占额外高度。
   * 契约：内容必须自己按本卡的容器宽（本卡已声明 `@container`）决定窄容器下的表现——
   * 工具条不换行，塞不下的内容会盖到右侧图标按钮上。
   */
  headerNotice?: ReactNode
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const renderedCountRef = useRef(0)
  const autoScrollRef = useRef(true)
  const srLiveRef = useRef<HTMLDivElement>(null)
  const theme = useUiStore((s) => s.theme)
  const autoScrollEnabled = useUiStore((s) => s.terminalAutoScroll)
  // onScroll 注册于 mount effect，闭包捕获首渲染值——ref 同步最新偏好
  const autoScrollEnabledRef = useRef(autoScrollEnabled)
  // eslint-disable-next-line react/refs -- latest-ref 模式：滚动处理器闭包读最新偏好，避免反复注销重挂
  autoScrollEnabledRef.current = autoScrollEnabled
  const buffer = useTerminalStore((s) => s.buffer)
  const pushNothing = useTerminalStore((s) => s.setInstance)
  const clearTerminal = useTerminalStore((s) => s.clear)
  const fillHistory = useTerminalStore((s) => s.fillHistory)
  const instanceId = useServerStore((s) => s.instanceId)
  const isRunning = useServerStore((s) => s.status?.isRunning ?? false)
  const config = useConnectionStore()
  const [showJvmWarnings, setShowJvmWarnings] = useState(false)
  // 眼睛开关 latest-ref：增量渲染 effect 内检测切换 → 全量重写（闭包读最新值）
  const showJvmWarningsRef = useRef(showJvmWarnings)
  const [downloading, setDownloading] = useState(false)
  const [copied, setCopied] = useState(false)
  // 终端内搜索（SearchAddon；canvas 渲染下浏览器原生 Ctrl/⌘+F 对终端内容无效）
  // 状态收敛单对象：实例切换时在渲染期整体重置（React 官方 adjusting-state 模式，避免 effect 级联 setState）
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const [search, setSearch] = useState<{
    open: boolean
    query: string
    result: SearchResult | null
  }>({ open: false, query: '', result: null })
  const [searchInstanceId, setSearchInstanceId] = useState(instanceId)
  if (searchInstanceId !== instanceId) {
    setSearchInstanceId(instanceId)
    setSearch({ open: false, query: '', result: null })
  }

  // 历史日志（组件挂载时回填，store 去重）
  const logsQuery = useInstanceLogs(instanceId ?? '', 200)
  useEffect(() => {
    if (instanceId && logsQuery.data) {
      fillHistory(instanceId, logsQuery.data)
    }
  }, [instanceId, logsQuery.data, fillHistory])

  // 实例切换 → store 清空旧缓冲；xterm 必须同步 clear + 重置增量计数，
  // 否则 buffer 归零瞬间「等待服务器日志」占位浮在旧实例日志上重叠，
  // 且旧日志残留污染新实例视图（fillHistory 回填后从 0 重渲染）
  useEffect(() => {
    pushNothing(instanceId)
    searchAddonRef.current?.clearDecorations()
    const term = xtermRef.current
    if (term) {
      term.clear()
      renderedCountRef.current = 0
    }
  }, [instanceId, pushNothing])

  // xterm 初始化（一次）
  useEffect(() => {
    if (!containerRef.current) return
    const term = new Terminal({
      convertEol: true,
      fontSize: 12,
      fontFamily: "'JetBrains Mono', ui-monospace, Consolas, monospace",
      lineHeight: 1.4,
      theme: buildXtermTheme(),
      scrollback: 2000,
      allowProposedApi: true,
      screenReaderMode: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    const searchAddon = new SearchAddon()
    term.loadAddon(searchAddon)
    searchAddon.onDidChangeResults((r) =>
      setSearch((s) => ({
        ...s,
        result: { resultIndex: r.resultIndex, resultCount: r.resultCount },
      })),
    )
    // Ctrl/⌘+F：仅终端聚焦时生效（attachCustomKeyEventHandler 只在 xterm 持有焦点时触发，
    // dashboard 其他区域浏览器原生查找不受影响）。canvas 渲染下原生 Ctrl/⌘+F 对终端内容
    // 无法命中，preventDefault 抑制浏览器查找弹窗并转为打开终端内搜索。
    term.attachCustomKeyEventHandler((e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setSearch((s) => ({ ...s, open: true }))
        return false
      }
      return true
    })
    term.open(containerRef.current)
    fit.fit()
    xtermRef.current = term
    fitRef.current = fit
    searchAddonRef.current = searchAddon

    const onResize = () => fit.fit()
    window.addEventListener('resize', onResize)
    // 容器尺寸变化同样要 refit：停止状态条显隐会挤压终端区高度而 window 不变，
    // 画布保持旧高度会溢出容器，绝对定位层盖住状态条（实测）
    const ro = new ResizeObserver(() => fit.fit())
    ro.observe(containerRef.current)

    // 自动滚动：用户上滚 >60px 暂停，回到底部恢复；偏好关闭（B5）则恒不跟随
    term.onScroll(() => {
      if (!autoScrollEnabledRef.current) {
        autoScrollRef.current = false
        return
      }
      const maxScroll = term.buffer.active.baseY + term.buffer.active.cursorY - term.rows
      autoScrollRef.current = maxScroll - term.buffer.active.viewportY < 3
    })

    return () => {
      window.removeEventListener('resize', onResize)
      ro.disconnect()
      // addon 随 term.dispose 一并释放；refs 同步置空避免悬垂
      term.dispose()
      xtermRef.current = null
      fitRef.current = null
      searchAddonRef.current = null
    }
  }, [])

  // 主题变化：重建 xterm 调色板
  useEffect(() => {
    const term = xtermRef.current
    if (!term) return
    term.options.theme = buildXtermTheme()
  }, [theme])

  // 缓冲增量渲染；眼睛开关切换 → 清屏 + 从头按新过滤态全量重写。
  // （原独立切换 effect 只 clear 不重写，切换后历史行不回填、
  // 终端空白直到下一条新日志到达——现合并到同一 effect，切换即重写）
  useEffect(() => {
    const term = xtermRef.current
    if (!term) return
    // 缓冲归零联动清屏：启动/重启路径经 store.resetForRestart 清缓冲，
    // xterm 画布必须同步清——否则当次运行的新日志追加在上一轮渲染行后残留
    if (buffer.length === 0 && renderedCountRef.current > 0) {
      term.clear()
      renderedCountRef.current = 0
    }
    if (showJvmWarningsRef.current !== showJvmWarnings) {
      showJvmWarningsRef.current = showJvmWarnings
      term.clear()
      renderedCountRef.current = 0
    }
    const rendered = renderedCountRef.current
    if (buffer.length === rendered) return

    for (let i = rendered; i < buffer.length; i++) {
      const entry = buffer[i] as TerminalLogEntry
      if (entry.jvmWarning && !showJvmWarnings) continue
      const ansi = LEVEL_ANSI[entry.level]
      const bold = BOLD_LEVELS.has(entry.level) ? '1;' : ''
      term.write(`\x1b[${bold}${ansi}m${entry.text}\x1b[0m\r\n`)
    }
    renderedCountRef.current = buffer.length
    if (autoScrollRef.current) {
      term.scrollToBottom()
    }
    // 同步屏读镜像：取最近 N 行纯文本
    if (srLiveRef.current) {
      const allVisible = buffer
        .filter((e) => {
          const entry = e as TerminalLogEntry
          return !(entry.jvmWarning && !showJvmWarnings)
        })
        .map((e) => (e as TerminalLogEntry).text)
      srLiveRef.current.textContent = allVisible.slice(-SR_LINE_COUNT).join('\n')
    }
  }, [buffer, showJvmWarnings])

  // 清空（工具栏按钮 + Ctrl/⌘+L 共用）
  const handleClear = useCallback(() => {
    clearTerminal()
    xtermRef.current?.clear()
    renderedCountRef.current = 0
    // 缓冲已清空，搜索高亮/计数随之失效
    searchAddonRef.current?.clearDecorations()
    setSearch((s) => ({ ...s, result: null }))
  }, [clearTerminal])

  // 复制终端内容（选中区域优先，无选中则复制全部缓冲）
  const handleCopy = useCallback(() => {
    const term = xtermRef.current
    if (!term) return
    const selection = term.getSelection()
    const text = selection || buffer.map((e) => (e as TerminalLogEntry).text).join('\n')
    if (!text) {
      toast.info('暂无内容可复制', { duration: 1500 })
      return
    }
    // copyText 统一入口：内部降级 execCommand 且绝不抛异常（消除未捕获同步异常冒泡至 ErrorBoundary 的路径）
    void copyText(text).then((ok) => {
      if (ok) {
        setCopied(true)
        toast.success('已复制到剪贴板', { duration: 1500 })
        setTimeout(() => setCopied(false), 1500)
      } else {
        toast.error('复制失败，请手动复制')
      }
    })
  }, [buffer])

  // Ctrl/⌘+L 清屏（P0 服主肌肉记忆；window capture 覆盖输入框焦点，dashboard 内任意位置生效）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
        e.preventDefault()
        handleClear()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [handleClear])

  // 终端内搜索：装饰高亮 + n/m 计数（onDidChangeResults 驱动）；Esc 关闭并清除恢复焦点
  const handleSearchNext = useCallback(() => {
    const addon = searchAddonRef.current
    const q = search.query.trim()
    if (!addon || !q) return
    addon.findNext(q, { decorations: buildSearchDecorations() })
  }, [search.query])

  const handleSearchPrev = useCallback(() => {
    const addon = searchAddonRef.current
    const q = search.query.trim()
    if (!addon || !q) return
    addon.findPrevious(q, { decorations: buildSearchDecorations() })
  }, [search.query])

  const handleSearchClose = useCallback(() => {
    setSearch((s) => ({ ...s, open: false, result: null }))
    searchAddonRef.current?.clearDecorations()
    xtermRef.current?.focus()
  }, [])

  // 下载日志
  const handleDownload = async () => {
    if (!instanceId) {
      toast.error('未连接服务器')
      return
    }
    if (downloading) return
    setDownloading(true)
    try {
      const logs = await apiGet<LogEntry[]>(
        `/api/v1/instances/${instanceId}/logs?lines=1000`,
        config,
      )
      if (logs.length === 0) {
        toast.info('暂无日志可下载')
        return
      }
      const header =
        `MC Commander - 服务器日志\n导出时间: ${new Date().toLocaleString()}\n实例: ${instanceId}\n` +
        '='.repeat(60) +
        '\n'
      const body = logs.map((l) => `[${l.type}] ${l.text}`).join('\n')
      const blob = new Blob([header + body], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = formatLogFileName()
      a.click()
      URL.revokeObjectURL(url)
      toast.success('日志已保存到本地')
    } catch (err) {
      toast.error(`日志下载失败：${getFriendlyErrorText(err)}`)
    } finally {
      setDownloading(false)
    }
  }

  return (
    /* min-h-[60vh] 是单列布局的高度下限（窄屏堆叠时给终端一个可用高度）；
       与 dashboard-page 的分栏同档切到 min-h-0——分栏后终端改为吃满剩余高度 */
    <section
      data-testid="server-terminal"
      className="@container animate-mcs-fade-up mcs-delay-4 flex min-h-[60vh] flex-1 flex-col overflow-hidden rounded-mcs-md border border-mcs-border-muted shadow-mcs-card @5xl:min-h-0"
      style={{ background: 'var(--mcs-terminal-bg)' }}
    >
      {/* 工具栏（实底，玻璃禁区内） */}
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-mcs-border-muted bg-mcs-bg-muted px-2">
        <div className="flex min-w-0 items-center gap-2">
          <InstanceControls />
          {/* 宽容器下才渲染：工具条固定 h-10 且不换行，空间不够时内联内容会溢出到右侧图标按钮
              **底下**（实测 375/480 下点「看诊断」落到「显示 JVM 警告」）。门槛由提示条自己按
              本卡宽度判（见 CrashPointerNotice 的 @[750px]），插槽不替它定档 */}
          {headerNotice}
        </div>
        <div className="flex items-center gap-1">
          <IconButton
            tooltip={`搜索终端内容（${primaryModifierLabel()}+F）`}
            tooltipSide="bottom"
            onClick={() => setSearch((s) => ({ ...s, open: !s.open }))}
            aria-label="搜索终端内容"
            aria-pressed={search.open}
          >
            <Search aria-hidden />
          </IconButton>
          <IconButton
            tooltip={showJvmWarnings ? '隐藏 JVM 警告' : '显示 JVM 警告'}
            tooltipSide="bottom"
            onClick={() => setShowJvmWarnings((v) => !v)}
            aria-label={showJvmWarnings ? '隐藏 JVM 警告' : '显示 JVM 警告'}
          >
            {showJvmWarnings ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
          </IconButton>
          <IconButton
            tooltip="复制终端内容"
            tooltipSide="bottom"
            onClick={handleCopy}
            aria-label="复制终端内容"
          >
            {copied ? <Check className="text-mcs-success-fg" aria-hidden /> : <Copy aria-hidden />}
          </IconButton>
          <IconButton
            tooltip="清空终端"
            tooltipSide="bottom"
            onClick={handleClear}
            aria-label="清空终端"
          >
            <Eraser aria-hidden />
          </IconButton>
          <IconButton
            tooltip="下载日志"
            tooltipSide="bottom"
            onClick={() => void handleDownload()}
            disabled={downloading}
            aria-label="下载日志"
          >
            {downloading ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : (
              <Download aria-hidden />
            )}
          </IconButton>
        </div>
      </div>

      {/* 终端区 */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {/* 搜索条（右上浮层）：Enter/下按钮向后、Shift+Enter/上按钮向前、Esc 关闭清除高亮回焦点终端 */}
        {search.open && (
          <div
            role="search"
            aria-label="终端内容搜索"
            className="absolute right-2 top-2 z-(--mcs-z-local) flex items-center gap-1 rounded-mcs-md border border-mcs-border-muted bg-popover p-1 shadow-mcs-raised"
          >
            <Input
              value={search.query}
              onChange={(e) => {
                const v = e.target.value
                setSearch((s) => ({ ...s, query: v, result: null }))
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  if (e.shiftKey) handleSearchPrev()
                  else handleSearchNext()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  handleSearchClose()
                }
              }}
              placeholder="搜索终端内容..."
              aria-label="搜索终端内容"
              className="h-7 w-44 text-mcs-xs"
              autoFocus
            />
            <span
              className="min-w-12 text-center text-mcs-xs tabular-nums text-mcs-text-muted"
              aria-live="polite"
            >
              {search.result
                ? search.result.resultCount === 0
                  ? '无结果'
                  : search.result.resultIndex < 0
                    ? `${search.result.resultCount}+`
                    : `${search.result.resultIndex + 1}/${search.result.resultCount}`
                : search.query.trim()
                  ? '—'
                  : ''}
            </span>
            <IconButton onClick={handleSearchPrev} aria-label="上一个结果">
              <ChevronUp aria-hidden />
            </IconButton>
            <IconButton onClick={handleSearchNext} aria-label="下一个结果">
              <ChevronDown aria-hidden />
            </IconButton>
            <IconButton onClick={handleSearchClose} aria-label="关闭搜索">
              <X aria-hidden />
            </IconButton>
          </div>
        )}
        {/* 屏读镜像：aria-live 区域，屏幕阅读器可朗读最近 N 行终端输出 */}
        <div
          ref={srLiveRef}
          data-testid="sr-live-mirror"
          aria-live="polite"
          aria-atomic="false"
          aria-label="终端输出"
          className="sr-only"
        />
        <div ref={containerRef} className="absolute inset-0 p-2" data-testid="xterm-container" />
        {isLoading && buffer.length === 0 ? (
          // B17 首屏骨架：日志未到前占位（xterm 已挂载，日志到达自动替换）
          <div
            className="pointer-events-none absolute inset-0 flex flex-col gap-2.5 p-4"
            role="status"
            aria-label="终端加载中"
          >
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-3.5" style={{ width: `${38 + ((i * 17) % 55)}%` }} />
            ))}
          </div>
        ) : buffer.length === 0 ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 text-mcs-text-muted">
            <TerminalSquare className="size-4" aria-hidden />
            <span className="text-mcs-xs">等待服务器日志...</span>
          </div>
        ) : null}
      </div>
      {/* 停止状态条：随 isRunning 显隐的 DOM 元素而非 xterm 画布内容——
          画布只追加不可擦除，旧实现把标记行写进画布，刷新时 isRunning
          短暂为 false 的竞态会让「运行中」实例永久残留停止标记（实测） */}
      {!isRunning && buffer.length > 0 && (
        <div
          className="shrink-0 border-t border-mcs-border-muted bg-mcs-bg-muted px-3 py-1.5 text-center text-mcs-2xs italic text-mcs-text-muted"
          role="status"
        >
          —— 实例已停止，以上为最后日志 ——
        </div>
      )}
    </section>
  )
}
