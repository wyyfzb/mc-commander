import { create } from 'zustand'

/**
 * 世界存档格式升级的进度（WS worldUpgrade 的 progress 推送，服务端 1 条/秒）。
 *
 * 与备份进度同源取舍：瞬态 UI 状态，不落 query 缓存、**不进通知中心**——
 * 1 秒级推送若每条都生成通知条目，会刷爆列表、并在每次推送时写一遍 localStorage；
 * 而进度本身是「同一条消息的连续修正」，天然属于就地更新。终态（finished / failed）
 * 与开始（started）由分发器显式清除，避免上一轮的陈旧百分比留在界面上。
 */
interface WorldUpgradeProgressState {
  /** 按实例 ID 存最近一次进度（**百分数** 0-100：分发器已把协议的 0..1 分数换算过来） */
  progress: Record<string, number>
}

export const useWorldUpgradeProgressStore = create<WorldUpgradeProgressState>(() => ({
  progress: {},
}))

export function applyWorldUpgradeProgress(instanceId: string, percent: number) {
  useWorldUpgradeProgressStore.setState((state) => ({
    progress: { ...state.progress, [instanceId]: percent },
  }))
}

export function clearWorldUpgradeProgress(instanceId: string) {
  useWorldUpgradeProgressStore.setState((state) => {
    if (!(instanceId in state.progress)) return state
    const next = { ...state.progress }
    delete next[instanceId]
    return { progress: next }
  })
}

/**
 * 把协议的 **0..1 分数**换算成进度条吃的百分数并落库。
 *
 * 量纲只在这里换算一次：实时 `progress` 事件与状态快照带回来的在途值都走它，就不会出现
 * 「某条路直灌原值 ⇒ 条恒在 1% 以下、标签恒 0%」这类分叉。取不到数值（null / 非有限数）
 * 时**不动**已有值——「没读到」不该被当成「读到了 0」。
 */
export function applyWorldUpgradeFraction(instanceId: string, fraction: number | null | undefined) {
  if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return
  applyWorldUpgradeProgress(instanceId, fraction * 100)
}
