import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { migrateFromLegacyKeys, STORAGE_KEY } from '@/lib/migrate-ui-keys'

/**
 * 全局 UI 态（zustand persist，设计文档 §二/5.1）
 * 主题 / 界面密度 / 终端自动滚动 / 命令确认偏好 —— localStorage 持久化
 * 侧栏折叠 / 命令面板 / 通知抽屉 / 移动端导航 —— 纯会话态，不持久化
 */

export type ThemeMode = 'dark' | 'light'

/** 界面密度档（density.css：default 40px 舒适 / compact 32px 密集） */
export type DensityMode = 'default' | 'compact'

interface UiState {
  theme: ThemeMode
  sidebarCollapsed: boolean
  commandPaletteOpen: boolean
  /** 通知抽屉开合（顶栏铃铛 + 仪表盘事件卡「全部 →」共享一个状态） */
  notificationsOpen: boolean
  /** 移动端侧栏抽屉开合（<768px 窄屏；桌面端不使用） */
  mobileNavOpen: boolean
  /** 界面密度（B5：density.css 联动，compact 32px 密集行） */
  density: DensityMode
  /** 终端自动滚动（B5：新日志自动滚动到底部；关闭后不跟随） */
  terminalAutoScroll: boolean
  /** 命令执行二次确认（B5：危险命令执行前弹确认；终端专家通道除外） */
  confirmCommands: boolean
  setTheme: (theme: ThemeMode) => void
  toggleTheme: () => void
  toggleSidebar: () => void
  setCommandPaletteOpen: (open: boolean) => void
  setNotificationsOpen: (open: boolean) => void
  toggleMobileNav: () => void
  setMobileNavOpen: (open: boolean) => void
  setDensity: (density: DensityMode) => void
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
      density: 'default',
      terminalAutoScroll: true,
      confirmCommands: false,
      setTheme: (theme) => set({ theme }),
      toggleTheme: () => set((s) => ({ theme: s.theme === 'dark' ? 'light' : 'dark' })),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
      setNotificationsOpen: (open) => set({ notificationsOpen: open }),
      toggleMobileNav: () => set((s) => ({ mobileNavOpen: !s.mobileNavOpen })),
      setMobileNavOpen: (open) => set({ mobileNavOpen: open }),
      setDensity: (density) => set({ density }),
      setTerminalAutoScroll: (enabled) => set({ terminalAutoScroll: enabled }),
      setConfirmCommands: (enabled) => set({ confirmCommands: enabled }),
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      /** 仅持久化用户偏好，不持久化会话态 */
      partialize: (state) => ({
        theme: state.theme,
        density: state.density,
        terminalAutoScroll: state.terminalAutoScroll,
        confirmCommands: state.confirmCommands,
      }),
    },
  ),
)
