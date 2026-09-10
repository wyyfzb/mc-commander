/**
 * 会话过期落点决策（routes.tsx 全局监听用的纯函数）
 * - 本机仍有 API Key（status=ready）→ 不跳登录页（跳了会被 requireUnconfigured 弹回仪表盘）
 * - 已无凭据 → 跳登录页；已在登录页/引导页则不动（避免循环）
 */
import { describe, it, expect } from 'vitest'
import { shouldRedirectToLoginAfterSessionExpiry } from '../session-expiry'

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
