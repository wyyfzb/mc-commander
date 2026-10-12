/**
 * OverviewTab 概览格式化工具与标签常量
 * 自 detail-overview-tab.tsx 纯搬移（issue 489 治理线延续）：常量表与纯函数单一职责收口
 */

export const GAME_MODE_LABELS: Record<string, string> = {
  survival: '生存',
  creative: '创造',
  adventure: '冒险',
  spectator: '旁观',
}

export const DIMENSION_LABELS: Record<string, string> = {
  overworld: '主世界',
  nether: '下界',
  end: '末地',
}

/** 等级罗马数字（II/III…） */
export function toRomanLabel(level: number): string {
  const romans = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X']
  return romans[level - 1] ?? String(level)
}

/** 药水剩余时长（秒 → m:ss 或 无限） */
export function formatEffectDuration(seconds: number): string {
  if (seconds < 0) return '∞'
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/** 时长格式（X天X小时/X小时X分/X分） */
export function formatPlayTime(seconds: number): string {
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}天${hours}小时`
  if (hours > 0) return `${hours}小时${minutes}分`
  return `${minutes}分`
}
