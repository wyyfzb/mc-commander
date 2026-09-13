import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import {
  CalendarClock,
  CloudUpload,
  FolderOpen,
  Globe,
  LayoutDashboard,
  Moon,
  Puzzle,
  RefreshCw,
  ScrollText,
  Server,
  Settings,
  Square,
  Sun,
  Terminal,
  Users,
  Webhook,
  type LucideIcon,
} from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command'
import { useUiStore } from '@/stores/ui'
import { useCommandBus } from '@/stores/command-bus'
import { useServerStore } from '@/stores/server'
import { useConnectionStore } from '@/stores/connection'
import { usePlayers } from '@/features/players/queries'
import { usePlayersUiStore } from '@/features/players/store'
import { useCreateBackup } from '@/features/settings/queries'
import { useStopInstance } from '@/hooks/use-instance-stop'
import { apiPost } from '@/api/client'
import { getFriendlyErrorText } from '@/api/errors'
import { queryKeys } from '@/api/queries'
import { iconForCommand } from '@/lib/mc-commands'
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'

/**
 * CommandPalette —— Cmd+K 全局命令面板
 * 能力：页面跳转 / 主题切换 / 命令域（预设快捷命令经命令总线执行）
 * / 玩家搜索、给予/传送/封禁快捷入口
 * / 实例操作（重启/备份/停止，issue 343：破坏性操作二次确认，备份直接执行）
 */

const PRESET_STORAGE_KEY = 'mcs-command-presets'
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

interface PaletteAction {
  label: string
  icon: LucideIcon
  keywords?: string
  /** 右侧路径提示（导航项的落点面包屑；无落点语义的项不设） */
  hint?: string
  run: () => void
}

export function CommandPalette() {
  const open = useUiStore((s) => s.commandPaletteOpen)
  const setOpen = useUiStore((s) => s.setCommandPaletteOpen)
  const theme = useUiStore((s) => s.theme)
  const toggleTheme = useUiStore((s) => s.toggleTheme)
  const navigate = useNavigate()
  // 双槽消费：仪表盘终端回显优先，否则全局执行器
  const overlayRunner = useCommandBus((s) => s.overlayRunner)
  const baseRunner = useCommandBus((s) => s.baseRunner)
  const commandRunner = overlayRunner ?? baseRunner
  const instanceId = useServerStore((s) => s.instanceId)
  const instanceName = useServerStore((s) => s.status?.name ?? null)
  const isInstanceRunning = useServerStore((s) => s.status?.isRunning ?? false)
  const openPlayerDetail = usePlayersUiStore((s) => s.openPlayerDetail)

  // 实例操作（issue 343）：重启/备份/停止；破坏性操作关面板后二次确认
  const queryClient = useQueryClient()
  const config = useConnectionStore()
  const stopMutation = useStopInstance()
  const createBackupMutation = useCreateBackup(instanceId)
  const [pendingAction, setPendingAction] = useState<'重启' | '停止' | null>(null)
  const [confirmExecuting, setConfirmExecuting] = useState(false)

  /** 重启：与实例页同源 apiPost；发令成功后失效实例状态（WS status 事件后续驱动） */
  const restartMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiPost(`/api/v1/instances/${id}/restart`, config)
      return id
    },
    onSuccess: (_data, id) => {
      toast.success('重启指令已发送')
      void queryClient.invalidateQueries({ queryKey: queryKeys.instance(id) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.instances() })
    },
    onError: (e) => {
      toast.error(`重启失败：${getFriendlyErrorText(e)}`)
    },
  })

  /** 破坏性操作确认回调（面板已关，ConfirmDialog 独立挂载） */
  const executePendingAction = async () => {
    if (!pendingAction || !instanceId) return
    setConfirmExecuting(true)
    try {
      if (pendingAction === '停止') {
        stopMutation.mutate(instanceId)
      } else {
        await restartMutation.mutateAsync(instanceId)
      }
    } finally {
      setConfirmExecuting(false)
      setPendingAction(null)
    }
  }

  /** 备份：非破坏性直接执行 */
  const runBackup = async () => {
    try {
      await createBackupMutation.mutateAsync()
      toast.success('备份任务已启动')
    } catch (e) {
      toast.error(`操作失败：${getFriendlyErrorText(e)}`)
    }
  }

  // Cmd/Ctrl+K 全局快捷键；Esc 由 Dialog 自身处理
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen(!open)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, setOpen])

  const go = (path: string) => {
    navigate(path)
    setOpen(false)
  }

  const pageActions: PaletteAction[] = [
    { label: '仪表盘', icon: LayoutDashboard, hint: '/dashboard', keywords: 'dashboard 首页 状态 终端', run: () => go('/dashboard') },
    { label: '玩家', icon: Users, hint: '/players', keywords: 'players 玩家列表 封禁 传送', run: () => go('/players') },
    { label: '世界', icon: Globe, hint: '/world', keywords: 'world 属性 gamelogic 规则', run: () => go('/world') },
    { label: '文件', icon: FolderOpen, hint: '/files', keywords: 'files 文件管理 编辑器', run: () => go('/files') },
    { label: '任务', icon: CalendarClock, hint: '/tasks', keywords: 'tasks 定时 cron 备份', run: () => go('/tasks') },
    { label: '插件', icon: Puzzle, hint: '/plugins', keywords: 'plugins 插件市场 modrinth 上传 启用 禁用', run: () => go('/plugins') },
    { label: '实例', icon: Server, hint: '/instances', keywords: 'instances 部署 服务器', run: () => go('/instances') },
    { label: 'Webhook', icon: Webhook, hint: '/webhooks', keywords: 'webhooks 通知 推送 钩子', run: () => go('/webhooks') },
    { label: '审计日志', icon: ScrollText, hint: '/audit', keywords: 'audit 审计 操作记录 命令历史', run: () => go('/audit') },
    { label: '设置', icon: Settings, hint: '/settings', keywords: 'settings 连接 通用 关于', run: () => go('/settings') },
  ]

  const themeAction: PaletteAction = {
    label: theme === 'dark' ? '切换到亮色主题' : '切换到深色主题',
    icon: theme === 'dark' ? Sun : Moon,
    keywords: 'theme 主题 暗色 亮色 dark light',
    run: () => {
      toggleTheme()
      setOpen(false)
    },
  }

  // 命令域：预设快捷命令
  const presets = readPresets()

  // 玩家域：搜索玩家（远程数据），点选打开玩家页详情；cmdk 按 value 过滤
  const playersQuery = usePlayers(instanceId)
  const playerActions: PaletteAction[] = useMemo(() => {
    const players = playersQuery.data ?? []
    return [...players]
      .sort((a, b) => Number(b.isOnline) - Number(a.isOnline))
      .slice(0, 50)
      .map((p) => ({
        label: `${p.name}${p.isOnline ? '' : '（离线）'}${p.isOp ? ' · OP' : ''}${p.isBanned || p.isIpBanned ? ' · 已封禁' : ''}`,
        icon: Users,
        keywords: `玩家 player ${p.name} ${p.isOnline ? '在线' : '离线'} 封禁 ban 传送 tp 给予 give`,
        run: () => {
          navigate(`/players?player=${encodeURIComponent(p.name)}`)
          openPlayerDetail(p.name)
          setOpen(false)
        },
      }))
  }, [playersQuery.data, navigate, openPlayerDetail, setOpen])

  return (
    <>
      <CommandDialog open={open} onOpenChange={setOpen}>
      {/* shadcn 4.x：CommandDialog 仅提供 Dialog 外壳，cmdk 根必须显式包裹 */}
      <Command>
        <CommandInput placeholder="输入页面名称或命令…" />
        <CommandList>
          <CommandEmpty>未找到匹配项</CommandEmpty>
          <CommandGroup heading="页面">
            {pageActions.map((action) => (
              <CommandItem
                key={action.label}
                value={`${action.label} ${action.keywords ?? ''}`}
                onSelect={action.run}
              >
                <action.icon className="size-4" aria-hidden />
                {action.label}
                {action.hint && <CommandShortcut>{action.hint}</CommandShortcut>}
              </CommandItem>
            ))}
          </CommandGroup>
          {instanceId && playerActions.length > 0 && (
            <>
              <CommandSeparator />
              <CommandGroup heading="玩家（点选打开详情）">
                {playerActions.map((action) => (
                  <CommandItem key={action.label} value={`${action.label} ${action.keywords ?? ''}`} onSelect={action.run}>
                    <action.icon className="size-4" aria-hidden />
                    {action.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}
          {commandRunner && presets.length > 0 && (
            <>
              <CommandSeparator />
              <CommandGroup heading="命令">
                {presets.map((preset) => {
                  const Icon = iconForCommand(preset.split(' ')[0]?.replace('/', '') ?? '')
                  return (
                    <CommandItem
                      key={preset}
                      value={`命令 ${preset}`}
                      onSelect={() => {
                        commandRunner(preset)
                        setOpen(false)
                      }}
                    >
                      <Icon className="size-4" aria-hidden />
                      <span className="font-mono text-mcs-xs">{preset}</span>
                      <Terminal className="ml-auto size-3.5 text-mcs-text-muted" aria-hidden />
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            </>
          )}
          {instanceId && instanceName && (
            <>
              <CommandSeparator />
              <CommandGroup heading={`实例操作 · ${instanceName}`}>
                <CommandItem
                  value={`重启实例 ${instanceName} restart 重启`}
                  disabled={!isInstanceRunning}
                  onSelect={() => {
                    setOpen(false)
                    setPendingAction('重启')
                  }}
                >
                  <RefreshCw className="size-4 text-mcs-info-fg" aria-hidden />
                  重启实例 · {instanceName}
                </CommandItem>
                <CommandItem
                  value={`备份实例 ${instanceName} backup 备份 save`}
                  onSelect={() => {
                    setOpen(false)
                    void runBackup()
                  }}
                >
                  <CloudUpload className="size-4 text-mcs-accent-fg" aria-hidden />
                  备份实例 · {instanceName}
                </CommandItem>
                <CommandItem
                  value={`停止实例 ${instanceName} stop 停止 shutdown`}
                  disabled={!isInstanceRunning}
                  onSelect={() => {
                    setOpen(false)
                    setPendingAction('停止')
                  }}
                >
                  <Square className="size-4 text-mcs-error-fg" aria-hidden />
                  停止实例 · {instanceName}
                </CommandItem>
              </CommandGroup>
            </>
          )}
          <CommandSeparator />
          <CommandGroup heading="外观">
            <CommandItem value={`主题 ${themeAction.keywords ?? ''}`} onSelect={themeAction.run}>
              <themeAction.icon className="size-4" aria-hidden />
              {themeAction.label}
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
      </CommandDialog>
      {/* 实例操作二次确认（破坏性：重启/停止；必须在面板 Dialog 外独立挂载：
          面板关闭时其 children 会卸载，嵌套会连带丢掉确认弹窗） */}
      <ConfirmDialog
        open={pendingAction !== null}
        onOpenChange={(o) => {
          if (!o) setPendingAction(null)
        }}
        title={pendingAction ? `${pendingAction}服务器` : ''}
        description={
          pendingAction === '重启'
            ? '确定要重启服务器吗？重启期间玩家将断开连接。'
            : '确定要关闭服务器吗？'
        }
        confirmText={pendingAction ?? '确定'}
        danger={pendingAction === '停止'}
        loading={confirmExecuting}
        onConfirm={() => void executePendingAction()}
      />
    </>
  )
}
