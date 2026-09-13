import { create } from 'zustand'
import type { ConnectionConfig } from '@/api/client'
import { sessionAppliesToPanel } from '@/lib/mc-connection'
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

/**
 * 连接就绪判定：本面板可用的凭据存在——API Key，或**属于本面板**的登录会话
 * （auth store 读取，单向依赖无环）。会话属于别的面板时不算就绪：
 * 那时请求跑不通，界面该把用户引到登录/配置，而不是发一串注定 401 的查询。
 */
function hasCredentials(config: ConnectionConfig): boolean {
  return Boolean(config.apiKey) || sessionAppliesToPanel(getStoredSession(), config.baseUrl)
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
    status: hasCredentials(initial) ? 'ready' : 'unconfigured',
    setConfig: (config) => {
      set((s) => {
        const next = { baseUrl: config.baseUrl ?? s.baseUrl, apiKey: config.apiKey ?? s.apiKey }
        try {
          localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(next))
        } catch {
          // 忽略持久化失败
        }
        return { ...next, status: hasCredentials(next) ? 'ready' : 'unconfigured' }
      })
    },
    setStatus: (status) => set({ status }),
    refreshStatus: () => {
      const { baseUrl, apiKey } = get()
      set({ status: hasCredentials({ baseUrl, apiKey }) ? 'ready' : 'unconfigured' })
    },
  }
})

/**
 * 本面板可用的凭据是否存在——路由守卫（loader 在 React 周期外）与 status 共用同一口径。
 * 不能只看「有没有会话令牌」：会话属于别的面板时它对本面板无效，
 * 只看令牌会让用户卡在「进得去但所有查询都被禁用」的死角（且 /login 被守卫弹回）。
 */
export function hasUsableCredentials(): boolean {
  const { baseUrl, apiKey } = useConnectionStore.getState()
  return hasCredentials({ baseUrl, apiKey })
}
