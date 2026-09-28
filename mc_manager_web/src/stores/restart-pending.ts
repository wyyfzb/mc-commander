import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

/**
 * 启动配置「待重启生效」跟踪（跨刷新持久化）。
 *
 * 为什么需要它：启动配置（内存 / Aikar / JVM 参数）保存后**不会**立即生效，要重启实例才
 * 应用——这是持续状态（design-review-guidelines.md 的反馈级别三级），但保存动作发生在
 * 「保存后即关闭」的弹窗里，那里没有可见的常驻载体，故口径此前只能临时写进 toast 文案
 * （几秒即散）。用户在重启前完全可能忘记自己改过什么。
 *
 * 三个动作构成闭环：保存置位 / 重启（started 事件）清除 / 跨刷新持久化。
 *
 * 范围刻意只覆盖**启动配置**：世界属性、server.properties 文件、插件启停三类同一主题但
 * 语义不一（属性有逐项例外、插件是文件级，且服务端仅在 isRunning 时返回 restartRequired），
 * 混在一个集合里会让「重启后真的都生效了吗」失准，故不入本集合。
 */

const STORAGE_KEY = 'mcs-restart-pending'

const EMPTY: Record<string, number> = {}

/**
 * 载荷归一：只保留「键是非空字符串、值是非负有限数」的条目。
 *
 * localStorage 是用户可改、旧版本可迁移的外部输入：`pending` 为 null 会让
 * `Object.keys` 在 render 期抛错（整页白屏）；为字符串/数组则会把下标或字符当成实例 id
 * 渲染出来（指示器说谎）。两者都在本仓既有口径的防护面上（见 lib/migrate-ui-keys.ts 的
 * 逐项校验、stores/notifications.ts 的 parseStored），此处同样逐项核验而非整块信任。
 */
function normalizePending(raw: unknown): Record<string, number> {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return EMPTY
  const out: Record<string, number> = {}
  for (const [id, at] of Object.entries(raw as Record<string, unknown>)) {
    if (id === '' || typeof at !== 'number' || !Number.isFinite(at) || at < 0) continue
    out[id] = at
  }
  return out
}

interface RestartPendingState {
  /** 实例 id → 置位时刻（epoch ms）。存时刻而非布尔：指示器要如实说明「什么时候改的」 */
  pending: Record<string, number>
  /** 保存启动配置后置位 */
  markPending: (instanceId: string) => void
  /** 实例重启后清除（由 started 事件驱动） */
  clearPending: (instanceId: string) => void
  /**
   * 丢弃列表里已不存在的实例条目（实例被卸载后其 started 永不再来，
   * 不清就会留一条永远撤不掉的横幅）。
   */
  pruneTo: (existingIds: ReadonlySet<string>) => void
}

export const useRestartPendingStore = create<RestartPendingState>()(
  persist(
    (set) => ({
      pending: EMPTY,
      markPending: (instanceId) =>
        set((s) => ({ pending: { ...s.pending, [instanceId]: Date.now() } })),
      clearPending: (instanceId) =>
        set((s) => {
          if (s.pending[instanceId] === undefined) return s
          const next = { ...s.pending }
          delete next[instanceId]
          return { pending: next }
        }),
      pruneTo: (existingIds) =>
        set((s) => {
          const kept = Object.keys(s.pending).filter((id) => existingIds.has(id))
          if (kept.length === Object.keys(s.pending).length) return s
          const next: Record<string, number> = {}
          for (const id of kept) next[id] = s.pending[id]!
          return { pending: next }
        }),
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      /** 读回时归一：损坏载荷不得进入 store（见 normalizePending 注释） */
      merge: (persisted, current) => ({
        ...current,
        pending: normalizePending((persisted as { pending?: unknown } | undefined)?.pending),
      }),
    },
  ),
)
