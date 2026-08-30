import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
// 官方 CSS 必须引入：缺失会导致测量元素可见（32 个问号乱码行）+ 光标/选区样式缺失
import '@xterm/xterm/css/xterm.css'
import { Download, Eraser, Eye, EyeOff, Loader2, TerminalSquare, Copy, Check } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { InstanceControls } from '@/features/dashboard/components/instance-controls'
import { useTerminalStore } from '@/stores/terminal'
import { useServerStore } from '@/stores/server'
import { useConnectionStore } from '@/stores/connection'
import { useInstanceLogs } from '@/api/queries'
import { apiGet } from '@/api/client'
import { ApiError } from '@/api/client'
import { getFriendlyErrorMessage } from '@/api/errors'
import { formatLogFileName } from '@/lib/format'
import { useUiStore } from '@/stores/ui'
import type { LogEntry } from '@/api/types'
import type { LogLevel, TerminalLogEntry } from '@/lib/terminal-log'

/**
 * ServerTerminal —— xterm 终端（business 组件）
 * - 独立深底（--mcs-bg-subtle）+ 等宽；级别四色编码（无文字前缀，仅颜色）
 * - 缓冲 2000 条（store，切页不丢）；自动滚动（上滚 >60px 暂停）
 * - JVM 警告默认隐藏（眼睛切换）；清空；下载日志
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

export function ServerTerminal({ isLoading = false }: { isLoading?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const renderedCountRef = useRef(0)
  const autoScrollRef = useRef(true)
  const theme = useUiStore((s) => s.theme)
  const autoScrollEnabled = useUiStore((s) => s.terminalAutoScroll)
  // onScroll 注册于 mount effect，闭包捕获首渲染值——ref 同步最新偏好
  const autoScrollEnabledRef = useRef(autoScrollEnabled)
  autoScrollEnabledRef.current = autoScrollEnabled
  const buffer = useTerminalStore((s) => s.buffer)
  const pushNothing = useTerminalStore((s) => s.setInstance)
  const clearTerminal = useTerminalStore((s) => s.clear)
  const fillHistory = useTerminalStore((s) => s.fillHistory)
  const instanceId = useServerStore((s) => s.instanceId)
  const isRunning = useServerStore((s) => s.status?.isRunning ?? false)
  const config = useConnectionStore()
  const [showJvmWarnings, setShowJvmWarnings] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [copied, setCopied] = useState(false)

  // 历史日志（组件挂载时回填，store 去重）
  const logsQuery = useInstanceLogs(instanceId ?? '', 200)
  useEffect(() => {
    if (instanceId && logsQuery.data) {
      fillHistory(instanceId, logsQuery.data)
    }
  }, [instanceId, logsQuery.data, fillHistory])

  // 实例切换 → store 清空旧缓冲
  useEffect(() => {
    pushNothing(instanceId)
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
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)
    fit.fit()
    xtermRef.current = term
    fitRef.current = fit

    const onResize = () => fit.fit()
    window.addEventListener('resize', onResize)

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
      term.dispose()
      xtermRef.current = null
    }
  }, [])

  // 主题变化：重建 xterm 调色板
  useEffect(() => {
    const term = xtermRef.current
    if (!term) return
    term.options.theme = buildXtermTheme()
  }, [theme])

  // 缓冲增量渲染
  useEffect(() => {
    const term = xtermRef.current
    if (!term) return
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
  }, [buffer, showJvmWarnings])

  // 眼睛切换：全量重渲染
  useEffect(() => {
    const term = xtermRef.current
    if (!term) return
    term.clear()
    renderedCountRef.current = 0
    // 触发上方增量渲染 effect：主动刷一次
    const rendered = 0
    void rendered
  }, [showJvmWarnings])

  // 停止标记行：实例停止且缓冲非空时追加
  const stoppedMarkRef = useRef(false)
  useEffect(() => {
    const term = xtermRef.current
    if (!term) return
    if (!isRunning && buffer.length > 0 && !stoppedMarkRef.current) {
      term.write('\x1b[3m—— 实例已停止，以上为最后日志 ——\x1b[0m\r\n')
      stoppedMarkRef.current = true
    }
    if (isRunning) stoppedMarkRef.current = false
  }, [isRunning, buffer.length])

  // 清空（工具栏按钮 + Ctrl+L 共用）
  const handleClear = useCallback(() => {
    clearTerminal()
    xtermRef.current?.clear()
    renderedCountRef.current = 0
    stoppedMarkRef.current = false
  }, [clearTerminal])

  // 复制终端内容（选中区域优先，无选中则复制全部缓冲）
  const handleCopy = useCallback(() => {
    const term = xtermRef.current
    if (!term) return
    const selection = term.getSelection()
    const text = selection || buffer.map((e) => (e as TerminalLogEntry).text).join('\n')
    if (!text) {
      toast.info('暂无内容可复制')
      return
    }
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true)
        toast.success('已复制到剪贴板')
        setTimeout(() => setCopied(false), 1500)
      },
      () => toast.error('复制失败'),
    )
  }, [buffer])

  // Ctrl+L 清屏（P0 服主肌肉记忆；window capture 覆盖输入框焦点，dashboard 内任意位置生效）
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
        '='.repeat(60) + '\n'
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
      toast.error(
        err instanceof ApiError
          ? `日志下载失败: ${getFriendlyErrorMessage(err.code, err.message)}`
          : '日志下载失败',
      )
    } finally {
      setDownloading(false)
    }
  }

  return (
    <section
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-mcs-md border border-mcs-border-muted"
      style={{ background: 'var(--mcs-terminal-bg)' }}
    >
      {/* 工具栏（实底，玻璃禁区内） */}
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-mcs-border-muted bg-mcs-bg-muted px-2">
        <InstanceControls compact />
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={() => setShowJvmWarnings((v) => !v)} aria-label={showJvmWarnings ? '隐藏 JVM 警告' : '显示 JVM 警告'}>
                {showJvmWarnings ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{showJvmWarnings ? '隐藏 JVM 警告' : '显示 JVM 警告'}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={handleCopy} aria-label="复制终端内容">
                {copied ? <Check className="text-mcs-success-fg" aria-hidden /> : <Copy aria-hidden />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">复制终端内容</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={handleClear} aria-label="清空终端">
                <Eraser aria-hidden />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">清空终端</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={() => void handleDownload()} disabled={downloading} aria-label="下载日志">
                {downloading ? <Loader2 className="animate-spin" aria-hidden /> : <Download aria-hidden />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">下载日志</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* 终端区 */}
      <div className="relative min-h-0 flex-1">
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
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 text-mcs-text-subtle">
            <TerminalSquare className="size-4" aria-hidden />
            <span className="text-mcs-xs">等待服务器日志...</span>
          </div>
        ) : null}
      </div>
    </section>
  )
}
