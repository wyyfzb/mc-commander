import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

/**
 * 「面板已改、但重启实例才生效」跟踪（跨刷新持久化）。
 *
 * 这类改动保存后不立即生效，是**持续状态**（该常驻，不能只靠几秒即散的 toast），而保存动作
 * 发生在「保存后即关闭」的弹窗里——用户在重启前会忘记自己改过什么。
 *
 * 范围＝只有重启才能生效的实例级设置（启动配置 + 实时推送）。刻意不含世界属性、
 * server.properties、插件启停：它们语义不一，混进一个集合会让「重启后都生效了吗」失准。
 * 清除有两路（缺一即有撤不掉的徽章）：WS `started`；`restartApplied` 按详情报判。
 * 载体：实例卡片「待重启」徽章（逐台）+ 实例页页头横幅（汇总）。
 */

const STORAGE_KEY = 'mcs-restart-pending'

const EMPTY: Record<string, number> = {}

/** uptime 按整秒取、详情又是轮询取的；2 秒吸收取整与投递误差，远小于任何真实重启间隔 */
const APPLIED_TOLERANCE_MS = 2000

/**
 * 该实例的运行起点是否晚于置位时刻（⇒ 那次改动已被一次重启消费）。
 *
 * 需要这条不依赖 WS 的判据：前端只订阅当前实例的 status 事件，而徽章能逐台置位——非当前实例的
 * `started` 不会投递到本端，只靠事件消费会让徽章永久残留。uptime 由服务端测、比较在本端，
 * 时钟偏差相消。
 * @param nowMs 当前浏览器时间
 * @param uptimeSeconds 实例运行时长；服务端口径：运行中为「现在 − 启动时刻」，未运行为 0
 * @param markedAtMs 置位时刻（保存那次改动的时间）
 */
export function restartApplied(nowMs: number, uptimeSeconds: number, markedAtMs: number): boolean {
  /* uptime 必须为正：未运行时服务端报 0，此时 now - 0 恒大于置位时刻，会得出「已生效」并抹掉徽章。
     判据不交给调用方的 isRunning 门控——那让本函数对单独调用恒为真，与它自述的语义不符 */
  if (!Number.isFinite(uptimeSeconds) || uptimeSeconds <= 0) return false
  return nowMs - uptimeSeconds * 1000 > markedAtMs + APPLIED_TOLERANCE_MS
}

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
  /** 实例 id → 置位时刻（epoch ms）。存时刻而非布尔：`restartApplied` 要拿它与运行起点比大小 */
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
