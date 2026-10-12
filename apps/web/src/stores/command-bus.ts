import { create } from 'zustand'

/**
 * 命令总线 —— Cmd+K 命令面板（全局）与命令执行器之间的桥
 * 双槽设计：
 * - baseRunner：AppShell 全局执行器（命令面板全站可用）
 * - overlayRunner：仪表盘挂载时的终端回显执行器（高优先级，卸载自动回退）
 * 面板消费 runner = overlayRunner ?? baseRunner
 */
interface CommandBusState {
  /** 全局执行器（CommandBridge 注册） */
  baseRunner: ((command: string) => void) | null
  /** 终端回显执行器（仪表盘 CommandInput 注册） */
  overlayRunner: ((command: string) => void) | null
  setBaseRunner: (runner: ((command: string) => void) | null) => void
  setOverlayRunner: (runner: ((command: string) => void) | null) => void
}

export const useCommandBus = create<CommandBusState>()((set) => ({
  baseRunner: null,
  overlayRunner: null,
  setBaseRunner: (runner) => set({ baseRunner: runner }),
  setOverlayRunner: (runner) => set({ overlayRunner: runner }),
}))
