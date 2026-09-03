import { useEffect, useRef, useState } from 'react'
import { ArrowRight, Check, Play, Send, ShieldAlert, Star, X } from 'lucide-react'
import { toast } from 'sonner'
import { useMutation } from '@tanstack/react-query'
import { IconButton } from '@/components/mcs/icon-button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { apiPost } from '@/api/client'
import { ApiError } from '@/api/client'
import { getFriendlyErrorText } from '@/api/errors'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'
import { useTerminalStore } from '@/stores/terminal'
import { useCommandBus } from '@/stores/command-bus'
import { colorForCommand, completeCommands, iconForCommand, type CompletionItem } from '@/lib/mc-commands'
import { NoticeBanner } from '@/components/mcs/notice-banner'

/**
 * 命令输入行
 * - `>` 前缀 + 回车/按钮发送；RCON 响应非空时插入终端（INFO 级）
 * - / 开头触发补全（命令名前缀 / 参数子串，最多 10 条）
 * - ↑↓ 翻命令历史（localStorage 持久化；连续重复去重；导航中保留草稿）
 * - 快捷 chips：5 默认 + 持久化（localStorage），播放=立即发送，点主体=仅填充，X=删除
 * - RCON 未启用时显示降级横幅
 */

const PRESET_STORAGE_KEY = 'mcs-command-presets'
const HISTORY_STORAGE_KEY = 'mcs-command-history'
const HISTORY_STATUS_KEY = 'mcs-command-history-status'
const HISTORY_LIMIT = 50

/** 命令历史条目状态 */
type CommandStatus = 'sent' | 'failed'

/** 命令历史状态映射（command → status/error） */
function readCommandStatusMap(): Record<string, { status: CommandStatus; error?: string }> {
  try {
    const raw = localStorage.getItem(HISTORY_STATUS_KEY)
    if (raw) return JSON.parse(raw)
  } catch {
    // 回退空
  }
  return {}
}

function writeCommandStatusMap(map: Record<string, { status: CommandStatus; error?: string }>) {
  try {
    // 只保留历史中存在的命令状态
    const history = readCommandHistory()
    const activeKeys = new Set(history)
    const trimmed: Record<string, { status: CommandStatus; error?: string }> = {}
    for (const [k, v] of Object.entries(map)) {
      if (activeKeys.has(k)) trimmed[k] = v
    }
    localStorage.setItem(HISTORY_STATUS_KEY, JSON.stringify(trimmed))
  } catch {
    // localStorage 不可用时静默忽略
  }
}
const DEFAULT_PRESETS = [
  'give @p diamond 64',
  'gamemode creative',
  'time set day',
  'tp @p 0 100 0',
  'kill @e[type=!player]',
]

function readPresets(): string[] {
  try {
    const raw = localStorage.getItem(PRESET_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as string[]
      if (Array.isArray(parsed)) return parsed
    }
  } catch {
    // 回退默认
  }
  return DEFAULT_PRESETS
}

function readCommandHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as string[]
      if (Array.isArray(parsed)) return parsed.slice(-HISTORY_LIMIT)
    }
  } catch {
    // 回退空历史
  }
  return []
}

function writeCommandHistory(history: string[]) {
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history.slice(-HISTORY_LIMIT)))
  } catch {
    // localStorage 不可用时静默忽略
  }
}

export function CommandInput() {
  const config = useConnectionStore()
  const instanceId = useServerStore((s) => s.instanceId)
  const isRunning = useServerStore((s) => s.status?.isRunning ?? false)
  const isRconConnected = useServerStore((s) => s.status?.isRconConnected ?? false)
  const pushEntry = useTerminalStore((s) => s.pushEntry)
  const [value, setValue] = useState('')
  const [presets, setPresets] = useState<string[]>(readPresets)
  const [sending, setSending] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  /** 持久化命令历史（localStorage；发送成功入列；连续重复合并） */
  const historyRef = useRef<string[]>(readCommandHistory())
  /** 历史条目状态映射（command → sent/failed + error） */
  const statusMapRef = useRef(readCommandStatusMap())
  /** 历史导航态：index=当前条目、draft=进入导航前的未发送输入 */
  const navRef = useRef<{ index: number; draft: string } | null>(null)
  /** 导航中当前条目的状态（用于显示状态指示器） */
  const [navStatus, setNavStatus] = useState<{ status: CommandStatus; error?: string } | null>(null)

  const completions: CompletionItem[] = value.startsWith('/') ? completeCommands(value) : []

  // 注册命令总线 overlayRunner（Cmd+K 命令域执行入口；终端回显，优先级高于全局 baseRunner）
  const setOverlayRunner = useCommandBus((s) => s.setOverlayRunner)
  useEffect(() => {
    setOverlayRunner((cmd) => send(cmd))
    return () => setOverlayRunner(null)
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- send 是组件内普通函数（非 useCallback），每次渲染新引用，加入会每帧重注册 runner
  }, [instanceId, isRunning])

  const mutation = useMutation({
    mutationFn: async (command: string) => {
      if (!instanceId) throw new ApiError(40401, 404, 'Instance not found', null)
      return apiPost<unknown>(`/api/v1/instances/${instanceId}/command`, config, { command })
    },
    onSuccess: (response, command) => {
      // RCON 响应非空 → 手动插入终端（INFO 级；服务端日志不含 RCON 输出）
      const text = typeof response === 'string' && response.trim()
        ? response.trim()
        : (response as { response?: string } | null)?.response?.trim()
      if (text && instanceId) {
        pushEntry(instanceId, text, 'stdout')
      }
      pushHistory(command, 'sent')
      // 成功不弹 toast：终端已有 command + stdout 回显（失败仍 toast 告警）
      setValue('')
      setNavStatus(null)
      navRef.current = null
      inputRef.current?.focus()
    },
    onError: (err, command) => {
      const friendly = getFriendlyErrorText(err)
      pushHistory(command, 'failed', friendly)
      toast.error(`命令发送失败：${friendly}`)
    },
  })

  const send = (command: string) => {
    const trimmed = command.trim()
    if (!trimmed) return
    setSending(true)
    mutation.mutate(trimmed, { onSettled: () => setSending(false) })
  }

  /** 入列历史（shell 语义：与最近一条相同则跳过；超出上限裁头；同步写入 localStorage） */
  const pushHistory = (command: string, status: CommandStatus = 'sent', error?: string) => {
    const h = historyRef.current
    if (h[h.length - 1] === command) {
      // 重复命令仅更新状态
      statusMapRef.current[command] = { status, error }
      writeCommandStatusMap(statusMapRef.current)
      return
    }
    const next = [...h, command].slice(-HISTORY_LIMIT)
    historyRef.current = next
    writeCommandHistory(next)
    statusMapRef.current[command] = { status, error }
    writeCommandStatusMap(statusMapRef.current)
  }

  /** ↑↓ 历史导航：↑ 上移，↓ 下移；↓ 越过最新恢复草稿；任何编辑退出导航 */
  const navigateHistory = (dir: 'up' | 'down') => {
    const h = historyRef.current
    if (dir === 'up') {
      if (h.length === 0) return
      if (navRef.current == null) navRef.current = { index: h.length - 1, draft: value }
      else if (navRef.current.index > 0) navRef.current.index -= 1
      const nav = navRef.current
      const cmd = h[nav.index] ?? ''
      setValue(cmd)
      setNavStatus(statusMapRef.current[cmd] ?? null)
    } else {
      const nav = navRef.current
      if (nav == null) return
      if (nav.index < h.length - 1) {
        nav.index += 1
        const cmd = h[nav.index] ?? ''
        setValue(cmd)
        setNavStatus(statusMapRef.current[cmd] ?? null)
      } else {
        setValue(nav.draft)
        navRef.current = null
        setNavStatus(null)
      }
    }
  }

  const savePreset = () => {
    const trimmed = value.trim().replace(/^\//, '')
    if (!trimmed) {
      toast.info('请先在输入框中输入要保存的命令')
      return
    }
    if (presets.includes(trimmed)) {
      toast.info('该指令已保存')
      return
    }
    const next = [...presets, trimmed]
    setPresets(next)
    try {
      localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(next))
      toast.success(`已保存快捷指令: ${trimmed}`)
    } catch {
      setPresets(presets)
      toast.error('保存快捷指令失败')
    }
  }

  const removePreset = (preset: string) => {
    const next = presets.filter((p) => p !== preset)
    setPresets(next)
    try {
      localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(next))
    } catch {
      setPresets(presets)
      toast.error('删除快捷指令失败')
    }
  }

  return (
    <section className="flex shrink-0 flex-col gap-2 rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-muted p-3">
      {/* RCON 降级横幅：命令已发送但响应不可见 */}
      {isRunning && !isRconConnected && (
        <NoticeBanner variant="warning" icon={ShieldAlert}>
          RCON 未启用，命令已发送但响应不可见
        </NoticeBanner>
      )}
      {/* 快捷 chips */}
      {presets.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {presets.map((preset) => {
            const name = preset.split(' ')[0]?.replace('/', '') ?? ''
            const Icon = iconForCommand(name)
            const colorClass = colorForCommand(name)
            const display = preset.length > 26 ? `${preset.slice(0, 24)}...` : preset
            return (
              <span
                key={preset}
                className="inline-flex items-center gap-1 rounded-mcs-sm border border-mcs-border-default bg-mcs-bg-default px-2 py-1 text-mcs-xs text-mcs-text-muted transition-colors hover:bg-mcs-state-hover"
              >
                <Icon className={`size-3 ${colorClass}`} aria-hidden />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="cursor-pointer font-mono hover:text-mcs-text-default"
                      onClick={() => setValue(preset)}
                    >
                      {display}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">{preset}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={`发送 ${preset}`}
                      className="cursor-pointer text-mcs-text-subtle hover:text-mcs-success-fg"
                      onClick={() => send(preset)}
                    >
                      <Play className="size-3" aria-hidden />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">立即发送</TooltipContent>
                </Tooltip>
                <button
                  type="button"
                  aria-label={`删除 ${preset}`}
                  className="cursor-pointer text-mcs-text-subtle hover:text-mcs-error-fg"
                  onClick={() => removePreset(preset)}
                >
                  <X className="size-3" aria-hidden />
                </button>
              </span>
            )
          })}
        </div>
      )}

      {/* 历史导航状态指示器 */}
      {navStatus && navRef.current != null && (
        <div className={"flex items-center gap-1 text-mcs-2xs " + (navStatus.status === 'sent' ? 'text-mcs-success-fg' : 'text-mcs-error-fg')}>
          {navStatus.status === 'sent' ? <Check className="size-3" aria-hidden /> : <X className="size-3" aria-hidden />}
          {navStatus.status === 'sent' ? '已送达' : `失败: ${navStatus.error ?? '未知'}`}
        </div>
      )}

      {/* 输入行 */}
      <div className="relative flex items-center gap-2">
        <span className="font-mono text-mcs-accent-fg" aria-hidden>&gt;</span>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => {
            // 编辑即退出历史导航（shell 语义：导航态下输入中断恢复）
            navRef.current = null
            setNavStatus(null)
            setValue(e.target.value)
          }}
          onKeyDown={(e) => {
            // IME 组合期（中文候选）↑↓ 用于选词，不触发历史导航
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Enter') send(value)
            if (e.key === 'Escape') {
              navRef.current = null
              setNavStatus(null)
              setValue('')
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              navigateHistory('up')
            }
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              navigateHistory('down')
            }
          }}
          placeholder="输入服务器命令... (如 /say hello)"
          disabled={!isRunning}
          className="h-8 min-w-0 flex-1 bg-transparent font-mono text-mcs-xs text-mcs-text-default outline-none placeholder:text-mcs-text-subtle disabled:cursor-not-allowed disabled:opacity-50"
          aria-label="服务器命令输入"
        />
        <IconButton
          variant="outline"
          onClick={() => savePreset()}
          aria-label="存为预设"
          title="存为预设"
        >
          <Star className="size-3.5" aria-hidden />
        </IconButton>
        <IconButton variant="default" onClick={() => send(value)} disabled={sending || !isRunning} aria-label="发送命令">
          <Send className="size-3.5" aria-hidden />
        </IconButton>

        {/* 补全下拉 */}
        {completions.length > 0 && (
          <div
            className="absolute bottom-full left-0 right-0 z-10 mb-1 max-h-44 overflow-y-auto rounded-mcs-sm border border-mcs-border-default bg-mcs-bg-emphasis p-1 shadow-lg"
            role="listbox"
            aria-label="命令补全"
          >
            {completions.map((item) => {
              const Icon = item.kind === 'command' ? iconForCommand(item.name) : ArrowRight
              return (
                <button
                  key={`${item.kind}-${item.text}`}
                  type="button"
                  role="option"
                  className="flex w-full items-center gap-2 rounded-mcs-xs px-2 py-1 text-left text-mcs-xs hover:bg-mcs-state-hover"
                  onClick={() => {
                    setValue(item.text)
                    inputRef.current?.focus()
                  }}
                >
                  <Icon className="size-3 text-mcs-accent-fg" aria-hidden />
                  <span className="font-mono">{item.text}</span>
                  {item.usage && <span className="ml-auto truncate text-mcs-text-subtle">{item.usage}</span>}
                </button>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}
