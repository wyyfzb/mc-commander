/**
 * ARIA APG「Radio Group」方向键模型的纯函数部分：把按键映射成组内目标下标。
 * 自定义单选组（role=radiogroup + role=radio）里最容易写错的就是回绕与边界，
 * 抽到一处共用；各组件只负责「选中 + 把焦点移到目标项」。
 *
 * 返回 null 表示该键与单选组无关——调用方必须原样放行，不可 preventDefault，
 * 否则会吞掉 Tab 等默认行为，键盘用户会被困在组里。
 *
 * 约定：`currentIndex` 必须是有效下标。清单未命中（findIndex 返回 -1）时由调用方
 * 先归一到 0 再传入——本函数不做这个兜底，传 -1 会得到「上一个位置」这类无意义落点。
 */

/** 组内方向键 → 目标下标（循环 + Home/End）；与单选组无关的键返回 null */
export function nextRadioIndex(key: string, currentIndex: number, length: number): number | null {
  if (length <= 0) return null
  const step =
    key === 'ArrowRight' || key === 'ArrowDown' ? 1 : key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 0
  if (step !== 0) return (currentIndex + step + length) % length
  if (key === 'Home') return 0
  if (key === 'End') return length - 1
  return null
}
