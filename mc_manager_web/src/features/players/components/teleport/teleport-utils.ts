/**
 * 传送 Tab 共享工具：维度展示与坐标格式化。
 *
 * 维度色走 --mcs-dimension-* token（未注册为 Tailwind 色板，行内 var 引用）；
 * 维度未识别回退 muted 文本色；坐标统一四舍五入取整展示。
 */
import type { TeleportPoint } from '@/lib/mc-teleport'

const DIMENSION_LABELS: Record<string, string> = {
  overworld: '主世界',
  nether: '下界',
  end: '末地',
}

const DIMENSION_TOKENS: Record<string, string> = {
  overworld: 'var(--mcs-dimension-overworld)',
  nether: 'var(--mcs-dimension-nether)',
  end: 'var(--mcs-dimension-end)',
}

export function dimensionColor(dimension: string | null | undefined): string {
  return (dimension && DIMENSION_TOKENS[dimension]) || 'var(--mcs-text-muted)'
}

export function dimensionLabel(dimension: string | null | undefined): string {
  return (dimension && DIMENSION_LABELS[dimension]) || '未知维度'
}

export function formatCoords(point: TeleportPoint | null | undefined): string {
  if (!point) return '--'
  return `${Math.round(point.x)}, ${Math.round(point.y)}, ${Math.round(point.z)}`
}
