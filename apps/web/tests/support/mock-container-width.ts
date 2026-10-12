/**
 * useContainerWidth 的测试替身
 *
 * jsdom 无布局引擎（clientWidth 恒 0），setup.ts 里的 ResizeObserver 又是空实现，
 * 因此按宽度切档的组件在单测里既测不到宽也测不到窄。这里提供「observe 即按给定宽度
 * 投递」的可控 mock：宽度在 observe 时确定，微任务投递（与真实 RO 的时序一致，
 * 也避免在 ref 回调里同步 setState）。
 *
 * 用法：
 *   const restore = mockContainerWidth(784)
 *   render(...)
 *   await screen.findBy...(...)   // 微任务已跑完，宽度已生效
 *   restore()                     // 或在 afterEach 里统一恢复
 */
/** 让后续挂载的 useContainerWidth 都测到 `px` 宽；返回恢复函数 */
export function mockContainerWidth(px: number): () => void {
  const original = globalThis.ResizeObserver
  globalThis.ResizeObserver = class WidthObserver {
    private readonly callback: ResizeObserverCallback
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback
    }
    observe(target: Element) {
      queueMicrotask(() =>
        this.callback(
          [{ target, contentRect: { width: px } as DOMRectReadOnly } as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        ),
      )
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  return () => {
    globalThis.ResizeObserver = original
  }
}
