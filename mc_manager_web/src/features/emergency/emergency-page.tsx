/**
 * EmergencyPage —— 移动端紧急视图（独立路由 /emergency，无 AppShell）
 * 定位：人在外面 30 秒完成处置——状态一屏尽收，重启/停止/踢人/封禁四步可达，终端兜底。
 * 数据：HTTP 轮询（useInstanceStatus 30s），不依赖 WS（推送点开场景 WS 可能未连上）。
 * 设计纪律：全部 --mcs-* token；大按钮触控目标 ≥44px。
 */
import { useState } from 'react'
import { Link } from 'react-router'
import {
  AlertTriangle,
  Loader2,
  Moon,
  RefreshCw,
  Save,
  Settings,
  Square,
  Sun,
  Terminal,
  UserRound,
  Users,
} from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'
import { Button } from '@/components/ui/button'
import { ApiError, apiGet, apiPost } from '@/api/client'
import { getFriendlyErrorMessage } from '@/api/errors'
import { useInstances, useInstanceStatus, queryKeys } from '@/api/queries'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'
import { useUiStore } from '@/stores/ui'
import { cn } from '@/lib/utils'
import type { InstanceStatus } from '@/api/types'

type EmergencyTab = 'overview' | 'players' | 'console' | 'more'

const TAB_LABELS: { key: EmergencyTab; label: string; icon: typeof Users }[] = [
  { key: 'overview', label: '仪表', icon: Users },
  { key: 'players', label: '玩家', icon: UserRound },
  { key: 'console', label: '控制台', icon: Terminal },
  { key: 'more', label: '更多', icon: Settings },
]

export function EmergencyPage() {
  const config = useConnectionStore()
  const queryClient = useQueryClient()
  const instanceId = useServerStore((s) => s.instanceId)
  const theme = useUiStore((s) => s.theme)
  const toggleTheme = useUiStore((s) => s.toggleTheme)
  const [tab, setTab] = useState<EmergencyTab>('overview')
  const [confirmStop, setConfirmStop] = useState(false)
  // 重启与停止同级破坏力（断开全部玩家），确认保护与桌面端对齐
  const [confirmRestart, setConfirmRestart] = useState(false)
  const [command, setCommand] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const instancesQuery = useInstances()
  const currentId = instanceId ?? instancesQuery.data?.[0]?.id ?? null
  const status = useInstanceStatus(currentId)
  const st: InstanceStatus | undefined = status.data

  const isRunning = st?.isRunning ?? false
  const healthy = isRunning && (st?.tps ?? 0) >= 19
  const onlinePlayers = (st?.players as Array<{ name?: string }> | undefined) ?? []

  // 迷你终端：最近 20 行日志（进入/30s 轮询；与仪表盘共用端点）
  const logsQuery = useQuery({
    queryKey: queryKeys.logs(currentId ?? ''),
    queryFn: () => apiGet<Array<{ text: string; type: string }>>(`/api/v1/instances/${currentId}/logs`, config),
    enabled: currentId != null,
    refetchInterval: 30_000,
  })

  const action = useMutation({
    mutationFn: async ({ kind, name }: { kind: 'restart' | 'stop' | 'kick' | 'save'; name?: string }) => {
      if (!currentId) throw new ApiError(40401, 404, 'Instance not found', null)
      if (kind === 'kick' && name) {
        await apiPost(`/api/v1/instances/${currentId}/players/${name}/kick`, config, { reason: '管理员通过紧急视图踢出' })
      } else if (kind === 'save') {
        await apiPost(`/api/v1/instances/${currentId}/command`, config, { command: 'save-all' })
      } else {
        await apiPost(`/api/v1/instances/${currentId}/${kind}`, config)
      }
    },
    onSuccess: async (_data, vars) => {
      toast.success(vars.kind === 'save' ? '存档指令已发送' : '指令已发送')
      setBusy(null)
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance(currentId ?? '') })
    },
    onError: (err) => {
      setBusy(null)
      toast.error(
        err instanceof ApiError ? getFriendlyErrorMessage(err.code, err.message) : '操作失败，请检查连接',
      )
    },
  })

  function run(kind: 'restart' | 'stop' | 'kick' | 'save', name?: string) {
    if (kind === 'stop') {
      setConfirmStop(true)
      return
    }
    if (kind === 'restart') {
      setConfirmRestart(true)
      return
    }
    setBusy(kind === 'kick' ? '踢出' : '存档')
    action.mutate({ kind, name })
  }

  async function sendCommand() {
    const cmd = command.trim()
    if (!cmd || !currentId) return
    try {
      await apiPost(`/api/v1/instances/${currentId}/command`, config, { command: cmd })
      setCommand('')
      toast.success(`已执行：${cmd}`)
    } catch (err) {
      toast.error(
        err instanceof ApiError ? getFriendlyErrorMessage(err.code, err.message) : '命令发送失败，请检查连接',
      )
    }
  }

  const lastLogs = (logsQuery.data ?? []).slice(-12)

  return (
    <div className="flex h-dvh flex-col bg-mcs-bg-default text-mcs-text-default">
      {/* 顶栏：实例名 + 健康 chip */}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-mcs-border-muted px-4">
        {/* 44px 触控热区内嵌 10px 视觉点（该页触控纪律 ≥44px） */}
        <Link
          to="/dashboard"
          className="-ml-2 flex size-11 items-center justify-center"
          aria-label="返回主面板"
        >
          <span className="size-2.5 rounded-full bg-mcs-accent" aria-hidden />
        </Link>
        <span className="text-mcs-sm font-semibold">{st?.name ?? 'MC Commander'}</span>
        <span
          className={cn(
            'ml-auto inline-flex items-center gap-1 rounded-mcs-sm px-2 py-0.5 text-mcs-2xs font-semibold',
            healthy
              ? 'bg-mcs-success-bg-subtle text-mcs-success-fg'
              : isRunning
                ? 'bg-mcs-warning-bg-subtle text-mcs-warning-fg'
                : 'bg-mcs-bg-emphasis text-mcs-text-muted',
          )}
        >
          <span
            className={cn('size-1.5 rounded-full', healthy ? 'bg-mcs-success-fg' : isRunning ? 'bg-mcs-warning-fg' : 'bg-mcs-text-muted')}
            aria-hidden
          />
          {isRunning ? (healthy ? '健康' : '卡顿') : '已停止'}
        </span>
      </header>

      {/* 主区 */}
      <main className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-3">
        {tab === 'overview' && (
          <div className="flex flex-col gap-3">
            {/* TPS 大字（状态查询失败时明确报错，不呈现为假死的「—」） */}
            <section className="mcs-edge-top relative flex flex-col items-center rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-muted py-5 shadow-mcs-card">
              {status.isError && !status.isLoading ? (
                <>
                  <AlertTriangle className="size-8 text-mcs-error-fg" aria-hidden />
                  <p className="mt-2 text-mcs-sm text-mcs-text-muted">服务器状态获取失败</p>
                  <Button variant="outline" size="sm" className="mt-3" onClick={() => void status.refetch()}>
                    <RefreshCw className="size-4" aria-hidden />
                    重试
                  </Button>
                </>
              ) : (
                <>
                  <span
                    className={cn('mcs-num text-mcs-display leading-none', healthy ? 'text-mcs-success-fg' : 'text-mcs-warning-fg')}
                  >
                    {st?.tps != null ? st.tps.toFixed(1) : '—'}
                  </span>
                  <span className="mt-1.5 text-mcs-2xs tracking-[0.2em] text-mcs-text-muted">
                    TPS{isRunning ? ' · 运行中' : ' · 已停止'}
                  </span>
                  <div className="mt-4 flex w-full justify-around">
                    <Stat label="在线" value={`${st?.playerCount ?? 0}/${st?.maxPlayers ?? 20}`} />
                    <Stat label="CPU" value={`${st?.cpuUsage ?? 0}%`} />
                    <Stat label="内存" value={`${st?.memoryUsage ?? 0}G`} />
                  </div>
                </>
              )}
            </section>

            {/* 4 大按钮（触控 ≥44px）：重启/停止为破坏性操作走确认；存档是处置黄金位的高频动作 */}
            <section className="grid grid-cols-2 gap-2.5">
              <Button
                className="h-14 text-mcs-md"
                variant="outline"
                disabled={!isRunning || busy !== null}
                onClick={() => run('restart')}
              >
                {busy === '重启' ? <Loader2 className="size-5 animate-spin" aria-hidden /> : <RefreshCw className="size-5" aria-hidden />}
                重启
              </Button>
              <Button
                className="h-14 text-mcs-md"
                variant="outline"
                disabled={!isRunning || busy !== null}
                onClick={() => run('stop')}
              >
                <Square className="size-5 text-mcs-error-fg" aria-hidden />
                停止
              </Button>
              <Button
                className="h-14 text-mcs-md"
                variant="outline"
                disabled={!isRunning || busy !== null}
                onClick={() => run('save')}
              >
                <Save className="size-5" aria-hidden />
                存档
              </Button>
              <Button
                className="h-14 text-mcs-md"
                variant="outline"
                onClick={() => setTab('players')}
              >
                <Users className="size-5" aria-hidden />
                玩家操作
              </Button>
            </section>

            {/* 迷你终端（日志查询失败时明确报错） */}
            <section className="flex flex-col rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-subtle shadow-mcs-card">
              <div className="flex items-center gap-1.5 border-b border-mcs-border-muted px-3 py-2">
                <span className="size-1.5 rounded-full bg-mcs-success-fg" aria-hidden />
                <span className="font-mono text-mcs-xs tracking-wider text-mcs-text-muted">SERVER CONSOLE</span>
              </div>
              <div className="min-h-24 px-3 py-2 font-mono text-mcs-2xs leading-relaxed text-mcs-text-muted">
                {logsQuery.isError && !logsQuery.isLoading ? (
                  <p className="text-mcs-error-fg">日志获取失败，正在重试…</p>
                ) : (
                  <>
                    {(lastLogs.length === 0 || !isRunning) && (
                      <p className="text-mcs-text-muted">{isRunning ? '暂无日志输出…' : '服务器已停止，启动后可查看日志'}</p>
                    )}
                    {lastLogs.map((l, i) => (
                      <p key={i} className="line-clamp-2" title={l.text}>{l.text}</p>
                    ))}
                  </>
                )}
              </div>
            </section>
          </div>
        )}

        {tab === 'players' && (
          <div className="flex flex-col gap-2">
            {onlinePlayers.length === 0 && (
              <p className="py-8 text-center text-mcs-sm text-mcs-text-muted">
                {isRunning ? '当前没有在线玩家' : '服务器已停止'}
              </p>
            )}
            {onlinePlayers.map((p) => (
              <div
                key={p.name}
                className="flex items-center gap-3 rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-muted p-3 shadow-mcs-card"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-mcs-accent-bg-subtle text-mcs-sm font-semibold text-mcs-accent-fg">
                  {p.name?.charAt(0).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-mcs-sm font-semibold">{p.name}</div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-11"
                  disabled={!isRunning || busy !== null}
                  onClick={() => run('kick', p.name)}
                >
                  踢出
                </Button>
              </div>
            ))}
          </div>
        )}

        {tab === 'console' && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-col rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-subtle shadow-mcs-card">
              <div className="border-b border-mcs-border-muted px-3 py-2 font-mono text-mcs-2xs tracking-wider text-mcs-text-muted">
                SERVER CONSOLE
              </div>
              <div className="min-h-40 px-3 py-2 font-mono text-mcs-2xs leading-relaxed text-mcs-text-muted">
                {logsQuery.isError && !logsQuery.isLoading ? (
                  <p className="text-mcs-error-fg">日志获取失败，正在重试…</p>
                ) : (
                  <>
                    {lastLogs.length === 0 && <p className="text-mcs-text-muted">暂无日志</p>}
                    {lastLogs.map((l, i) => (
                      <p key={i} className="line-clamp-2" title={l.text}>{l.text}</p>
                    ))}
                  </>
                )}
              </div>
            </div>
            <div className="flex gap-2">
              <input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void sendCommand()}
                placeholder="输入命令…"
                aria-label="终端命令输入"
                className="h-12 min-w-0 flex-1 rounded-mcs-md border border-mcs-border-default bg-mcs-bg-muted px-3 font-mono text-mcs-sm text-mcs-text-default outline-none placeholder:text-mcs-text-muted focus:border-mcs-accent-border focus:ring-1 focus:ring-mcs-focus-ring"
              />
              <Button className="h-12 px-5" disabled={!isRunning} onClick={() => void sendCommand()}>
                发送
              </Button>
            </div>
          </div>
        )}

        {tab === 'more' && (
          <div className="flex flex-col gap-2">
            <Button variant="outline" className="h-12 justify-start text-mcs-sm" onClick={toggleTheme}>
              {theme === 'dark' ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}
              {theme === 'dark' ? '切换到亮色主题' : '切换到深色主题'}
            </Button>
            {/* 直达完整设置（原为切换 Tab 的死按钮，点击无任何反馈；main 侧同功能修复取 Link 语义版） */}
            <Link
              to="/settings"
              className="flex h-12 items-center justify-start gap-2 rounded-mcs-sm border border-mcs-border-default px-4 text-mcs-sm text-mcs-text-default"
            >
              <Settings className="size-4" aria-hidden />
              打开完整设置
            </Link>
          </div>
        )}
      </main>

      {/* 底部 Tab（aria-current 标记当前页） */}
      <nav className="flex shrink-0 border-t border-mcs-border-muted bg-mcs-bg-muted pb-[env(safe-area-inset-bottom)]" aria-label="紧急视图导航">
        {TAB_LABELS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            aria-label={label}
            aria-current={tab === key ? 'page' : undefined}
            className={cn(
              'flex h-14 flex-1 flex-col items-center justify-center gap-1 text-mcs-2xs font-semibold',
              tab === key ? 'text-mcs-accent-fg' : 'text-mcs-text-muted',
            )}
          >
            <Icon className="size-5" aria-hidden />
            {label}
          </button>
        ))}
      </nav>

      {/* 停止确认（B8：显示在线玩家数） */}
      <ConfirmDialog
        open={confirmStop}
        onOpenChange={setConfirmStop}
        title="停止服务器"
        description={
          isRunning && onlinePlayers.length > 0
            ? `${onlinePlayers.length} 名玩家当前在线（${onlinePlayers.map((p) => p.name).slice(0, 3).join('、')}${onlinePlayers.length > 3 ? '…' : ''}），停止后他们将断开连接。`
            : '确定要停止服务器吗？'
        }
        confirmText="存档并停止"
        cancelText="取消"
        danger
        onConfirm={() => {
          setConfirmStop(false)
          setBusy('停止')
          action.mutate({ kind: 'stop' })
        }}
      />

      {/* 重启确认（与桌面端保护粒度对齐：重启同样断开全部玩家） */}
      <ConfirmDialog
        open={confirmRestart}
        onOpenChange={setConfirmRestart}
        title="重启服务器"
        description={
          isRunning && onlinePlayers.length > 0
            ? `${onlinePlayers.length} 名玩家当前在线，重启期间他们将断开连接，完成后可自动回连。`
            : '确定要重启服务器吗？'
        }
        confirmText="存档并重启"
        cancelText="取消"
        onConfirm={() => {
          setConfirmRestart(false)
          setBusy('重启')
          action.mutate({ kind: 'restart' })
        }}
      />
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-center">
      <div className="mcs-num text-mcs-md leading-none font-semibold">{value}</div>
      <div className="mt-0.5 text-mcs-2xs text-mcs-text-muted">{label}</div>
    </div>
  )
}
