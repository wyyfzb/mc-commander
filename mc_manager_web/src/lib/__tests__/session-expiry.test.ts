/**
 * 会话过期落点决策（routes.tsx 全局监听用的纯函数）
 * - 本机仍有 API Key（status=ready）→ 不跳登录页（跳了会被 requireUnconfigured 弹回仪表盘）
 * - 已无凭据 → 跳登录页；已在登录页/引导页则不动（避免循环）
 * 以及监听器接线本身（只测纯函数时，把监听器改回「无条件跳登录」测试仍会全绿）
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { toast } from 'sonner'
import { useConnectionStore } from '@/stores/connection'
import { useAuthStore, SESSION_EXPIRED_EVENT } from '@/stores/auth'
import { shouldRedirectToLoginAfterSessionExpiry, installSessionExpiryHandler } from '../session-expiry'

describe('shouldRedirectToLoginAfterSessionExpiry', () => {
  it('本机仍持有 API Key（status=ready）：不跳转——Key 通道顶上继续用', () => {
    expect(shouldRedirectToLoginAfterSessionExpiry('ready', '/dashboard')).toBe(false)
  })

  it('凭据已清空（unconfigured）：跳登录页', () => {
    expect(shouldRedirectToLoginAfterSessionExpiry('unconfigured', '/dashboard')).toBe(true)
  })

  it('正在配置中（configuring）：同样跳登录页', () => {
    expect(shouldRedirectToLoginAfterSessionExpiry('configuring', '/players')).toBe(true)
  })

  it('已在登录页/引导页：不再跳转（避免循环）', () => {
    expect(shouldRedirectToLoginAfterSessionExpiry('unconfigured', '/login')).toBe(false)
    expect(shouldRedirectToLoginAfterSessionExpiry('unconfigured', '/onboarding')).toBe(false)
  })
})

describe('installSessionExpiryHandler 接线', () => {
  const disposers: Array<() => void> = []

  /** 安装监听并返回 navigate 桩（pathname 决定「当前在哪」） */
  function install(pathname: string) {
    const navigate = vi.fn()
    disposers.push(
      installSessionExpiryHandler({ state: { location: { pathname } }, navigate }),
    )
    return navigate
  }

  afterEach(() => {
    while (disposers.length > 0) disposers.pop()!()
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('仍持有 API Key：不跳转，只提示一条（提示带固定 id，并发请求不刷屏）', () => {
    const infoSpy = vi.spyOn(toast, 'info')
    // 初始 status 故意置反：监听器必须自己重算（refreshStatus）后才做决策
    useConnectionStore.setState({ apiKey: 'test-key', status: 'unconfigured' })
    useAuthStore.setState({ session: null })
    const navigate = install('/players')

    window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT))

    expect(useConnectionStore.getState().status).toBe('ready')
    expect(navigate).not.toHaveBeenCalled()
    expect(infoSpy).toHaveBeenCalledWith('登录会话已过期，已转为使用本机保存的 API Key', {
      id: 'session-expired-key-fallback',
    })
  })

  it('凭据已清空：带 returnTo 跳登录页', () => {
    useConnectionStore.setState({ apiKey: '', status: 'ready' })
    useAuthStore.setState({ session: null })
    const navigate = install('/players')

    window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT))

    expect(navigate).toHaveBeenCalledWith('/login?returnTo=%2Fplayers')
  })

  it('已在登录页：不跳转（避免循环）', () => {
    useConnectionStore.setState({ apiKey: '', status: 'unconfigured' })
    useAuthStore.setState({ session: null })
    const navigate = install('/login')

    window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT))

    expect(navigate).not.toHaveBeenCalled()
  })

  it('根路径：不带 returnTo', () => {
    useConnectionStore.setState({ apiKey: '', status: 'unconfigured' })
    useAuthStore.setState({ session: null })
    const navigate = install('/')

    window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT))

    expect(navigate).toHaveBeenCalledWith('/login')
  })

  it('注销后不再响应事件', () => {
    useConnectionStore.setState({ apiKey: '', status: 'unconfigured' })
    useAuthStore.setState({ session: null })
    const navigate = install('/players')
    disposers.pop()!()

    window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT))

    expect(navigate).not.toHaveBeenCalled()
  })
})
