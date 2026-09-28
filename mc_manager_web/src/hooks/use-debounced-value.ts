/**
 * 值防抖 hook（编辑落定语义）
 *
 * 与 `components/mcs/search-input` 内联计时器同款取舍：调用方拿到的是**稳定后**的值，
 * 用于驱动「每次取值都是一个新请求」的场景（逐击键取值等于逐击键发请求）。
 * 首帧同步返回初值，不产生额外一次渲染。
 */
import { useEffect, useState } from 'react'

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])

  return debounced
}
