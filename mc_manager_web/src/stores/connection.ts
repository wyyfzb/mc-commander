import { create } from 'zustand'
import type { ConnectionConfig } from '@/api/client'
import { getStoredSession } from '@/stores/auth'

/**
 * 连接配置（设计文档 §3.2 onboarding 简化页的数据源）
 * 默认同源（dev 走 Vite proxy /api；生产由 Express 同源托管）
 * 持久化 localStorage；严禁在源码中写真实服务器信息
 *
 * 安全主线：status 推导升级为双凭据——
 * - API Key（自动化通道，localStorage mcs-connection）
 * - 管理员会话令牌（浏览器登录通道，localStorage mcs-session，auth store）
 * 任一存在即 ready；密码登录用户（无 API Key）与 API Key 直连用户行为一致
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

/** 连接就绪判定：API Key 或管理员会话任一存在（auth store 读取，单向依赖无环） */
function hasCredentials(apiKey: string): boolean {
  return Boolean(apiKey || getStoredSession()?.token)
}

interface ConnectionState extends ConnectionConfig {
  status: ConnectionStatus
  setConfig: (config: Partial<ConnectionConfig>) => void
  setStatus: (status: ConnectionStatus) => void
  /** 按当前凭据（API Key + 会话令牌）重算 status（auth 状态变更后由其触发） */
  refreshStatus: () => void
}

export const useConnectionStore = create<ConnectionState>()((set, get) => {
  const initial = readInitialConfig()
  return {
    ...initial,
    status: hasCredentials(initial.apiKey) ? 'ready' : 'unconfigured',
    setConfig: (config) => {
      set((s) => {
        const next = { baseUrl: config.baseUrl ?? s.baseUrl, apiKey: config.apiKey ?? s.apiKey }
        try {
          localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(next))
        } catch {
          // 忽略持久化失败
        }
        return { ...next, status: hasCredentials(next.apiKey) ? 'ready' : 'unconfigured' }
      })
    },
    setStatus: (status) => set({ status }),
    refreshStatus: () => {
      set({ status: hasCredentials(get().apiKey) ? 'ready' : 'unconfigured' })
    },
  }
})
