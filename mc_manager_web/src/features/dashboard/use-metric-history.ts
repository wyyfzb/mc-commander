import { useRef } from 'react'
import { useServerStore } from '@/stores/server'

/**
 * 指标历史窗口 —— 统计卡 sparkline 数据源
 * 每次 status/systemStats 变化追加采样点，滑动窗口 60 点
 * 用 ref 累积 + 去重，避免 setState-in-effect
 */
export interface MetricHistory {
  cpu: number[]
  mem: number[]
  tps: number[]
}

const WINDOW = 60

interface HistoryRef extends MetricHistory {
  _cpuLast: number | undefined
  _memLast: number | undefined
  _tpsLast: number | undefined
}

export function useMetricHistory(): MetricHistory {
  const status = useServerStore((s) => s.status)
  const systemStats = useServerStore((s) => s.systemStats)

  const ref = useRef<HistoryRef>({ cpu: [], mem: [], tps: [], _cpuLast: undefined, _memLast: undefined, _tpsLast: undefined })
  const h = ref.current

  const cpu = systemStats?.cpuUsage
  const mem = systemStats?.memoryPercent
  const tps = status?.tps ?? undefined

  // 去重累积：store 变化触发渲染时追加（strict mode 二次渲染因 _Last 去重安全）
  if (cpu != null && cpu !== h._cpuLast) {
    const next = [...h.cpu, cpu]
    if (next.length > WINDOW) next.shift()
    h.cpu = next
    h._cpuLast = cpu
  }
  if (mem != null && mem !== h._memLast) {
    const next = [...h.mem, mem]
    if (next.length > WINDOW) next.shift()
    h.mem = next
    h._memLast = mem
  }
  if (tps != null && tps !== h._tpsLast) {
    const next = [...h.tps, tps]
    if (next.length > WINDOW) next.shift()
    h.tps = next
    h._tpsLast = tps
  }

  return h
}
