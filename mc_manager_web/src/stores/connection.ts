import { create } from 'zustand'
import type { ConnectionConfig } from '@/api/client'

/**
 * 连接配置（设计文档 §3.2 onboarding 简化页的数据源）
 * 默认同源（dev 走 Vite proxy /api；生产由 Express 同源托管）
 * 持久化 localStorage；严禁在源码中写真实服务器信息
 */

const CONFIG_STORAGE_KEY = 'mcs-connection'

export type ConnectionStatus = 'unconfigured' | 'configuring' | 'ready'

function readInitialConfig(): ConnectionConfig {
  try {
    const raw = localStorage.getItem(CONFIG_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ConnectionConfig>
      return {
        baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : '',
        apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
      }
    }
  } catch {
    // 解析失败回退默认
  }
  return { baseUrl: '', apiKey: '' }
}

interface ConnectionState extends ConnectionConfig {
  status: ConnectionStatus
  setConfig: (config: Partial<ConnectionConfig>) => void
  setStatus: (status: ConnectionStatus) => void
}

export const useConnectionStore = create<ConnectionState>()((set) => {
  const initial = readInitialConfig()
  return {
    ...initial,
    status: initial.apiKey ? 'ready' : 'unconfigured',
    setConfig: (config) => {
      set((s) => {
        const next = { baseUrl: config.baseUrl ?? s.baseUrl, apiKey: config.apiKey ?? s.apiKey }
        try {
          localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(next))
        } catch {
          // 忽略持久化失败
        }
        return { ...next, status: next.apiKey ? 'ready' : 'unconfigured' }
      })
    },
    setStatus: (status) => set({ status }),
  }
})
