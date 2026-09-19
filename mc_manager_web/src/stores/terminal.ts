import { create } from 'zustand'
import {
  entriesFromHistory,
  inferLevel,
  isJvmWarning,
  pushLogEntry,
  type TerminalLogEntry,
} from '@/lib/terminal-log'

/**
 * 终端日志缓冲 store（设计文档 §5.2：切页不丢，组件卸载时状态提升到 store）
 * - WS log 事件 → pushEntry（2000 条上限）
 * - 历史日志仅当缓冲为空时填充（防重复）
 * - 手动清空后 suppressBackfill 标记：组件重建不再回填历史
 */
interface TerminalState {
  buffer: TerminalLogEntry[]
  instanceId: string | null
  suppressBackfill: boolean

  /** 实例切换：清空旧实例日志 + 重置标记 */
  setInstance: (instanceId: string | null) => void
  /** 历史日志填充（仅空缓冲时） */
  fillHistory: (
    instanceId: string,
    logs: Array<{ text: string; type: 'stdout' | 'stderr' }>,
  ) => void
  /** WS log 事件推入 */
  pushEntry: (instanceId: string, text: string, type: 'stdout' | 'stderr' | 'command') => void
  /** 手动清空（置 suppressBackfill：组件重建不再回填历史） */
  clear: () => void
  /** 启动/重启联动清空（保留回填：新进程日志重新填充） */
  resetForRestart: () => void
}

export const useTerminalStore = create<TerminalState>()((set, get) => ({
  buffer: [],
  instanceId: null,
  suppressBackfill: false,

  setInstance: (instanceId) => {
    if (get().instanceId === instanceId) return
    set({ instanceId, buffer: [], suppressBackfill: false })
  },

  fillHistory: (instanceId, logs) => {
    const s = get()
    if (s.instanceId !== instanceId) return
    if (s.suppressBackfill) return
    if (s.buffer.length > 0) return // 仅空缓冲时填充（防重复）
    const entries = entriesFromHistory(logs)
    if (entries.length === 0) return
    set({ buffer: entries })
  },

  pushEntry: (instanceId, text, type) => {
    if (get().instanceId !== instanceId) return
    set((s) => ({
      buffer: pushLogEntry(s.buffer, {
        text,
        level: inferLevel(text, type),
        jvmWarning: isJvmWarning(text),
      }),
    }))
  },

  clear: () => set({ buffer: [], suppressBackfill: true }),

  resetForRestart: () => set({ buffer: [], suppressBackfill: false }),
}))
