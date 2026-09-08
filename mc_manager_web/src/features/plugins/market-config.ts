/**
 * MarketSheet 共享常量与纯工具（feat-8 延伸：Modrinth 一键安装）
 *
 * 拆分自 market-sheet.tsx（issue 473 治理线延续，纯搬移）：常量与格式化工具独立成模块，
 * 供主组件（搜索参数/预填校验/防抖步长）、过滤栏（加载器选项）与结果卡片
 * （下载量 chip/加载器高亮/版本截断）共同引用。
 */

export const PAGE_SIZE = 20
export const SEARCH_DEBOUNCE_MS = 400
export const MAX_VISIBLE_VERSIONS = 5

/** Bukkit 系加载器（版本行 loader chip 的高亮集合；其余显示为 muted） */
export const BUKKIT_LOADERS = new Set(['paper', 'spigot', 'bukkit', 'purpur', 'folia'])

export const LOADER_OPTIONS = [
  { value: '', label: '全部加载器' },
  { value: 'paper', label: 'Paper' },
  { value: 'spigot', label: 'Spigot' },
  { value: 'bukkit', label: 'Bukkit' },
  { value: 'purpur', label: 'Purpur' },
  { value: 'folia', label: 'Folia' },
] as const

/** MC 版本格式（与服务端 GAME_VERSION_REGEX 一致；空值/'unknown' 不预填） */
export const GAME_VERSION_RE = /^\d{1,3}(\.\d{1,3}){0,2}(-pre\d*)?$/

/** 下载量紧凑格式：1.2k / 3.4M / 1.1B */
export function formatCompact(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  return `${(n / 1_000_000_000).toFixed(1)}B`
}
