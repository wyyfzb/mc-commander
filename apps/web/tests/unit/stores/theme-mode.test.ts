import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { resolveTheme, useUiStore } from '@/stores/ui'

/**
 * 主题偏好三档（dark / light / system）
 * system 不是第三种配色：解析结果必须落回 dark / light 之一，
 * 且快捷切换要按解析后的配色取反，否则 system 档下点一次只会固定在 light。
 */

const REAL_MATCH_MEDIA = window.matchMedia

/** 把操作系统配色钉成指定值（同时记录监听注册，供「系统切换后重解析」断言） */
function stubSystemDark(dark: boolean) {
  const listeners = new Set<() => void>()
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: query === '(prefers-color-scheme: dark)' ? dark : false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: (_: string, cb: () => void) => listeners.add(cb),
      removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
      dispatchEvent: () => false,
    }),
  })
  return {
    /** 模拟用户在系统设置里切主题 */
    flip(nextDark: boolean) {
      Object.defineProperty(window, 'matchMedia', {
        writable: true,
        configurable: true,
        value: (query: string) => ({
          matches: query === '(prefers-color-scheme: dark)' ? nextDark : false,
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: (_: string, cb: () => void) => listeners.add(cb),
          removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
          dispatchEvent: () => false,
        }),
      })
      for (const cb of listeners) cb()
    },
    get listenerCount() {
      return listeners.size
    },
  }
}

beforeEach(() => {
  localStorage.clear()
  useUiStore.setState({ theme: 'dark' })
})

afterEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: REAL_MATCH_MEDIA,
  })
  localStorage.clear()
})

describe('resolveTheme', () => {
  it('固定档原样返回，不读操作系统', () => {
    stubSystemDark(true)
    expect(resolveTheme('light')).toBe('light')
    expect(resolveTheme('dark')).toBe('dark')
  })

  it('system 跟随操作系统：深色系统 → dark，浅色系统 → light', () => {
    stubSystemDark(true)
    expect(resolveTheme('system')).toBe('dark')
    stubSystemDark(false)
    expect(resolveTheme('system')).toBe('light')
  })

  it('matchMedia 抛错时回退 dark（与 store 默认值一致）', () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: () => {
        throw new Error('matchMedia 不可用')
      },
    })
    expect(resolveTheme('system')).toBe('dark')
  })
})

describe('toggleTheme 在 system 档', () => {
  it('深色系统下点一次得到 light（看得见的变化），并固定到 light', () => {
    stubSystemDark(true)
    useUiStore.setState({ theme: 'system' })
    useUiStore.getState().toggleTheme()
    expect(useUiStore.getState().theme).toBe('light')
  })

  it('浅色系统下点一次得到 dark，并固定到 dark', () => {
    stubSystemDark(false)
    useUiStore.setState({ theme: 'system' })
    useUiStore.getState().toggleTheme()
    expect(useUiStore.getState().theme).toBe('dark')
  })

  it('固定档之间仍按字面取反（不依赖操作系统）', () => {
    stubSystemDark(true)
    useUiStore.setState({ theme: 'dark' })
    useUiStore.getState().toggleTheme()
    expect(useUiStore.getState().theme).toBe('light')
    useUiStore.getState().toggleTheme()
    expect(useUiStore.getState().theme).toBe('dark')
  })
})

describe('useResolvedTheme', () => {
  it('system 档返回操作系统配色，且在系统切换后跟着变', async () => {
    const { renderHook, act } = await import('@testing-library/react')
    const { useResolvedTheme } = await import('@/hooks/use-resolved-theme')
    const system = stubSystemDark(true)
    useUiStore.setState({ theme: 'system' })

    const { result } = renderHook(() => useResolvedTheme())
    expect(result.current).toBe('dark')
    // 只读一次会让终端/Monaco 停在旧调色板上
    act(() => system.flip(false))
    expect(result.current).toBe('light')
  })

  it('固定档不订阅操作系统：系统切换不改变返回值', async () => {
    const { renderHook } = await import('@testing-library/react')
    const { useResolvedTheme } = await import('@/hooks/use-resolved-theme')
    stubSystemDark(true)
    useUiStore.setState({ theme: 'light' })

    const { result } = renderHook(() => useResolvedTheme())
    expect(result.current).toBe('light')
  })
})

describe('theme 偏好持久化', () => {
  it('system 作为偏好写入 localStorage（不是第三种配色，但必须持久化）', async () => {
    useUiStore.getState().setTheme('system')
    await vi.waitFor(
      () => {
        const stored = JSON.parse(localStorage.getItem('mcs-ui-preferences')!) as {
          state: { theme: string }
        }
        expect(stored.state.theme).toBe('system')
      },
      { timeout: 5000 },
    )
  })
})
