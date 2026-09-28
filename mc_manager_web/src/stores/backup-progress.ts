import { create } from 'zustand'

/**
 * 备份/恢复进行中操作的进度（WS backupProgress / restoreProgress 推送，
 * 服务端 1s 节流）。
 *
 * 瞬态 UI 状态，不落 query 缓存、不进通知中心：1s 级推送走 invalidate 或
 * 通知条目都会刷爆列表；终态（complete/failed/cancelled 事件）由分发器
 * 显式清除，列表查询自带的轮询负责兜底收敛。
 */
export interface BackupProgress {
  kind: 'create' | 'restore'
  backupId: number
  /** 0-100；rsync --info=progress2 解析值。robocopy/ditto 降级路径无推送 */
  percent: number
}

interface BackupProgressState {
  /** 按实例 ID 存储最近一次进度 */
  progress: Record<string, BackupProgress>
}

export const useBackupProgressStore = create<BackupProgressState>(() => ({
  progress: {},
}))

export function applyBackupProgress(
  instanceId: string,
  kind: BackupProgress['kind'],
  backupId: number,
  percent: number,
) {
  useBackupProgressStore.setState((state) => ({
    progress: { ...state.progress, [instanceId]: { kind, backupId, percent } },
  }))
}

export function clearBackupProgress(instanceId: string) {
  useBackupProgressStore.setState((state) => {
    if (!(instanceId in state.progress)) return state
    const next = { ...state.progress }
    delete next[instanceId]
    return { progress: next }
  })
}
