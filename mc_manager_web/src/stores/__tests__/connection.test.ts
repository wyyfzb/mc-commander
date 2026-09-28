/**
 * connection store：凭据就绪口径（安全主线）
 * 就绪 = 本面板可用的凭据存在——API Key，或**属于本面板**的登录会话。
 * 会话属于别的面板时不算就绪，否则会出现「进得去面板、所有查询都被禁用」的死角。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { useAuthStore } from '../auth'
import { hasUsableCredentials, useConnectionStore } from '../connection'

const PANEL_A = 'https://panel-a.example.com'
const PANEL_B = 'https://panel-b.example.com'
const future = () => new Date(Date.now() + 60_000).toISOString()
const bindSession = (issuedFor?: string) =>
  useAuthStore
    .getState()
    .setSession({ token: 'tok-1', sessionId: 'sess-1', expiresAt: future(), issuedFor })

describe('连接就绪判定（凭据 × 面板）', () => {
  beforeEach(() => {
    localStorage.clear()
    useAuthStore.getState().clearSession()
    useConnectionStore.setState({ baseUrl: '', apiKey: '', status: 'unconfigured' })
  })

  it('只有 API Key → 就绪（自动化通道）', () => {
    useConnectionStore.setState({ apiKey: 'key-1' })
    useConnectionStore.getState().refreshStatus()
    expect(useConnectionStore.getState().status).toBe('ready')
  })

  it('只有属于本面板的会话 → 就绪', () => {
    useConnectionStore.setState({ baseUrl: PANEL_B })
    bindSession(PANEL_B)
    useConnectionStore.getState().refreshStatus()
    expect(useConnectionStore.getState().status).toBe('ready')
  })

  it('会话属于别的面板且无 Key → 不就绪（不留「查询全被禁用」的死角）', () => {
    useConnectionStore.setState({ baseUrl: PANEL_B })
    bindSession(PANEL_A)
    useConnectionStore.getState().refreshStatus()
    expect(useConnectionStore.getState().status).toBe('unconfigured')
    expect(hasUsableCredentials()).toBe(false)
  })

  it('setConfig 换地址即时重算：换到会话所属面板即就绪', () => {
    bindSession(PANEL_A)
    useConnectionStore.getState().setConfig({ baseUrl: PANEL_B })
    expect(useConnectionStore.getState().status).toBe('unconfigured')
    useConnectionStore.getState().setConfig({ baseUrl: PANEL_A })
    expect(useConnectionStore.getState().status).toBe('ready')
  })

  it('旧会话（无签发面板信息）→ 按适用处理，保持既有行为', () => {
    useConnectionStore.setState({ baseUrl: PANEL_B })
    bindSession()
    useConnectionStore.getState().refreshStatus()
    expect(useConnectionStore.getState().status).toBe('ready')
  })

  it('异面板会话 + 该面板的 Key → 就绪（Key 通道可用）', () => {
    useConnectionStore.setState({ baseUrl: PANEL_B, apiKey: 'key-b' })
    bindSession(PANEL_A)
    useConnectionStore.getState().refreshStatus()
    expect(useConnectionStore.getState().status).toBe('ready')
    expect(hasUsableCredentials()).toBe(true)
  })
})
