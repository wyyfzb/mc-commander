import { useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router'
import {
  CalendarClock,
  FolderOpen,
  Globe,
  LayoutDashboard,
  Moon,
  Server,
  Settings,
  Sun,
  Terminal,
  Users,
  type LucideIcon,
} from 'lucide-react'
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command'
import { useUiStore } from '@/stores/ui'
import { useCommandBus } from '@/stores/command-bus'
import { useServerStore } from '@/stores/server'
import { usePlayers } from '@/features/players/queries'
import { usePlayersUiStore } from '@/features/players/store'
import { iconForCommand } from '@/lib/mc-commands'

/**
 * CommandPalette —— Cmd+K 全局命令面板
 * 能力：页面跳转 / 主题切换 / 命令域（预设快捷命令经命令总线执行）
 * / 玩家搜索、给予/传送/封禁快捷入口
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
  const openPlayerDetail = usePlayersUiStore((s) => s.openPlayerDetail)

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
    { label: '仪表盘', icon: LayoutDashboard, keywords: 'dashboard 首页 状态 终端', run: () => go('/dashboard') },
    { label: '玩家', icon: Users, keywords: 'players 玩家列表 封禁 传送', run: () => go('/players') },
    { label: '世界', icon: Globe, keywords: 'world 属性 gamelogic 规则', run: () => go('/world') },
    { label: '文件', icon: FolderOpen, keywords: 'files 文件管理 编辑器', run: () => go('/files') },
    { label: '任务', icon: CalendarClock, keywords: 'tasks 定时 cron 备份', run: () => go('/tasks') },
    { label: '实例', icon: Server, keywords: 'instances 部署 服务器', run: () => go('/instances') },
    { label: '设置', icon: Settings, keywords: 'settings 连接 通用 关于', run: () => go('/settings') },
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
                      <Terminal className="ml-auto size-3.5 text-mcs-text-subtle" aria-hidden />
                    </CommandItem>
                  )
                })}
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
  )
}
