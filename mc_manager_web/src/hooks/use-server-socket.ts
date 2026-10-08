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
import {
  applyWorldUpgradeFraction,
  clearWorldUpgradeProgress,
} from '@/stores/world-upgrade-progress'
import { useNotificationStore } from '@/stores/notifications'
import { useTerminalStore } from '@/stores/terminal'
import { useUiStore } from '@/stores/ui'
import { sessionAppliesToPanel } from '@/lib/mc-connection'
import type { InstanceSummary } from '@/api/types'
import type { Player, UpgradeStage, WsMessage } from '@/api/types'
import { wsWorldUpgradePayloadSchema } from '@mc-commander/schemas'

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
        /* 整机告警（磁盘 + 内存）：读数与阈值都在这条载荷里（阈值唯一来源分别是服务端
           config.diskAlert / config.memoryAlert）。整机指标与 TPS/CPU 不同源——后两者来自
           实例 performanceUpdate，整机是 15s 一拍的系统读数，故在此分发而非并入
           dispatchPerformance 的实例链路。
           阈值缺失则不下发对应读数：buildAlertNotifications 便不判该项（宁可不告警，
           也不退回前端自带的一份数字与部署配置漂移）。
           ⚠️ memoryPercent 是**整机**已用 ÷ 整机总量，不是 MC 进程 RSS（那是
           performanceUpdate 的 memory 字段，分子分母不同源、不可当比例用），也不是 JVM 堆。 */
        const stats = data as {
          memoryPercent?: number
          diskUsage?: { primary?: { percent?: number } }
          diskAlert?: { warningPercent?: number; errorPercent?: number }
          memoryAlert?: { warningPercent?: number }
        }
        const diskPercent = stats.diskUsage?.primary?.percent
        const memoryPercent = stats.memoryPercent
        // 阈值必须**合并进同一个对象**再下发：dispatchPerformance 只读一个 thresholds 键，
        // 若把磁盘与内存各写一个 thresholds 键（对象字面量里后者覆盖前者），磁盘阈值会
        // 被静默丢掉——表现是「磁盘告警消失」而内存告警照常，很难回溯。
        const thresholds: {
          diskWarning?: number
          diskError?: number
          memoryWarning?: number
        } = {}
        const perf: {
          diskPercent?: number
          memoryPercent?: number
          thresholds?: typeof thresholds
        } = {}
        // 读数与其阈值同源成对生效：只有一方到位时不判该项（宁可不告警，也不退回前端数字）
        if (diskPercent != null && stats.diskAlert) {
          perf.diskPercent = diskPercent
          thresholds.diskWarning = stats.diskAlert.warningPercent
          thresholds.diskError = stats.diskAlert.errorPercent
        }
        if (memoryPercent != null && stats.memoryAlert) {
          perf.memoryPercent = memoryPercent
          thresholds.memoryWarning = stats.memoryAlert.warningPercent
        }
        if (Object.keys(thresholds).length > 0) perf.thresholds = thresholds
        dispatchPerformance(perf)
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
          msg.type === 'statusEvent' && (data.event === 'crash' || data.event === 'circuit_breaker')
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
        case 'statusEvent': {
          // 跃迁是**事件**（发生过的瞬间事实）；快照走 `statusSnapshot`（见下一个 case）。
          // 缺 `event` 字段说明不是跃迁（旧服务端或形状漂移）：当跃迁处理会给出一堆 undefined 跃迁
          if (!data.event || typeof data.event !== 'string') break
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
          if (ev === 'started' || ev === 'stopped' || ev === 'crash' || ev === 'circuit_breaker') {
            clearPhase(msg.instanceId, null)
          }
          // 实例列表状态变化时刷新列表（runningCount 等）
          void queryClient.invalidateQueries({ queryKey: queryKeys.instances() })
          // 详情同步失效：isRunning 镜像自详情 query（server store），只刷列表会让
          // 面板外停止（如终端输 stop）后的停止状态条滞后到 30s 轮询才翻转
          void queryClient.invalidateQueries({ queryKey: queryKeys.instance(msg.instanceId) })
          // 崩溃产物与崩溃历史都是事后新增的文件，轮询没有意义（每次都要枚举目录 + 解析），
          // 只在崩溃事件到达时失效一次。放在这里而不是页面里：帮助页、仪表盘都可能正开着，
          // 页面级失效只对「当时挂载着的那个页面」生效。
          if (ev === 'crash') {
            void queryClient.invalidateQueries({
              queryKey: queryKeys.crashArtifact(msg.instanceId),
            })
            void queryClient.invalidateQueries({ queryKey: queryKeys.crashHistory(msg.instanceId) })
          }
          // critical 事件（当前实例）：入通知中心 + 持久 toast（手动关闭防错过）
          if (ev === 'crash' || ev === 'circuit_breaker') {
            dispatchEvent({
              type: 'statusEvent',
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
              type: 'statusEvent',
              data: msg.data as Record<string, unknown>,
              instanceId: msg.instanceId,
            })
          }
          break
        }
        case 'statusSnapshot': {
          // 快照是**状态**（此刻的值）：订阅时补发 + 周期性广播，客户端直接覆盖即可
          applyWsSnapshot(msg.instanceId, {
            status: String(data.status ?? ''),
            isRunning: Boolean(data.isRunning),
            players: (data.players as unknown[]) ?? [],
            tps: typeof data.tps === 'number' ? data.tps : null,
          })
          // 推送面连通状态（`capabilities.msmpPush`）也随快照回来：REST 详情是轮询取的，
          // 断连不会让它失效，界面会滞后一个轮询周期才把「实时」翻成「轮询」——期间它在说一件
          // 已经不再成立的事。快照是推送的 ⇒ 就地写进详情缓存，界面即时对齐。
          // 三态同 `worldUpgrade`：布尔＝权威值、**字段缺席＝未知**（旧服务端）⇒ 保持现状。
          if (typeof data.msmpPush === 'boolean') {
            queryClient.setQueryData(queryKeys.instance(msg.instanceId), (prev) => {
              if (!prev || typeof prev !== 'object') return prev
              const detail = prev as { capabilities?: Record<string, unknown> }
              return {
                ...detail,
                capabilities: { ...detail.capabilities, msmpPush: data.msmpPush },
              }
            })
          }
          // 世界格式升级属 state 类事件（契约 WS_EVENT_KINDS），权威读法随快照回来。
          // 三态必须分开：对象＝在途、null＝**确认空闲**（清掉本地残留）、
          // **字段缺席＝未知**（旧服务端或无权限，保持现状）——缺席时若按「没有升级」处理，
          // 会把正在跑的进度条抹掉。
          if ('worldUpgrade' in data) {
            const inFlight = data.worldUpgrade as { progress?: number | null } | null
            if (inFlight === null) clearWorldUpgradeProgress(msg.instanceId)
            else applyWorldUpgradeFraction(msg.instanceId, inFlight?.progress)
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
        // 官方名单变化（面板外的 /op、/whitelist、/ban 也会推来）：只失效重取，
        // **不落通知条目**——面板自己的操作已经给过反馈，落条目会让同一次操作在通知中心
        // 出现两条（这正是「重复不双报」要避免的）
        case 'nameListChanged':
          void queryClient.invalidateQueries({ queryKey: queryKeys.players(msg.instanceId) })
          break
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
        // worldUpgrade（MC 世界格式升级，服务端经 MSMP 推送）单列：进度是「同一条消息的
        // 连续修正」（1 条/秒），交通知层会刷爆列表，故就地更新一条进度条，只有跃迁
        // （started / finished / failed）才交回通知层——见 lib/notifications.ts。
        case 'worldUpgrade': {
          const data = msg.data as Record<string, unknown>
          // 按契约解析，但**不因为解析失败就整条丢掉**：本分支存在的意义就是让进度可见，
          // 静默丢弃会把「服务端改了字段」表现成「进度条有时不出现」。故失败时照旧按宽松读取
          // 处置，并留一条痕给出定位线索。
          const parsed = wsWorldUpgradePayloadSchema.safeParse(msg.data)
          if (!parsed.success) {
            console.warn('[ws] worldUpgrade 载荷不符合契约，按宽松读取处置', parsed.error.issues)
          }
          const state = parsed.success ? parsed.data.state : String(data.state ?? '')
          if (state === 'progress') {
            const raw = parsed.success ? parsed.data.progress : data.progress
            // 判据必须是 typeof number：契约允许 progress 为 null（零参通知的 params 整个缺席
            // 时服务端就发 null），而 `Number(null) === 0` 会被当成合法的 0% 渲染出一条恒空的条。
            // 量纲（0..1 分数 → 百分数）在 applyWorldUpgradeFraction 里只换算一次。
            if (typeof raw === 'number') applyWorldUpgradeFraction(msg.instanceId, raw)
            break
          }
          // 开始与终态都清一次：开始清掉上一轮残留（服务端被强杀时没有终态事件），
          // 终态清掉本条进度条
          clearWorldUpgradeProgress(msg.instanceId)
          dispatchEvent({ type: msg.type, data, instanceId: msg.instanceId })
          break
        }
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
