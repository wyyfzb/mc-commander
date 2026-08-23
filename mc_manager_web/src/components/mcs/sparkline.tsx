import { useEffect, useRef } from 'react'
import * as echarts from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { GridComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { useUiStore } from '@/stores/ui'

echarts.use([LineChart, GridComponent, CanvasRenderer])

/**
 * Sparkline —— ECharts 迷你趋势（设计文档 §3.2：统计卡数字走迷你趋势，P0 洞察铺路）
 * 无轴无标签细线图；颜色走 --mcs-* 语义 token（主题切换自动重渲染）
 */
export interface SparklineProps {
  data: number[]
  /** 线条色（CSS var 引用，默认 success） */
  colorVar?: string
  className?: string
}

export function Sparkline({ data, colorVar = 'var(--mcs-success-fg)', className }: SparklineProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)
  const theme = useUiStore((s) => s.theme)

  useEffect(() => {
    if (!containerRef.current) return
    const chart = echarts.init(containerRef.current, undefined, { renderer: 'canvas' })
    chartRef.current = chart
    const onResize = () => chart.resize()
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      chart.dispose()
      chartRef.current = null
    }
  }, [])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    chart.setOption({
      animation: false, // 轮询更新不闪烁
      grid: { left: 0, right: 0, top: 4, bottom: 0 },
      xAxis: { type: 'category', show: false, data: data.map((_, i) => i) },
      yAxis: { type: 'value', show: false, scale: true },
      series: [
        {
          type: 'line',
          data,
          smooth: false,
          symbol: 'none',
          lineStyle: { width: 1.5, color: colorVar },
          areaStyle: { opacity: 0.08, color: colorVar },
        },
      ],
    })
  }, [data, colorVar, theme])

  return <div ref={containerRef} className={className} aria-hidden />
}
