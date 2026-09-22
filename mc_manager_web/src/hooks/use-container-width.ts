import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * useContainerWidth —— 订阅元素的 content-box 宽度（ResizeObserver）
 *
 * 为什么不用 matchMedia：侧栏可折叠（56px ↔ 208px）、md 以下退化成抽屉（不占布局宽）、
 * 主从页还会被右层面板再借走 420px——同一个视口宽下「这一块到底有多宽」能差出六百多 px，
 * 视口断点在这些场景原理上判不准。问容器要宽度才是唯一可靠口径，且侧栏折叠、面板开合
 * 都不必再算进阈值。
 *
 * 宽度为 `null` = 尚未测到（首帧前或无布局引擎的环境，如 jsdom：clientWidth 恒 0）。
 * 调用方按「宽」兜底——降级形态（Sheet 承载 / 裁列 / 转卡片）不该在测量完成前闪出来。
 * ResizeObserver 的投递在 layout 之后、paint 之前，正常浏览器里不会产生可见闪烁。
 */
export function useContainerWidth<T extends HTMLElement>(): [
  ref: (node: T | null) => void,
  width: number | null,
] {
  const [width, setWidth] = useState<number | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)

  const ref = useCallback((node: T | null) => {
    observerRef.current?.disconnect()
    observerRef.current = null
    if (!node || typeof ResizeObserver === 'undefined') return
    // 无布局引擎（jsdom）clientWidth 恒 0：不设初值，保持 null 让调用方按宽兜底
    if (node.clientWidth > 0) setWidth(node.clientWidth)
    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width
      // 0 宽（display:none 的祖先）不当真：元素重新可见时 RO 会再次投递
      if (measured != null && measured > 0) setWidth(measured)
    })
    observer.observe(node)
    observerRef.current = observer
  }, [])

  useEffect(() => () => observerRef.current?.disconnect(), [])

  return [ref, width]
}
