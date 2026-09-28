/**
 * 平台判定：快捷键提示按平台取词（macOS 的 ⌘ 与其余平台的 Ctrl）
 * - 判定优先级：userAgentData.platform（UA-CH）→ navigator.platform → userAgent
 * - 无 navigator（SSR/测试环境）按非 mac 处理，提示不撒谎
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { isMacPlatform, primaryModifierLabel } from '../platform'

/** 覆盖 navigator 的平台相关字段（jsdom 默认 Linux） */
function stubNavigator(shape: { uaData?: string; platform?: string; userAgent?: string }) {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue(shape.platform ?? '')
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(shape.userAgent ?? '')
  if (shape.uaData !== undefined) {
    Object.defineProperty(navigator, 'userAgentData', {
      value: { platform: shape.uaData },
      configurable: true,
    })
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, 'userAgentData')
})

describe('isMacPlatform / primaryModifierLabel', () => {
  it('UA-CH 报 macOS：判为 mac，提示用 ⌘', () => {
    stubNavigator({ uaData: 'macOS' })
    expect(isMacPlatform()).toBe(true)
    expect(primaryModifierLabel()).toBe('⌘')
  })

  it('无 UA-CH 时退回 navigator.platform（MacIntel）', () => {
    stubNavigator({
      platform: 'MacIntel',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    })
    expect(isMacPlatform()).toBe(true)
  })

  it('UA-CH 与 platform 都缺时退回 userAgent（iPhone）', () => {
    stubNavigator({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' })
    expect(isMacPlatform()).toBe(true)
  })

  it('Windows/Linux：判为非 mac，提示用 Ctrl', () => {
    stubNavigator({ uaData: 'Windows', platform: 'Win32' })
    expect(isMacPlatform()).toBe(false)
    expect(primaryModifierLabel()).toBe('Ctrl')

    vi.restoreAllMocks()
    Reflect.deleteProperty(navigator, 'userAgentData')
    stubNavigator({ platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' })
    expect(isMacPlatform()).toBe(false)
    expect(primaryModifierLabel()).toBe('Ctrl')
  })

  it('UA-CH 明确报非 mac 时不被 platform 的旧值带偏', () => {
    // 少数环境 UA-CH 与 navigator.platform 不一致：以 UA-CH 为准
    stubNavigator({ uaData: 'Windows', platform: 'MacIntel' })
    expect(isMacPlatform()).toBe(false)
  })
})
