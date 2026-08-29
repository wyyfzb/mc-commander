import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { McSocket } from '@/api/ws'
import { queryKeys } from '@/api/queries'
import { useConnectionStore } from '@/stores/connection'
import { useAuthStore } from '@/stores/auth'
import { useServerStore } from '@/stores/server'
import { useDeployStore } from '@/stores/deploy'
import { applyUpgradeProgress } from '@/stores/upgrade'
import { useNotificationStore } from '@/stores/notifications'
import { useTerminalStore } from '@/stores/terminal'
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

export function useServerSocket(instanceId: string | null) {
  const apiKey = useConnectionStore((s) => s.apiKey)
  const baseUrl = useConnectionStore((s) => s.baseUrl)
  const connectionReady = useConnectionStore((s) => s.status === 'ready')
  // 安全主线：会话令牌优先于 API Key 作为 WS 鉴权凭据（登录后 session 变更触发重建连接）
  const sessionToken = useAuthStore((s) => s.session?.token ?? null)
  const applyWsSnapshot = useServerStore((s) => s.applyWsSnapshot)
  const applyWsPerformance = useServerStore((s) => s.applyWsPerformance)
  const applyWsStatusEvent = useServerStore((s) => s.applyWsStatusEvent)
  const setSocketConnected = useServerStore((s) => s.setSocketConnected)
  const setHasConnectedOnce = useServerStore((s) => s.setHasConnectedOnce)
  const dispatchWsEvent = useNotificationStore((s) => s.dispatchWsEvent)
  const dispatchPerformance = useNotificationStore((s) => s.dispatchPerformance)
  const applyDeployProgress = useDeployStore((s) => s.applyDeployProgress)
  const pushLog = useTerminalStore((s) => s.pushEntry)
  const queryClient = useQueryClient()

  // 当前订阅的实例（ref 供事件处理器读取最新值）
  const instanceRef = useRef(instanceId)
  instanceRef.current = instanceId

  useEffect(() => {
    if (!connectionReady || (!apiKey && !sessionToken)) return

    let socket = socketSingleton
    if (!socket) {
      socket = new McSocket({ apiKey, baseUrl, sessionToken })
      socketSingleton = socket
    }

    let disposed = false

    const handleMessage = (msg: WsMessage) => {
      const data = (msg.data ?? {}) as Record<string, unknown>

      // 全局进度事件（部署：创建新实例前即有进度，无实例归属）
      if (msg.type === 'deployProgress') {
        applyDeployProgress({
          stage: String(data.stage ?? ''),
          percent: Number(data.percent ?? 0),
          transferred: Number(data.transferred ?? 0),
          total: Number(data.total ?? 0),
          ...(data.error ? { error: String(data.error) } : {}),
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
        if (stage === 'completed' || stage === 'failed' || stage === 'rolled_back') {
          // 终态：刷新实例列表（版本号/JAR 已变更）
          void queryClient.invalidateQueries({ queryKey: queryKeys.instances() })
        }
        return
      }

      if (!msg.instanceId || msg.instanceId !== instanceRef.current) return

      switch (msg.type) {
        case 'status': {
          if (data.event && typeof data.event === 'string') {
            applyWsStatusEvent(data.event as 'started' | 'stopped' | 'ready' | 'crash' | 'save')
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
          // 告警状态机（TPS/CPU/内存跃迁单次通知）
          dispatchPerformance({ tps: p.tps, cpu: p.cpu })
          break
        }
        case 'log': {
          pushLog(msg.instanceId, String(data.text ?? ''), (data.type as 'stdout' | 'stderr' | 'command') ?? 'stdout')
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
                    ? ({ ...(update.position as Record<string, unknown>) } as unknown as Player['position'])
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
          dispatchWsEvent({ type: msg.type, data: msg.data as Record<string, unknown>, instanceId: msg.instanceId })
          break
        case 'weatherUpdate':
        case 'backupStart':
        case 'backupComplete':
        case 'backupFailed':
        case 'backupSkipped':
        case 'restoreStart':
        case 'restoreComplete':
        case 'restoreFailed':
        case 'taskFailed':
          dispatchWsEvent({ type: msg.type, data: msg.data as Record<string, unknown>, instanceId: msg.instanceId })
          break
        default:
          break
      }
    }

    const off = socket.on(handleMessage)

    void socket.connect().then(() => {
      if (disposed) return
      setSocketConnected(true)
      setHasConnectedOnce(true)
      if (instanceRef.current) {
        socket?.subscribe(instanceRef.current)
      }
    }).catch(() => {
      // 连接失败由 McSocket 重连逻辑接管
    })

    return () => {
      disposed = true
      off()
      setSocketConnected(false)
      // 单例保留（跨页面复用）；实例切换由下方 effect 处理订阅
    }
  }, [connectionReady, apiKey, sessionToken, baseUrl, applyWsSnapshot, applyWsPerformance, applyWsStatusEvent, setSocketConnected, setHasConnectedOnce, dispatchWsEvent, dispatchPerformance, applyDeployProgress, pushLog, queryClient])

  // 实例切换：更新订阅
  useEffect(() => {
    const socket = socketSingleton
    if (!socket || !connectionReady || !instanceId) return
    socket.subscribe(instanceId)
  }, [instanceId, connectionReady])

  return socketSingleton
}
