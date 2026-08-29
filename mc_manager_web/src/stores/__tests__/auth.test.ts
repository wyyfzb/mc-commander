import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useAuthStore, getStoredSession, clearSessionAndDispatchExpired, SESSION_EXPIRED_EVENT } from '../auth'

describe('auth store（会话凭据持久化）', () => {
  beforeEach(() => {
    localStorage.clear()
    useAuthStore.getState().clearSession()
  })

  it('初始无会话（localStorage 空）', () => {
    expect(useAuthStore.getState().session).toBeNull()
    expect(getStoredSession()).toBeNull()
  })

  it('setSession 写内存 + 持久化 localStorage', () => {
    const session = { token: 'tok-1', sessionId: 7, expiresAt: new Date(Date.now() + 60_000).toISOString() }
    useAuthStore.getState().setSession(session)
    expect(useAuthStore.getState().session).toEqual(session)
    expect(JSON.parse(localStorage.getItem('mcs-session')!)).toEqual(session)
    expect(getStoredSession()?.token).toBe('tok-1')
  })

  it('从 localStorage 恢复的会话经 getStoredSession 可读（模块级单例共享状态）', () => {
    // 直接写 localStorage 后由 clearSession 验证键名约定（mcs-session）不被误清
    localStorage.setItem('mcs-session', JSON.stringify({ token: 'tok-persist', sessionId: 3, expiresAt: '2026-01-01T00:00:00.000Z' }))
    useAuthStore.getState().clearSession()
    expect(localStorage.getItem('mcs-session')).toBeNull()
  })

  it('clearSession 清内存 + 清 localStorage', () => {
    useAuthStore.getState().setSession({ token: 'tok-2', sessionId: 2, expiresAt: '2026-01-01T00:00:00.000Z' })
    useAuthStore.getState().clearSession()
    expect(useAuthStore.getState().session).toBeNull()
    expect(localStorage.getItem('mcs-session')).toBeNull()
  })

  it('损坏的 localStorage 数据不阻塞 clearSession（防御性）', () => {
    localStorage.setItem('mcs-session', '{not-json')
    useAuthStore.getState().clearSession()
    expect(localStorage.getItem('mcs-session')).toBeNull()
  })

  it('clearSessionAndDispatchExpired：清会话并派发全局事件', () => {
    const listener = vi.fn()
    window.addEventListener(SESSION_EXPIRED_EVENT, listener)
    useAuthStore.getState().setSession({ token: 'tok-3', sessionId: 4, expiresAt: '2026-01-01T00:00:00.000Z' })
    clearSessionAndDispatchExpired()
    expect(useAuthStore.getState().session).toBeNull()
    expect(listener).toHaveBeenCalledTimes(1)
    window.removeEventListener(SESSION_EXPIRED_EVENT, listener)
  })
})
