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
