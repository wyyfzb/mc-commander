import { create } from 'zustand'
import type { UpgradeProgress, UpgradeStage } from '@/api/types'

/** 升级阶段中文标签 */
export const UPGRADE_STAGE_LABELS: Record<UpgradeStage, string> = {
  backup: '备份中',
  download: '下载中',
  replace: '替换中',
  verify: '启动校验',
  completed: '升级完成',
  failed: '升级失败',
  rolled_back: '已回滚',
  // 用户取消（detail 会写明是否回滚，见服务端 UpgradeService）
  cancelled: '已取消',
}

/**
 * 升级终态阶段（单一事实源）：弹窗视图切换、实例卡「升级中」徽章、socket 终态失效刷新
 * 三处共用——此前各写一份名单，新增阶段（如 cancelled）必然漏改其中一两处
 */
export const UPGRADE_TERMINAL_STAGES: ReadonlySet<UpgradeStage> = new Set([
  'completed',
  'failed',
  'rolled_back',
  'cancelled',
])

/** 是否已到终态（未到 = 升级进行中） */
export function isUpgradeTerminal(stage: UpgradeStage | undefined | null): boolean {
  return stage != null && UPGRADE_TERMINAL_STAGES.has(stage)
}

interface UpgradeState {
  /** 按实例 ID 存储进度 */
  progress: Record<string, UpgradeProgress>
}

export const useUpgradeStore = create<UpgradeState>(() => ({
  progress: {},
}))

export function applyUpgradeProgress(data: UpgradeProgress) {
  useUpgradeStore.setState((state) => ({
    progress: { ...state.progress, [data.instanceId]: data },
  }))
}

export function getUpgradeProgress(instanceId: string): UpgradeProgress | null {
  return useUpgradeStore.getState().progress[instanceId] || null
}

export function clearUpgradeProgress(instanceId: string) {
  useUpgradeStore.setState((state) => {
    const next = { ...state.progress }
    delete next[instanceId]
    return { progress: next }
  })
}
