/**
 * 面板级偏好的内存副本（跨设备一致的配置）。
 *
 * 为什么要有这一层：偏好由多个互不相关的部件消费（仪表盘输入框、公告卡、
 * 礼包弹窗、传送标签页、设置页开关），其中通知开关还在 WS 事件热路径上
 * 以 getState() 同步读取。让它们各自发请求既不现实（每处都要 loading 态），
 * 也会在同一份数据上并存多份副本。故启动时拉一次，之后只读内存。
 *
 * 未拉取完成前读到的是默认值——与「从未配置过」同义，不是错误态：
 * 面板每次打开都会拉，用户看到的差异最多一瞬。
 */
import { create } from 'zustand'
import type { PanelPreferences } from '@mc-commander/schemas'
import { apiGetPreferences, apiPutPreferences } from '@/api/preferences'
import { useConnectionStore } from '@/stores/connection'

interface PanelPreferencesState {
  /** 服务端返回的原始快照；null = 尚未拉取 */
  remote: PanelPreferences | null
  /** 正在写入（供界面禁用对应控件，避免连点覆盖） */
  saving: boolean
  /** 从服务端拉取全量偏好；失败静默（下次打开面板再拉） */
  hydrate: () => Promise<void>
  /** 写入若干项；乐观更新内存，失败回滚并抛出由调用方提示 */
  save: (patch: PanelPreferences) => Promise<void>
}

export const usePanelPreferencesStore = create<PanelPreferencesState>()((set, get) => ({
  remote: null,
  saving: false,

  hydrate: async () => {
    const config = useConnectionStore.getState()
    if (config.status !== 'ready') return
    try {
      const data = await apiGetPreferences(config)
      set({ remote: data })
    } catch {
      // 拉取失败保持未拉取状态：调用方按默认值渲染，不打断使用
    }
  },

  save: async (patch) => {
    // 未拉取完成时拒绝写入：此时内存里没有服务端那份，调用方算出的「新列表」
    // 是从默认值派生的，写上去会把用户已有的预设整份覆盖掉。宁可提示失败。
    if (get().remote === null) {
      throw new Error('偏好尚未加载完成，请稍后重试')
    }
    const config = useConnectionStore.getState()
    const previous = get().remote
    set({ remote: { ...(previous ?? {}), ...patch }, saving: true })
    try {
      const data = await apiPutPreferences(config, patch)
      set({ remote: data, saving: false })
    } catch (err) {
      set({ remote: previous, saving: false })
      throw err
    }
  },
}))

/** 偏好是否已从服务端拉回（false 时写入会被拒绝） */
export function isPreferenceLoaded(): boolean {
  return usePanelPreferencesStore.getState().remote !== null
}

/**
 * 同步读取一项偏好，未配置时用兜底值。
 *
 * 同步是有意的：消费方（快捷指令、礼包、传送点）要在渲染期直接派生列表，
 * 异步会让它们各写一套「先空后填」的过渡态，而过渡态本身就是陈旧副本的来源。
 */
export function readPreference<K extends keyof PanelPreferences>(
  key: K,
  fallback: NonNullable<PanelPreferences[K]>,
): NonNullable<PanelPreferences[K]> {
  const value = usePanelPreferencesStore.getState().remote?.[key]
  return (value ?? fallback) as NonNullable<PanelPreferences[K]>
}

/**
 * 写入一项偏好。失败时抛出，由调用方决定是否提示——
 * 这些操作都是用户显式点击触发的，静默失败会让用户以为已经存下。
 */
export function writePreference<K extends keyof PanelPreferences>(
  key: K,
  value: NonNullable<PanelPreferences[K]>,
): Promise<void> {
  return usePanelPreferencesStore.getState().save({ [key]: value })
}
