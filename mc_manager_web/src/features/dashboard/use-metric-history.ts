import { useEffect, useRef, useState } from 'react'
import { useServerStore } from '@/stores/server'

/**
 * 指标历史窗口 —— 统计卡 sparkline 数据源
 * 每次 status/systemStats 变化追加采样点，滑动窗口 60 点
 */
export interface MetricHistory {
  cpu: number[]
  mem: number[]
  tps: number[]
}

const WINDOW = 60

export function useMetricHistory(): MetricHistory {
  const status = useServerStore((s) => s.status)
  const systemStats = useServerStore((s) => s.systemStats)
  const [history, setHistory] = useState<MetricHistory>({ cpu: [], mem: [], tps: [] })
  const historyRef = useRef(history)
  historyRef.current = history

  useEffect(() => {
    setHistory((h) => push(h, systemStats?.cpuUsage, 'cpu'))
  }, [systemStats?.cpuUsage])

  useEffect(() => {
    setHistory((h) => push(h, systemStats?.memoryPercent, 'mem'))
  }, [systemStats?.memoryPercent])

  useEffect(() => {
    setHistory((h) => push(h, status?.tps ?? undefined, 'tps'))
  }, [status?.tps])

  return history
}

function push(h: MetricHistory, value: number | undefined, key: keyof MetricHistory): MetricHistory {
  if (value == null) return h
  const next = [...h[key], value]
  if (next.length > WINDOW) next.shift()
  return { ...h, [key]: next }
}
