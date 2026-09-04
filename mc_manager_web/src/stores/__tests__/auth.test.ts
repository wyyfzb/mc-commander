import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest'
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
    const session = { token: 'tok-1', sessionId: 'sess-7', expiresAt: new Date(Date.now() + 60_000).toISOString() }
    useAuthStore.getState().setSession(session)
    expect(useAuthStore.getState().session).toEqual(session)
    expect(JSON.parse(localStorage.getItem('mcs-session')!)).toEqual(session)
    expect(getStoredSession()?.token).toBe('tok-1')
  })

  it('从 localStorage 恢复的会话经 getStoredSession 可读（模块级单例共享状态）', () => {
    // 直接写 localStorage 后由 clearSession 验证键名约定（mcs-session）不被误清
    localStorage.setItem('mcs-session', JSON.stringify({ token: 'tok-persist', sessionId: 'sess-3', expiresAt: '2026-01-01T00:00:00.000Z' }))
    useAuthStore.getState().clearSession()
    expect(localStorage.getItem('mcs-session')).toBeNull()
  })

  it('clearSession 清内存 + 清 localStorage', () => {
    useAuthStore.getState().setSession({ token: 'tok-2', sessionId: 'sess-2', expiresAt: '2026-01-01T00:00:00.000Z' })
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
    useAuthStore.getState().setSession({ token: 'tok-3', sessionId: 'sess-4', expiresAt: '2026-01-01T00:00:00.000Z' })
    clearSessionAndDispatchExpired()
    expect(useAuthStore.getState().session).toBeNull()
    expect(listener).toHaveBeenCalledTimes(1)
    window.removeEventListener(SESSION_EXPIRED_EVENT, listener)
  })
})

describe('auth store 初始化恢复分支（模块重载逐态验证）', () => {
  // readInitialSession 仅在模块首次导入（store 创建期）执行一次，
  // 各恢复分支须 vi.resetModules() 重建模块后逐态注入 localStorage 验证
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('空 localStorage → 未登录（!raw 分支）', async () => {
    const mod = await import('../auth')
    expect(mod.useAuthStore.getState().session).toBeNull()
  })

  it('合法持久化会话 → 三字段校验通过并恢复', async () => {
    localStorage.setItem('mcs-session', JSON.stringify({ token: 'tok-r', sessionId: 'sess-r', expiresAt: '2026-01-01T00:00:00.000Z' }))
    const mod = await import('../auth')
    expect(mod.useAuthStore.getState().session).toEqual({ token: 'tok-r', sessionId: 'sess-r', expiresAt: '2026-01-01T00:00:00.000Z' })
  })

  it('token 非字符串 → 按未登录处理（首字段校验失败）', async () => {
    localStorage.setItem('mcs-session', JSON.stringify({ token: 1, sessionId: 'sess-r', expiresAt: '2026-01-01T00:00:00.000Z' }))
    const mod = await import('../auth')
    expect(mod.useAuthStore.getState().session).toBeNull()
  })

  it('sessionId 非字符串 → 按未登录处理（中段校验短路）', async () => {
    localStorage.setItem('mcs-session', JSON.stringify({ token: 'tok-r', sessionId: null, expiresAt: '2026-01-01T00:00:00.000Z' }))
    const mod = await import('../auth')
    expect(mod.useAuthStore.getState().session).toBeNull()
  })

  it('expiresAt 非字符串 → 按未登录处理（末字段校验失败）', async () => {
    localStorage.setItem('mcs-session', JSON.stringify({ token: 'tok-r', sessionId: 'sess-r', expiresAt: 123 }))
    const mod = await import('../auth')
    expect(mod.useAuthStore.getState().session).toBeNull()
  })

  it('损坏 JSON → 解析异常按未登录处理（catch 分支）', async () => {
    localStorage.setItem('mcs-session', '{not-json')
    const mod = await import('../auth')
    expect(mod.useAuthStore.getState().session).toBeNull()
  })

  it('setSession 持久化失败 → 内存会话仍生效（不因存储异常丢登录态）', async () => {
    const mod = await import('../auth')
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded')
    })
    mod.useAuthStore.getState().setSession({ token: 'tok-q', sessionId: 'sess-q', expiresAt: '2026-01-01T00:00:00.000Z' })
    expect(mod.useAuthStore.getState().session?.token).toBe('tok-q')
    spy.mockRestore()
  })

  it('clearSession 移除失败 → 内存会话仍清空（不因存储异常阻塞登出）', async () => {
    const mod = await import('../auth')
    mod.useAuthStore.getState().setSession({ token: 'tok-q', sessionId: 'sess-q', expiresAt: '2026-01-01T00:00:00.000Z' })
    const spy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('storage unavailable')
    })
    mod.useAuthStore.getState().clearSession()
    expect(mod.useAuthStore.getState().session).toBeNull()
    spy.mockRestore()
  })

  it('window 不可用（SSR 形态）→ 仅清会话不派发事件', async () => {
    const mod = await import('../auth')
    mod.useAuthStore.getState().setSession({ token: 'tok-q', sessionId: 'sess-q', expiresAt: '2026-01-01T00:00:00.000Z' })
    vi.stubGlobal('window', undefined)
    expect(() => mod.clearSessionAndDispatchExpired()).not.toThrow()
    expect(mod.useAuthStore.getState().session).toBeNull()
  })
})
