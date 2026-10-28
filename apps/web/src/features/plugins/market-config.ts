/**
 * MarketSheet 共享常量与纯工具（延伸：Modrinth 一键安装）
 *
 * 常量与格式化工具独立成模块，
 * 供主组件（搜索参数/预填校验/防抖步长）、过滤栏（加载器选项）与结果卡片
 * （下载量 chip/加载器高亮/版本截断）共同引用。
 */
import { MARKET_LOADERS } from '@mc-commander/schemas'
import type { MarketKind } from '@/api/types'

export const PAGE_SIZE = 20
export const SEARCH_DEBOUNCE_MS = 400
export const MAX_VISIBLE_VERSIONS = 5

/** Bukkit 系加载器（版本行 loader chip 的高亮集合；其余显示为 muted） */
export const BUKKIT_LOADERS = new Set<string>(MARKET_LOADERS.plugin)

export const LOADER_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '全部加载器' },
  ...MARKET_LOADERS.plugin.map((value) => ({
    value,
    label: value.charAt(0).toUpperCase() + value.slice(1),
  })),
]

/**
 * 两种装载目标的界面措辞：单一来源，页面 / 市场面板 / 上传提示都从这里取。
 * `dir` 是落盘目录名，与 API 端点前缀同名，展示给用户时带斜杠。
 */
export const TARGET_TEXT = {
  plugin: {
    noun: '插件',
    pageTitle: '插件管理',
    effectHint: '管理 Bukkit 系插件（Paper/Spigot）：启停与增删在重启实例后生效',
    emptyDir: 'plugins',
    marketHint: '从 Modrinth 社区搜索并一键安装 Bukkit 系插件；安装后需重启实例生效',
  },
  mod: {
    noun: '模组',
    pageTitle: '模组管理',
    effectHint: '管理 Fabric/Forge 模组（mods/）：增删在重启实例后生效，不支持按文件启停',
    emptyDir: 'mods',
    marketHint:
      '从 Modrinth 搜索并一键安装服务端可用模组（已滤除纯客户端模组）；安装后需重启实例生效',
  },
} as const satisfies Record<MarketKind, Record<string, string>>

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
