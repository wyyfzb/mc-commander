import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type {
  InstanceStatus,
  SystemStats,
  WsPerformancePayload,
  WsStatusSnapshot,
} from '@/api/types'

const STORAGE_KEY = 'mcs-server'

/**
 * 服务器实时状态 store（WS 事件 → 分派；Query 轮询 30s 保底互补，设计文档 §5.2）
 * - performanceUpdate → 局部字段更新（500ms 节流由消费端按需处理）
 * - status 事件 → 触发全量刷新（消费端监听 event 变化后 fetch）
 * - systemStats：云服务器系统资源（独立于实例状态）
 */

export interface StatusEvent {
  event: 'started' | 'stopped' | 'ready' | 'crash' | 'save' | 'circuit_breaker'
  timestamp: number
}

/** 启停中间态（issue 334）：mutation 发令时置入，WS started/stopped/crash 确认后清除 */
export type InstancePhase = 'starting' | 'stopping'

interface ServerState {
  /** 当前实例全量状态（GET /instances/:id） */
  status: InstanceStatus | null
  /** 云服务器系统资源 */
  systemStats: SystemStats | null
  /** 当前订阅实例 id */
  instanceId: string | null
  /** WS 连接态 */
  socketConnected: boolean
  /** 是否曾成功连接过 WS（区分"初次连接中"与"实时通道断开"） */
  hasConnectedOnce: boolean
  /** 最近一次 status 跃迁事件（started/stopped/... 供全量刷新触发） */
  lastStatusEvent: StatusEvent | null
  /** 启停中间态表（按实例；空对象表示无在途启停） */
  phase: Record<string, InstancePhase>

  setStatus: (status: InstanceStatus | null) => void
  setSystemStats: (stats: SystemStats | null) => void
  setInstanceId: (id: string | null) => void
  setSocketConnected: (connected: boolean) => void
  setHasConnectedOnce: (value: boolean) => void
  /** 置/清实例启停中间态（phase=null 清除；清除不存在的 key 无害） */
  setPhase: (instanceId: string, phase: InstancePhase | null) => void
  /** WS status 快照（订阅即回）：合并局部字段 */
  applyWsSnapshot: (instanceId: string, snapshot: WsStatusSnapshot) => void
  /** performanceUpdate：合并局部字段 + 记状态跃迁 */
  applyWsPerformance: (payload: WsPerformancePayload) => void
  /** status 事件（started/stopped/...）：记录跃迁供消费端触发全量刷新 */
  applyWsStatusEvent: (event: StatusEvent['event']) => void
}

export const useServerStore = create<ServerState>()(
  persist(
    (set) => ({
      status: null,
      systemStats: null,
      instanceId: null,
      socketConnected: false,
      hasConnectedOnce: false,
      lastStatusEvent: null,
      phase: {},

      setStatus: (status) => set({ status }),
      setSystemStats: (systemStats) => set({ systemStats }),
      setInstanceId: (instanceId) => set({ instanceId }),
      setSocketConnected: (socketConnected) => set({ socketConnected }),
      setHasConnectedOnce: (hasConnectedOnce) => set({ hasConnectedOnce }),

      setPhase: (instanceId, phase) =>
        set((s) => {
          if (!phase) {
            if (!(instanceId in s.phase)) return {}
            const next = { ...s.phase }
            delete next[instanceId]
            return { phase: next }
          }
          return { phase: { ...s.phase, [instanceId]: phase } }
        }),

      applyWsSnapshot: (instanceId, snapshot) =>
        set((s) => {
          if (s.instanceId !== instanceId) return {}
          return {
            status: s.status
              ? {
                  ...s.status,
                  isRunning: snapshot.isRunning,
                  tps: snapshot.tps ?? s.status.tps,
                }
              : null,
          }
        }),

      applyWsPerformance: (payload) =>
        set((s) => {
          if (!s.status) return {}
          return {
            status: {
              ...s.status,
              cpuUsage: payload.cpu,
              memoryUsage: payload.memory,
              tps: payload.tps,
              mspt: payload.mspt,
              worldTime: payload.worldTime,
              worldDay: payload.worldDay,
              sleepingPlayers: payload.sleepingPlayers,
              sleepingPlayerNames: payload.sleepingPlayerNames,
              awakePlayerNames: payload.awakePlayerNames,
            },
          }
        }),

      applyWsStatusEvent: (event) => set({ lastStatusEvent: { event, timestamp: Date.now() } }),
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      /**
       * 只持久化「用户在看哪个实例」这一个选择，不持久化任何实时数据：
       * status/systemStats 是会话态，存下来会在刷新后先显示一份**过期快照**
       * （面板明明停了，界面还显示运行中），比短暂空白更有害。
       * phase 是启停中间态，跨刷新已无意义。
       */
      partialize: (state) => ({ instanceId: state.instanceId }),
      /** 读回时归一：非字符串（损坏/手改的载荷）一律当未选择 */
      merge: (persisted, current) => {
        const raw = (persisted as { instanceId?: unknown } | undefined)?.instanceId
        return { ...current, instanceId: typeof raw === 'string' && raw ? raw : null }
      },
    },
  ),
)
