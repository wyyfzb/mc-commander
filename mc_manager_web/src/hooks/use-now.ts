import { useEffect, useState } from 'react'

/**
 * 周期刷新的当前时间戳（倒计时等分钟级时效展示用）
 * 默认每分钟更新一次；组件卸载自动清理定时器
 */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(timer)
  }, [intervalMs])

  return now
}
