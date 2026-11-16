import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { migrateFromLegacyKeys, STORAGE_KEY } from '@/lib/migrate-ui-keys'

/**
 * 全局 UI 态（zustand persist）
 * 主题 / 终端自动滚动 / 命令确认偏好 —— localStorage 持久化
 * 侧栏折叠 / 命令面板 / 通知抽屉 / 移动端导航 —— 纯会话态，不持久化
 */

/**
 * 主题偏好：'system' 跟随操作系统的 prefers-color-scheme。
 * 它是**偏好**而不是第四种配色——实际落到哪一档由 useResolvedTheme 决定。
 */
export type ThemeMode = 'dark' | 'light' | 'system'

/** 实际生效的配色（DOM 上只有这两种类名） */
export type ResolvedTheme = 'dark' | 'light'

const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)'

/** 把主题偏好解析成实际配色；'system' 读操作系统偏好 */
export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode !== 'system') return mode
  try {
    return window.matchMedia(SYSTEM_DARK_QUERY).matches ? 'dark' : 'light'
  } catch {
    return 'dark'
  }
}

interface UiState {
  theme: ThemeMode
  sidebarCollapsed: boolean
  commandPaletteOpen: boolean
  /** 通知抽屉开合（顶栏铃铛 + 仪表盘事件卡「全部 →」共享一个状态） */
  notificationsOpen: boolean
  /** 移动端侧栏抽屉开合（<768px 窄屏；桌面端不使用） */
  mobileNavOpen: boolean
  /** 末尾日志弹窗（崩溃/熔断 toast「查看末尾日志」入口；存实例 id，null=关） */
  lastOutputInstanceId: string | null
  /**
   * 性能诊断 Sheet（告警条 / 崩溃卡 / 实例卡三个入口；存**目标实例 id**，null=关）。
   * 存 id 而非布尔：入口可能来自别的实例的上下文，读当前选中实例会静默查错服务器。
   */
  perfSheetInstanceId: string | null
  /** 终端自动滚动（B5：新日志自动滚动到底部；关闭后不跟随） */
  terminalAutoScroll: boolean
  /** 命令执行二次确认（B5：危险命令执行前弹确认；终端专家通道除外） */
  confirmCommands: boolean
  setTheme: (theme: ThemeMode) => void
  toggleTheme: () => void
  toggleSidebar: () => void
  setCommandPaletteOpen: (open: boolean) => void
  setNotificationsOpen: (open: boolean) => void
  setLastOutputInstanceId: (id: string | null) => void
  setPerfSheetInstanceId: (id: string | null) => void
  toggleMobileNav: () => void
  setMobileNavOpen: (open: boolean) => void
  setTerminalAutoScroll: (enabled: boolean) => void
  setConfirmCommands: (enabled: boolean) => void
}

/** 首次模块加载时执行旧 key 迁移 */
const legacyMigration = migrateFromLegacyKeys()
if (legacyMigration) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ state: legacyMigration, version: 0 }))
  } catch {
    // 迁移写入失败时回退默认值，不影响使用
  }
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      theme: 'dark',
      sidebarCollapsed: false,
      commandPaletteOpen: false,
      notificationsOpen: false,
      mobileNavOpen: false,
      lastOutputInstanceId: null,
      perfSheetInstanceId: null,
      terminalAutoScroll: true,
      confirmCommands: false,
      setTheme: (theme) => set({ theme }),
      // 快捷切换按**当前实际配色**取反：在 system 档下点一次要得到看得见的变化，
      // 之后固定在反色档（切回 system 走设置页）。按偏好值取反会让 system 永远变成 light。
      toggleTheme: () =>
        set((s) => ({ theme: resolveTheme(s.theme) === 'dark' ? 'light' : 'dark' })),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
      setNotificationsOpen: (open) => set({ notificationsOpen: open }),
      setLastOutputInstanceId: (id) => set({ lastOutputInstanceId: id }),
      setPerfSheetInstanceId: (id) => set({ perfSheetInstanceId: id }),
      toggleMobileNav: () => set((s) => ({ mobileNavOpen: !s.mobileNavOpen })),
      setMobileNavOpen: (open) => set({ mobileNavOpen: open }),
      setTerminalAutoScroll: (enabled) => set({ terminalAutoScroll: enabled }),
      setConfirmCommands: (enabled) => set({ confirmCommands: enabled }),
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      /** 仅持久化用户偏好，不持久化会话态 */
      partialize: (state) => ({
        theme: state.theme,
        terminalAutoScroll: state.terminalAutoScroll,
        confirmCommands: state.confirmCommands,
      }),
    },
  ),
)
