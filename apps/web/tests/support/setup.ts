import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup, configure } from '@testing-library/react'

// RTL 自动清理（避免测试间 DOM 泄漏）
afterEach(() => {
  cleanup()
})

/**
 * 异步查询（RTL 的 findBy* / waitFor）默认只等 1000ms：全量并行跑（158 文件）时机器
 * 满载，sonner toast 这类「异步渲染到 portal」的断言会超时抖动（实测该断言单跑 139ms、
 * 满载 452–522ms，旧上限只剩约 2x 余量）——单跑恒绿、满载偶红，是等待上限而非行为差异。
 * 统一放宽到 5s（只在真正失败时才多等，不改变用例语义），per-call timeout 不要再写。
 *
 * 边界：本条只管 RTL 系查询。vitest 自带的 `vi.waitFor` 有独立硬编码的 1s 上限、不读此
 * 配置（等 toast 这类异步续延请显式传 `{ timeout }`）；suite 级单例超时见 vite.config.ts。
 */
configure({ asyncUtilTimeout: 5000 })

// jsdom 缺失的浏览器 API（组件测试依赖）
if (typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

// cmdk 依赖 scrollIntoView（jsdom 未实现）
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => {}
}

// cmdk 依赖 ResizeObserver（jsdom 未实现，标准 mock）
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver
}
