/**
 * 玩家页 UI 态（zustand，设计文档 §5.2）
 * - 选中集按 uuid；切换实例清空
 * - 筛选/排序规则为纯函数（matchesSearch/matchesModeFilter/sortPlayers，applyPlayersFilter 供表格数据源）
 * - 详情面板状态（单个玩家 / 批量模式）
 * 列表数据本体走 TanStack Query（usePlayers），本 store 不存数据。
 */
import { create } from 'zustand'
import type { Player } from '@/api/types'

export type PlayersFilterMode = 'all' | 'online' | 'offline' | 'op' | 'whitelist' | 'banned'

export interface PlayersFilter {
  /** 搜索词（匹配名字或 UUID 小写包含） */
  q: string
  /** 状态筛选 */
  mode: PlayersFilterMode
  /** 游戏模式筛选（'' = 全部） */
  gameMode: string
  /** 维度筛选（'' = 全部） */
  dimension: string
}

export const DEFAULT_PLAYERS_FILTER: PlayersFilter = {
  q: '',
  mode: 'all',
  gameMode: '',
  dimension: '',
}

/** 筛选状态标签（FilterBar 选项） */
export const FILTER_MODE_OPTIONS: Array<{ value: PlayersFilterMode; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'online', label: '在线' },
  { value: 'offline', label: '离线' },
  { value: 'op', label: 'OP' },
  { value: 'whitelist', label: '白名单' },
  { value: 'banned', label: '封禁' },
]

export const GAME_MODE_OPTIONS = ['生存', '创造', '冒险', '旁观'] as const
export const DIMENSION_OPTIONS = [
  { value: 'overworld', label: '主世界' },
  { value: 'nether', label: '下界' },
  { value: 'end', label: '末地' },
] as const

/**
 * 应用状态筛选
 */
export function matchesModeFilter(player: Player, mode: PlayersFilterMode): boolean {
  switch (mode) {
    case 'online':
      return player.isOnline
    case 'offline':
      return !player.isOnline
    case 'op':
      return player.isOp
    case 'whitelist':
      return player.isWhitelisted
    case 'banned':
      return player.isBanned || player.isIpBanned
    case 'all':
      return true
  }
}

/** 搜索匹配（名字或 UUID 小写包含） */
export function matchesSearch(player: Player, q: string): boolean {
  const query = q.trim().toLowerCase()
  if (query.length === 0) return true
  return player.name.toLowerCase().includes(query) || player.uuid.toLowerCase().includes(query)
}

/**
 * 排序规则（收敛排序，UI 不重复排序防行抖动）：
 * 1. 在线 > 离线
 * 2. OP > 非 OP
 * 3. lastSeen 升序（先下线者在前；null 视为最远 → 排最后）
 * 4. totalPlayTime 多者优先
 */
export function sortPlayers(a: Player, b: Player): number {
  if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1
  if (a.isOp !== b.isOp) return a.isOp ? -1 : 1
  // lastSeen 可为 null（服务端详情/离线项），null 视为从未 → 排最后
  const seenOrMax = (s: string | null) => {
    if (s == null) return Number.MAX_SAFE_INTEGER
    const t = new Date(s).getTime()
    return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t
  }
  const aSeen = seenOrMax(a.lastSeen)
  const bSeen = seenOrMax(b.lastSeen)
  if (aSeen !== bSeen) return aSeen - bSeen
  return b.totalPlayTime - a.totalPlayTime
}

/** 完整过滤 + 排序流水线（供表格数据源使用） */
export function applyPlayersFilter(players: Player[], filter: PlayersFilter): Player[] {
  return players
    .filter(
      (p) =>
        matchesSearch(p, filter.q) &&
        matchesModeFilter(p, filter.mode) &&
        (filter.gameMode === '' || p.gameMode === filter.gameMode) &&
        (filter.dimension === '' || p.dimension === filter.dimension),
    )
    .sort(sortPlayers)
}

export type PlayerDetailTab = 'overview' | 'inventory' | 'teleport' | 'give' | 'log'

export const DETAIL_TAB_LABELS: Array<{ value: PlayerDetailTab; label: string }> = [
  { value: 'overview', label: '概览' },
  { value: 'inventory', label: '物品栏' },
  { value: 'teleport', label: '传送' },
  { value: 'give', label: '给予物品' },
  { value: 'log', label: '日志' },
]

export interface PlayersDetailState {
  /** 单个玩家模式：玩家名；批量模式：null（目标取 selectedUuids） */
  playerName: string | null
  tab: PlayerDetailTab
  batchMode: boolean
}

interface PlayersUiState {
  /** 选中玩家 uuid 集合（有序数组保证批量目标顺序稳定） */
  selectedUuids: string[]
  filter: PlayersFilter
  detail: PlayersDetailState | null
  toggleSelect: (uuid: string) => void
  /** 表头 tristate：全部选中则取消全选，否则全选当前页 */
  toggleSelectPage: (pageUuids: string[]) => void
  clearSelection: () => void
  setFilter: (partial: Partial<PlayersFilter>) => void
  resetFilter: () => void
  openPlayerDetail: (playerName: string, tab?: PlayerDetailTab) => void
  /** 批量模式打开详情面板（传送/给予物品复用） */
  openBatchDetail: (tab: PlayerDetailTab) => void
  setDetailTab: (tab: PlayerDetailTab) => void
  closeDetail: () => void
  /** 实例切换时重置（清空选中+重置筛选） */
  resetForInstance: () => void
}

export const usePlayersUiStore = create<PlayersUiState>((set) => ({
  selectedUuids: [],
  filter: { ...DEFAULT_PLAYERS_FILTER },
  detail: null,

  toggleSelect: (uuid) =>
    set((s) => ({
      selectedUuids: s.selectedUuids.includes(uuid)
        ? s.selectedUuids.filter((u) => u !== uuid)
        : [...s.selectedUuids, uuid],
    })),

  toggleSelectPage: (pageUuids) =>
    set((s) => {
      const allSelected = pageUuids.every((u) => s.selectedUuids.includes(u))
      if (allSelected) {
        // 全部选中 → 取消本页选中
        const pageSet = new Set(pageUuids)
        return { selectedUuids: s.selectedUuids.filter((u) => !pageSet.has(u)) }
      }
      // 部分/未选中 → 全选本页（并集去重）
      const merged = new Set([...s.selectedUuids, ...pageUuids])
      return { selectedUuids: [...merged] }
    }),

  clearSelection: () => set({ selectedUuids: [] }),

  setFilter: (partial) => set((s) => ({ filter: { ...s.filter, ...partial } })),

  resetFilter: () => set({ filter: { ...DEFAULT_PLAYERS_FILTER } }),

  openPlayerDetail: (playerName, tab = 'overview') =>
    set({ detail: { playerName, tab, batchMode: false } }),

  openBatchDetail: (tab) => set({ detail: { playerName: null, tab, batchMode: true } }),

  setDetailTab: (tab) => set((s) => (s.detail ? { detail: { ...s.detail, tab } } : s)),

  closeDetail: () => set({ detail: null }),

  resetForInstance: () =>
    set({ selectedUuids: [], filter: { ...DEFAULT_PLAYERS_FILTER }, detail: null }),
}))
