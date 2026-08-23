import { create } from 'zustand'

/**
 * 全局 UI 态（zustand，设计文档 §二/5.1）
 * 主题 / 侧栏折叠 / 命令面板开合 —— 本地偏好类状态
 */

export type ThemeMode = 'dark' | 'light'

/** 界面密度档（density.css：default 40px 舒适 / compact 32px 密集） */
export type DensityMode = 'default' | 'compact'

const THEME_STORAGE_KEY = 'mcs-theme'
const DENSITY_STORAGE_KEY = 'mcs-density'
const TERMINAL_AUTOSCROLL_KEY = 'mcs-terminal-autoscroll'
const CONFIRM_COMMANDS_KEY = 'mcs-confirm-commands'

function readStoredBoolean(key: string, fallback: boolean): boolean {
  try {
    const saved = localStorage.getItem(key)
    if (saved === 'true' || saved === 'false') return saved === 'true'
  } catch {
    // localStorage 不可用（隐私模式等）时回退默认
  }
  return fallback
}

function readDensity(): DensityMode {
  try {
    const saved = localStorage.getItem(DENSITY_STORAGE_KEY)
    if (saved === 'default' || saved === 'compact') return saved
  } catch {}
  return 'default'
}

function readInitialTheme(): ThemeMode {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY)
    if (saved === 'dark' || saved === 'light') return saved
  } catch {
    // localStorage 不可用（隐私模式等）时回退深色优先
  }
  return 'dark' // P4 深色优先
}

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

export const useUiStore = create<UiState>()((set, get) => ({
  theme: readInitialTheme(),
  sidebarCollapsed: false,
  commandPaletteOpen: false,
  notificationsOpen: false,
  mobileNavOpen: false,
  density: readDensity(),
  terminalAutoScroll: readStoredBoolean(TERMINAL_AUTOSCROLL_KEY, true),
  confirmCommands: readStoredBoolean(CONFIRM_COMMANDS_KEY, false),
  setTheme: (theme) => {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme)
    } catch {
      // 忽略持久化失败
    }
    set({ theme })
  },
  toggleTheme: () => get().setTheme(get().theme === 'dark' ? 'light' : 'dark'),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
  setNotificationsOpen: (open) => set({ notificationsOpen: open }),
  toggleMobileNav: () => set((s) => ({ mobileNavOpen: !s.mobileNavOpen })),
  setMobileNavOpen: (open) => set({ mobileNavOpen: open }),
  setDensity: (density) => {
    try {
      localStorage.setItem(DENSITY_STORAGE_KEY, density)
    } catch {}
    set({ density })
  },
  setTerminalAutoScroll: (enabled) => {
    try {
      localStorage.setItem(TERMINAL_AUTOSCROLL_KEY, String(enabled))
    } catch {}
    set({ terminalAutoScroll: enabled })
  },
  setConfirmCommands: (enabled) => {
    try {
      localStorage.setItem(CONFIRM_COMMANDS_KEY, String(enabled))
    } catch {}
    set({ confirmCommands: enabled })
  },
}))
