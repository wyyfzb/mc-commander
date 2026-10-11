import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

/**
 * 「面板已改、但重启实例才生效」跟踪（跨刷新持久化）。
 *
 * 为什么需要它：这类改动保存后**不会**立即生效，要重启实例才应用——这是持续状态
 * （design-review-guidelines.md 的反馈级别三级），但保存动作发生在「保存后即关闭」的弹窗里，
 * 那里没有可见的常驻载体，故口径此前只能临时写进 toast 文案（几秒即散）。
 * 用户在重启前完全可能忘记自己改过什么。
 *
 * 三个动作构成闭环：保存置位 / 重启后清除 / 跨刷新持久化。
 * 载体：实例卡片上的「待重启」徽章（逐台注明）+ 实例页页头横幅（一处汇总）。
 * 清除有**两条来源**，缺一即有徽章撤不掉的实例：① WS `started` 事件（当前实例即时生效）；
 * ② `restartApplied` 按已轮询到的详情报判（非当前实例不订阅它的 status 事件，见该函数注释）。
 *
 * 范围＝**只有重启才能生效的实例级设置**：启动配置（内存 / Aikar / JVM 参数）与实时推送开关
 * （MSMP 只在服务端启动时读配置）。刻意不含世界属性、server.properties 文件、插件启停三类
 * 同主题但语义不一的改动（属性有逐项例外、插件是文件级，且服务端仅在 isRunning 时返回
 * restartRequired）——混在一个集合里会让「重启后真的都生效了吗」失准。
 */

const STORAGE_KEY = 'mcs-restart-pending'

const EMPTY: Record<string, number> = {}

/**
 * 「已生效」判定的容差：`uptime` 是服务端按整秒取的，详情又是轮询取的，
 * 2 秒足以吸收取整与投递误差，又远小于任何一次真实重启的间隔。
 */
const APPLIED_TOLERANCE_MS = 2000

/**
 * 该实例的**运行起点**是否晚于置位时刻——晚于就说明那次改动已被一次重启消费。
 *
 * 为什么需要这条不依赖 WS 的判据：前端只订阅**当前实例**的 status 事件，卡片却能逐台置位
 * （从任意实例卡片的设置里改启动配置或实时推送）。非当前实例重启时它的 `started` 根本不会
 * 投递到本端 ⇒ 只靠事件消费，逐台徽章会永久残留、持续声称「待重启」。
 *
 * 两侧的都是浏览器时间（`uptime` 由服务端测、但换算与比较都在本端），时钟偏差在比较中相消。
 * @param nowMs 当前浏览器时间
 * @param uptimeSeconds 实例运行时长；服务端口径：运行中为「现在 − 启动时刻」，未运行为 0
 * @param markedAtMs 置位时刻（保存那次改动的时间）
 */
export function restartApplied(nowMs: number, uptimeSeconds: number, markedAtMs: number): boolean {
  if (!Number.isFinite(uptimeSeconds) || uptimeSeconds < 0) return false
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
  /** 实例 id → 置位时刻（epoch ms）。存时刻而非布尔：`restartApplied` 要拿它和实例的运行起点
      比大小来判「这次改动是否已被一次重启消费」——布尔给不出这个判据 */
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
