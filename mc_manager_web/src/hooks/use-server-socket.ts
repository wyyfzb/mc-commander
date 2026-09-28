import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { McSocket } from '@/api/ws'
import { queryKeys } from '@/api/queries'
import { useConnectionStore } from '@/stores/connection'
import { useAuthStore } from '@/stores/auth'
import { useServerStore } from '@/stores/server'
import { useDeployStore } from '@/stores/deploy'
import { useRestartPendingStore } from '@/stores/restart-pending'
import { applyUpgradeProgress, isUpgradeTerminal } from '@/stores/upgrade'
import { applyBackupProgress, clearBackupProgress } from '@/stores/backup-progress'
import { useNotificationStore } from '@/stores/notifications'
import { useTerminalStore } from '@/stores/terminal'
import { useUiStore } from '@/stores/ui'
import { sessionAppliesToPanel } from '@/lib/mc-connection'
import type { InstanceSummary } from '@/api/types'
import type { Player, UpgradeStage, WsMessage } from '@/api/types'

/**
 * useServerSocket —— WS 单例 hook（设计文档 §5.2）
 * - 建立 McSocket（subprotocol 鉴权），订阅当前实例
 * - 事件分派：status 快照/performanceUpdate → ServerStore；通知类 → NotificationStore
 * - 断线重连由 McSocket 内置（指数退避 ≤30s，订阅自动恢复）
 * - 重连后触发全量刷新由消费端监听 socketConnected 边沿处理
 */

let socketSingleton: McSocket | null = null

/** 手动重连入口（降级横幅「重连」按钮用；无单例时返回 null 由调用方兜底） */
export function getSocketSingleton(): McSocket | null {
  return socketSingleton
}

/** 从实例列表缓存取实例名（critical toast 文案用；查不到回退实例 id） */
function getInstanceName(
  queryClient: ReturnType<typeof useQueryClient>,
  instanceId: string,
): string {
  const list = queryClient.getQueryData<InstanceSummary[]>(queryKeys.instances())
  return list?.find((i) => i.id === instanceId)?.name ?? instanceId
}

export function useServerSocket(instanceId: string | null) {
  const apiKey = useConnectionStore((s) => s.apiKey)
  const baseUrl = useConnectionStore((s) => s.baseUrl)
  const connectionReady = useConnectionStore((s) => s.status === 'ready')
  // 安全主线：会话令牌优先于 API Key 作为 WS 鉴权凭据（登录后 session 变更触发重建连接）；
  // 令牌只在签发它的面板上有效，换地址后回落 API Key——否则等于拿 A 的令牌去连 B 的实时通道
  const session = useAuthStore((s) => s.session)
  const sessionToken = sessionAppliesToPanel(session, baseUrl) ? (session?.token ?? null) : null
  const applyWsSnapshot = useServerStore((s) => s.applyWsSnapshot)
  const applyWsPerformance = useServerStore((s) => s.applyWsPerformance)
  const applyWsStatusEvent = useServerStore((s) => s.applyWsStatusEvent)
  const setSocketConnected = useServerStore((s) => s.setSocketConnected)
  const setHasConnectedOnce = useServerStore((s) => s.setHasConnectedOnce)
  const dispatchWsEvent = useNotificationStore((s) => s.dispatchWsEvent)
  const dispatchPerformance = useNotificationStore((s) => s.dispatchPerformance)
  const resetAlerts = useNotificationStore((s) => s.resetAlerts)
  const clearRestartPending = useRestartPendingStore((s) => s.clearPending)
  const clearPhase = useServerStore((s) => s.setPhase)
  const setLastOutputInstanceId = useUiStore((s) => s.setLastOutputInstanceId)
  const applyDeployProgress = useDeployStore((s) => s.applyDeployProgress)
  const pushLog = useTerminalStore((s) => s.pushEntry)
  const queryClient = useQueryClient()

  // 当前订阅的实例（ref 供事件处理器读取最新值）
  const instanceRef = useRef(instanceId)
  // eslint-disable-next-line react/refs -- latest-ref 模式：WS 事件处理器闭包读最新 instanceId，避免重建连接
  instanceRef.current = instanceId

  useEffect(() => {
    // 登出/凭据清空：显式关闭并置空单例（旧 token 不得占用实时通道，重连定时器一并清空）
    if (!connectionReady || (!apiKey && !sessionToken)) {
      if (socketSingleton) {
        socketSingleton.close()
        socketSingleton = null
      }
      return
    }

    // 凭据变更（改密/踢单设备/换账号/登出回退 apiKey）：close 旧单例并重建，
    // 旧 token 不再占用通道；断线补齐游标存 localStorage（不随单例丢失），重建后补齐仍有效
    if (socketSingleton && !socketSingleton.credentialsMatch({ apiKey, sessionToken })) {
      socketSingleton.close()
      socketSingleton = null
    }

    let socket = socketSingleton
    if (!socket) {
      socket = new McSocket({
        apiKey,
        baseUrl,
        sessionToken,
        // 连接生命周期边沿：断线即时置 false（激活「实时推送已断」降级态
        // 与降级横幅——此前 socketConnected 只在 effect 挂载/卸载时置位，断线
        // 永远感知不到，degraded 态是死码）；重连成功 onopen 置回 true
        onStateChange: ({ open }) => {
          setSocketConnected(open)
          if (open) setHasConnectedOnce(true)
        },
      })
      socketSingleton = socket
    }

    let disposed = false

    const handleMessage = (msg: WsMessage) => {
      const data = (msg.data ?? {}) as Record<string, unknown>

      // 通知分发：信封 eventId（服务端 notification_events 自增 id）统一带上，
      // 作为通知条目的跨标签身份（多个标签页各持一份副本，合并时据此认成同一条）。
      // 收敛在一处而非逐调用点手写——新增分发点漏带会静默退化成「跨标签重复条目」
      const dispatchEvent = (event: {
        type: string
        data?: Record<string, unknown>
        instanceId?: string
      }) => dispatchWsEvent({ ...event, ...(msg.eventId != null ? { eventId: msg.eventId } : {}) })

      // 全局系统资源统计推送（broadcastAll，无 instanceId）
      if (msg.type === 'systemStatsUpdate') {
        void queryClient.invalidateQueries({ queryKey: queryKeys.systemStats() })
        /* 磁盘告警：读数与阈值都在这条载荷里（阈值唯一来源是服务端 config.diskAlert）。
           磁盘与 TPS/CPU 不同源——后两者来自实例 performanceUpdate，磁盘是整机系统指标、
           15s 一拍，故在此分发而非并入上面的 dispatchPerformance。
           阈值缺失则不下发 diskPercent：buildAlertNotifications 便不会判磁盘（宁可不告警，
           也不退回前端自带的一份数字与部署配置漂移）。 */
        const stats = data as {
          diskUsage?: { primary?: { percent?: number } }
          diskAlert?: { warningPercent?: number; errorPercent?: number }
        }
        const diskPercent = stats.diskUsage?.primary?.percent
        if (diskPercent != null && stats.diskAlert) {
          dispatchPerformance({
            diskPercent,
            thresholds: {
              diskWarning: stats.diskAlert.warningPercent,
              diskError: stats.diskAlert.errorPercent,
            },
          })
        }
        return
      }

      // ── critical 事件全局广播（issue 334）：非当前实例的 crash/熔断不丢弃 ──
      // 用户切到其他页面/实例时，崩溃与熔断仍入通知中心（可跳转回溯）。
      // 失败类事件（备份失败/任务失败/Webhook 投递失败）与服务端同口径走
      // 无订阅全局播发（broadcastCriticalInstanceEvent，instanceId 可空＝
      // 无归属 webhook 的投递失败），此处同样旁路实例门控——出事实例未必
      // 是当前视图，跨实例丢弃会让失败只有控制台读者可见
      const isFailureEvent =
        msg.type === 'backupFailed' ||
        msg.type === 'taskFailed' ||
        msg.type === 'webhookDeliveryFailed'
      if (isFailureEvent) {
        dispatchEvent({
          type: msg.type,
          data: msg.data as Record<string, unknown>,
          instanceId: msg.instanceId,
        })
        return
      }
      if (msg.instanceId && msg.instanceId !== instanceRef.current) {
        const isCriticalStatus =
          msg.type === 'status' && (data.event === 'crash' || data.event === 'circuit_breaker')
        if (isCriticalStatus) {
          dispatchEvent({
            type: msg.type,
            data: msg.data as Record<string, unknown>,
            instanceId: msg.instanceId,
          })
        }
        return
      }

      // 全局进度事件（部署：创建新实例前即有进度，无实例归属）。
      // 归属字段（instanceId/instanceName 等）透传：连接补发恢复显示、部署横幅
      // 与「取消部署」定位服务端在途任务都需要它（取消端点按实例 id 精确匹配）
      if (msg.type === 'deployProgress') {
        applyDeployProgress({
          stage: String(data.stage ?? ''),
          percent: Number(data.percent ?? 0),
          transferred: Number(data.transferred ?? 0),
          total: Number(data.total ?? 0),
          ...(data.error ? { error: String(data.error) } : {}),
          ...(data.instanceId ? { instanceId: String(data.instanceId) } : {}),
          ...(data.instanceName ? { instanceName: String(data.instanceName) } : {}),
        })
        return
      }

      // 部署终态通知（服务端落库事件，信封无 instanceId——部署实例未入库）：
      // 入通知中心；完成时新实例已入库，刷新列表（取消不产生实例，无需刷新）
      if (
        msg.type === 'deployComplete' ||
        msg.type === 'deployFailed' ||
        msg.type === 'deployCancelled'
      ) {
        dispatchEvent({ type: msg.type, data: msg.data as Record<string, unknown> })
        if (msg.type === 'deployComplete') {
          void queryClient.invalidateQueries({ queryKey: queryKeys.instances() })
        }
        return
      }

      // 升级终态通知（带实例归属）：入通知中心（列表刷新由 upgradeProgress
      // 终态分支处理，不重复）
      if (
        msg.type === 'upgradeComplete' ||
        msg.type === 'upgradeFailed' ||
        msg.type === 'upgradeCancelled'
      ) {
        dispatchEvent({
          type: msg.type,
          data: msg.data as Record<string, unknown>,
          instanceId: msg.instanceId,
        })
        return
      }

      // 升级进度：实例归属在 payload（信封 instanceId 由服务端 broadcast 盖章），
      // 可针对非当前查看实例 → 只要求信封带 instanceId（服务端已按订阅过滤）
      if (msg.type === 'upgradeProgress') {
        if (!msg.instanceId) return
        const stage = String(data.stage ?? 'backup') as UpgradeStage
        applyUpgradeProgress({
          instanceId: String(data.instanceId ?? msg.instanceId),
          stage,
          percent: Number(data.percent ?? 0),
          detail: String(data.detail ?? ''),
          timestamp: Number(data.timestamp ?? Date.now()),
        })
        if (isUpgradeTerminal(stage)) {
          // 终态：刷新实例列表（版本号/JAR 已变更；取消也可能经回滚改写 DB）
          void queryClient.invalidateQueries({ queryKey: queryKeys.instances() })
        }
        return
      }

      if (!msg.instanceId || msg.instanceId !== instanceRef.current) return

      switch (msg.type) {
        case 'status': {
          if (data.event && typeof data.event === 'string') {
            const ev = data.event as
              | 'started'
              | 'stopped'
              | 'ready'
              | 'crash'
              | 'save'
              | 'circuit_breaker'
            applyWsStatusEvent(ev)
            /* 实例已启动 ⇒ 启动配置已生效，清「待重启」标记。
               判据取 started 而非 stopped：服务端保存启动配置后不改运行中进程，
               只有「重新起来」才算生效——stopped 只说明停下来了，此刻配置仍未被应用。 */
            if (ev === 'started') {
              clearRestartPending(msg.instanceId)
            }
            // 启停中间态确认清除（issue 334）：started/stopped 为终态确认，crash/熔断为异常终态
            if (
              ev === 'started' ||
              ev === 'stopped' ||
              ev === 'crash' ||
              ev === 'circuit_breaker'
            ) {
              clearPhase(msg.instanceId, null)
            }
            // 实例列表状态变化时刷新列表（runningCount 等）
            void queryClient.invalidateQueries({ queryKey: queryKeys.instances() })
            // 详情同步失效：isRunning 镜像自详情 query（server store），只刷列表会让
            // 面板外停止（如终端输 stop）后的停止状态条滞后到 30s 轮询才翻转
            void queryClient.invalidateQueries({ queryKey: queryKeys.instance(msg.instanceId) })
            // critical 事件（当前实例）：入通知中心 + 持久 toast（手动关闭防错过）
            if (ev === 'crash' || ev === 'circuit_breaker') {
              dispatchEvent({
                type: 'status',
                data: msg.data as Record<string, unknown>,
                instanceId: msg.instanceId,
              })
              const name = getInstanceName(queryClient, msg.instanceId)
              const crashedInstanceId = msg.instanceId
              toast.error(
                ev === 'crash'
                  ? `实例「${name}」服务器意外退出${data.autoRestart ? '，正在自动重启' : ''}`
                  : `实例「${name}」连续崩溃 ${Number(data.consecutiveCrashes ?? 0)} 次，已触发熔断保护`,
                {
                  duration: Infinity,
                  // 深入链接：一键查看进程末尾日志（issue 343，消费 lastOutput）
                  action: {
                    label: '查看末尾日志',
                    onClick: () => setLastOutputInstanceId(crashedInstanceId),
                  },
                },
              )
            } else {
              // started/stopped/ready/save 常规跃迁：入通知中心（文案映射见
              // lib/notifications buildNotifications），不弹 toast 防打断
              dispatchEvent({
                type: 'status',
                data: msg.data as Record<string, unknown>,
                instanceId: msg.instanceId,
              })
            }
          } else {
            applyWsSnapshot(msg.instanceId, {
              status: String(data.status ?? ''),
              isRunning: Boolean(data.isRunning),
              players: (data.players as unknown[]) ?? [],
              tps: typeof data.tps === 'number' ? data.tps : null,
            })
          }
          break
        }
        case 'performanceUpdate': {
          const p = {
            cpu: Number(data.cpu ?? 0),
            memory: Number(data.memory ?? 0),
            tps: Number(data.tps ?? 0),
            mspt: Number(data.mspt ?? 0),
            worldTime: data.worldTime == null ? null : Number(data.worldTime),
            worldDay: data.worldDay == null ? null : Number(data.worldDay),
            sleepingPlayers: Number(data.sleepingPlayers ?? 0),
            sleepingPlayerNames: (data.sleepingPlayerNames as string[]) ?? [],
            awakePlayerNames: (data.awakePlayerNames as string[]) ?? [],
          }
          applyWsPerformance(p)
          /* 告警状态机（TPS/CPU/内存跃迁单次通知）。
             只传 tps/cpu，**刻意不传 memoryPercent**：payload 的 `memory` 是进程 RSS
             （Windows WorkingSet / Linux statm RSS / macOS ps rss，见
             mc-server/stats-collector.js），要得出「内存使用率」还缺一个合法分母——
             整机 RAM 会让比例失真（stat-cards.tsx 明示「进程内存 / 整机总量」不可用），
             -Xmx 堆上限又因 RSS ≠ 堆（含元空间/线程栈/直接内存/GC 余量）同样不准。
             阈值 80% 因此在本链路上无可靠输入，highMemory 结构性不可触发；
             补这条通道要先由服务端提供真实堆使用率（如 JMX / /proc 的堆指标），
             属独立的能力项，不在前端接线范围内。 */
          dispatchPerformance({ tps: p.tps, cpu: p.cpu })
          break
        }
        case 'log': {
          pushLog(
            msg.instanceId,
            String(data.text ?? ''),
            (data.type as 'stdout' | 'stderr' | 'command') ?? 'stdout',
          )
          break
        }
        case 'playerStatsUpdate': {
          // 高频事件不落库；就地更新玩家列表缓存（health/armor/position/isSleeping），
          // 不触发 invalidate 防行抖动
          const updates = (data.players as Array<Record<string, unknown>>) ?? []
          if (updates.length === 0) break
          const playerKey = queryKeys.players(msg.instanceId)
          queryClient.setQueryData<Player[]>(playerKey, (prev) => {
            if (!prev) return prev
            const byName = new Map(updates.map((u) => [String(u.name), u]))
            return prev.map((p) => {
              const update = byName.get(p.name)
              if (!update) return p
              return {
                ...p,
                health: typeof update.health === 'number' ? update.health : p.health,
                armor: typeof update.armor === 'number' ? update.armor : p.armor,
                position:
                  update.position && typeof update.position === 'object'
                    ? ({
                        ...(update.position as Record<string, unknown>),
                      } as unknown as Player['position'])
                    : p.position,
                isSleeping:
                  typeof update.isSleeping === 'boolean' ? update.isSleeping : p.isSleeping,
              }
            })
          })
          break
        }
        case 'playerJoin':
        case 'playerLeave':
        case 'playerDeath':
        case 'playerRespawn':
        case 'playerChat':
        case 'playerSleep':
        case 'achievement':
          // 玩家列表全量刷新（join/leave 后重新拉取），随后落入通知中心
          void queryClient.invalidateQueries({ queryKey: queryKeys.players(msg.instanceId) })
          dispatchEvent({
            type: msg.type,
            data: msg.data as Record<string, unknown>,
            instanceId: msg.instanceId,
          })
          break
        case 'backupProgress':
        case 'restoreProgress': {
          // 进度推送（1s 节流）：瞬态 UI 状态进 backup-progress store，
          // 不进通知中心（高频事件落库会挤占断线补齐配额）
          applyBackupProgress(
            msg.instanceId,
            msg.type === 'backupProgress' ? 'create' : 'restore',
            Number(data.backupId ?? 0),
            Number(data.percent ?? 0),
          )
          break
        }
        case 'backupComplete':
        case 'backupFailed':
        case 'backupCancelled':
        case 'restoreComplete':
        case 'restoreFailed':
        case 'restoreCancelled':
          // 终态清除进度条（列表轮询/事件刷新负责后续数据收敛）
          clearBackupProgress(msg.instanceId)
          dispatchEvent({
            type: msg.type,
            data: msg.data as Record<string, unknown>,
            instanceId: msg.instanceId,
          })
          break
        case 'backupStart':
        case 'restoreStart':
          // 新操作开始：清上一次的进度条目——终态事件对非当前实例会被上方
          // 实例门拦下，回切后陈旧百分比会污染本次进度条（降级路径无新推送时
          // 会整段显示旧值）
          clearBackupProgress(msg.instanceId)
          dispatchEvent({
            type: msg.type,
            data: msg.data as Record<string, unknown>,
            instanceId: msg.instanceId,
          })
          break
        case 'weatherUpdate':
        case 'backupSkipped':
        case 'taskFailed':
        case 'webhookDeliveryFailed':
          dispatchEvent({
            type: msg.type,
            data: msg.data as Record<string, unknown>,
            instanceId: msg.instanceId,
          })
          break
        default:
          break
      }
    }

    const off = socket.on(handleMessage)

    void socket
      .connect()
      .then(() => {
        if (disposed) return
        setSocketConnected(true)
        setHasConnectedOnce(true)
        if (instanceRef.current) {
          socket?.subscribe(instanceRef.current)
        }
      })
      .catch(() => {
        // 连接失败由 McSocket 重连逻辑接管
      })

    return () => {
      disposed = true
      off()
      setSocketConnected(false)
      // 单例保留（跨页面复用）；实例切换由下方 effect 处理订阅
    }
  }, [
    connectionReady,
    apiKey,
    sessionToken,
    baseUrl,
    applyWsSnapshot,
    applyWsPerformance,
    applyWsStatusEvent,
    setSocketConnected,
    setHasConnectedOnce,
    dispatchWsEvent,
    dispatchPerformance,
    applyDeployProgress,
    pushLog,
    clearPhase,
    clearRestartPending,
    setLastOutputInstanceId,
    queryClient,
  ])

  // 实例切换：更新订阅 + 清空告警状态机。
  // 告警状态机记的是「当前实例是否处于超标态」，跨实例沿用会串味：A 低 TPS 置位后切到
  // 正常的 B，状态机会把 B 读成「恢复了」并推一条 B 从未发生过的恢复通知；反之 B 也低时
  // 会因已在集合里而吞掉真实告警。清空后首个 performanceUpdate 会重新判定（该告警就告警）。
  useEffect(() => {
    const socket = socketSingleton
    resetAlerts()
    if (!socket || !connectionReady || !instanceId) return
    socket.subscribe(instanceId)
  }, [instanceId, connectionReady, resetAlerts])

  return socketSingleton
}
