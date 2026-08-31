import { useEffect, useRef, useState } from 'react'
import { ArrowRight, Play, Send, Star, X } from 'lucide-react'
import { toast } from 'sonner'
import { useMutation } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { apiPost } from '@/api/client'
import { ApiError } from '@/api/client'
import { getFriendlyErrorMessage } from '@/api/errors'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'
import { useTerminalStore } from '@/stores/terminal'
import { useCommandBus } from '@/stores/command-bus'
import { colorForCommand, completeCommands, iconForCommand, type CompletionItem } from '@/lib/mc-commands'

/**
 * 命令输入行
 * - `>` 前缀 + 回车/按钮发送；RCON 响应非空时插入终端（INFO 级）
 * - / 开头触发补全（命令名前缀 / 参数子串，最多 10 条）
 * - ↑↓ 翻命令历史（会话级；连续重复去重；导航中保留草稿）
 * - 快捷 chips：5 默认 + 持久化（localStorage），播放=立即发送，点主体=仅填充，X=删除
 */

const PRESET_STORAGE_KEY = 'mcs-command-presets'
const HISTORY_LIMIT = 50
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

export function CommandInput() {
  const config = useConnectionStore()
  const instanceId = useServerStore((s) => s.instanceId)
  const isRunning = useServerStore((s) => s.status?.isRunning ?? false)
  const pushEntry = useTerminalStore((s) => s.pushEntry)
  const [value, setValue] = useState('')
  const [presets, setPresets] = useState<string[]>(readPresets)
  const [sending, setSending] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  /** 会话级命令历史（发送成功入列；连续重复合并） */
  const historyRef = useRef<string[]>([])
  /** 历史导航态：index=当前条目、draft=进入导航前的未发送输入 */
  const navRef = useRef<{ index: number; draft: string } | null>(null)

  const completions: CompletionItem[] = value.startsWith('/') ? completeCommands(value) : []

  // 注册命令总线 overlayRunner（Cmd+K 命令域执行入口；终端回显，优先级高于全局 baseRunner）
  const setOverlayRunner = useCommandBus((s) => s.setOverlayRunner)
  useEffect(() => {
    setOverlayRunner((cmd) => send(cmd))
    return () => setOverlayRunner(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      pushHistory(command)
      // 成功不弹 toast：终端已有 command + stdout 回显（失败仍 toast 告警）
      setValue('')
      inputRef.current?.focus()
    },
    onError: (err) => {
      const friendly = err instanceof ApiError
        ? getFriendlyErrorMessage(err.code, err.message)
        : '网络错误'
      toast.error(`命令发送失败: ${friendly}`)
    },
  })

  const send = (command: string) => {
    const trimmed = command.trim()
    if (!trimmed) return
    setSending(true)
    mutation.mutate(trimmed, { onSettled: () => setSending(false) })
  }

  /** 入列历史（shell 语义：与最近一条相同则跳过；超出上限裁头） */
  const pushHistory = (command: string) => {
    const h = historyRef.current
    if (h[h.length - 1] === command) return
    historyRef.current = [...h, command].slice(-HISTORY_LIMIT)
  }

  /** ↑↓ 历史导航：↑ 上移，↓ 下移；↓ 越过最新恢复草稿；任何编辑退出导航 */
  const navigateHistory = (dir: 'up' | 'down') => {
    const h = historyRef.current
    if (dir === 'up') {
      if (h.length === 0) return
      if (navRef.current == null) navRef.current = { index: h.length - 1, draft: value }
      else if (navRef.current.index > 0) navRef.current.index -= 1
      const nav = navRef.current
      setValue(h[nav.index] ?? '')
    } else {
      const nav = navRef.current
      if (nav == null) return
      if (nav.index < h.length - 1) {
        nav.index += 1
        setValue(h[nav.index] ?? '')
      } else {
        setValue(nav.draft)
        navRef.current = null
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
                      title={preset}
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

      {/* 输入行 */}
      <div className="relative flex items-center gap-2">
        <span className="font-mono text-mcs-accent-fg" aria-hidden>&gt;</span>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => {
            // 编辑即退出历史导航（shell 语义：导航态下输入中断恢复）
            navRef.current = null
            setValue(e.target.value)
          }}
          onKeyDown={(e) => {
            // IME 组合期（中文候选）↑↓ 用于选词，不触发历史导航
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Enter') send(value)
            if (e.key === 'Escape') {
              navRef.current = null
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
        <Button
          size="icon-sm"
          variant="outline"
          onClick={() => savePreset()}
          aria-label="存为预设"
          title="存为预设"
        >
          <Star className="size-3.5" aria-hidden />
        </Button>
        <Button size="icon-sm" onClick={() => send(value)} disabled={sending || !isRunning} aria-label="发送命令">
          <Send className="size-3.5" aria-hidden />
        </Button>

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
