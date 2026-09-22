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
 *
 * ── 两套档位对照（同名不同值，选错前缀就是成倍的误判）────────────────────────
 *   视口档 `md:`（问窗口多宽）        容器档 `@md:`（问这一块多宽）
 *   xs  30rem  480px（本仓追加）      @xs  20rem  320px
 *   sm  40rem  640px                 @sm  24rem  384px
 *   md  48rem  768px ← 侧栏/抽屉分界   @md  28rem  448px
 *   lg  64rem 1024px                 @lg  32rem  512px
 *   xl  80rem 1280px                 @xl  36rem  576px
 *   2xl 96rem 1536px                 @2xl 42rem  672px
 *                                    @3xl 48rem  768px（与视口 md 同值，巧合）
 *                                    @4xl 56rem  896px
 *                                    @5xl 64rem 1024px（与视口 lg 同值，巧合）
 * 容器档取 Tailwind v4 默认值（本仓未覆盖）；视口档仅追加了 xs。
 * 选档规则：先问「这一块有多宽」能不能解决——能就走容器档（纯 CSS，不过 JS、不重渲染）；
 * 只有必须换组件行为（内联↔Sheet / 全列↔裁列 / 双栏↔全屏）才用本 hook。
 * 阈值是实测最小宽（不是档位凑整），改任一侧都要连同理由一起改，并由 e2e 在对应
 * 视口宽上锁住——jsdom 不评估容器查询，量不到真实几何。
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
