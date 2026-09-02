/**
 * FilterBar —— 玩家筛选栏
 * 搜索（名字/UUID）+ 状态/游戏模式/维度下拉 + 重置 + 页头操作区（封禁记录/导出 Excel/添加白名单）
 * 筛选值从 store 反推（store.filter 单一数据源防切页失同步）
 */
import { useState } from 'react'
import { Download, RotateCcw, ScrollText, UserPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { SearchInput } from '@/components/mcs/search-input'
import { FilterSelect } from './filter-select'
import {
  DIMENSION_OPTIONS,
  FILTER_MODE_OPTIONS,
  GAME_MODE_OPTIONS,
  usePlayersUiStore,
} from '../store'
import { exportPlayersToExcel } from '../player-export'
import type { Player } from '@/api/types'

interface FilterBarProps {
  players: Player[]
  /** 总玩家数（未筛选，用于空态区分） */
  totalCount: number
  /** RCON 连接状态：封禁/白名单等写操作依赖 RCON 通道执行 */
  isRconConnected: boolean
  /** 打开页面级封禁记录弹窗 */
  onOpenBanRecords: () => void
  /** 打开添加白名单弹窗（页头主按钮；离线玩家同样生效） */
  onAddWhitelist: () => void
}

const GAME_MODE_VALUE: Record<string, string> = {
  生存: 'survival',
  创造: 'creative',
  冒险: 'adventure',
  旁观: 'spectator',
}

export function FilterBar({
  players,
  totalCount,
  isRconConnected,
  onOpenBanRecords,
  onAddWhitelist,
}: FilterBarProps) {
  const filter = usePlayersUiStore((s) => s.filter)
  const setFilter = usePlayersUiStore((s) => s.setFilter)
  const resetFilter = usePlayersUiStore((s) => s.resetFilter)
  const [exporting, setExporting] = useState(false)

  const gameModeValue = filter.gameMode
    ? GAME_MODE_OPTIONS.find((label) => GAME_MODE_VALUE[label] === filter.gameMode) ?? ''
    : ''

  const handleExport = async () => {
    setExporting(true)
    try {
      await exportPlayersToExcel(players)
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-mcs-border-muted px-4 py-2.5">
      <SearchInput
        value={filter.q}
        onValueChange={(v) => setFilter({ q: v })}
        placeholder="搜索玩家名或 UUID…"
        aria-label="搜索玩家"
        className="w-72"
      />

      <FilterSelect
        label="状态筛选"
        placeholder="玩家状态"
        value={filter.mode}
        allValue="all"
        options={FILTER_MODE_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
        onChange={(v) => setFilter({ mode: v as typeof filter.mode })}
      />

      <FilterSelect
        label="游戏模式筛选"
        placeholder="游戏模式"
        value={gameModeValue}
        options={GAME_MODE_OPTIONS.map((label) => ({ value: label, label }))}
        onChange={(v) => setFilter({ gameMode: v === '' ? '' : GAME_MODE_VALUE[v] ?? '' })}
      />

      <FilterSelect
        label="维度筛选"
        placeholder="维度"
        value={filter.dimension}
        options={DIMENSION_OPTIONS.map((option) => ({ ...option }))}
        onChange={(v) => setFilter({ dimension: v })}
      />

      <Button variant="ghost" size="sm" onClick={resetFilter} aria-label="重置筛选">
        <RotateCcw aria-hidden />
        重置
      </Button>

      <div className="ml-auto flex items-center gap-3">
        <span className="text-mcs-xs text-mcs-text-subtle">
          {players.length > 0 && totalCount > 0 && `${players.length} / ${totalCount} 名玩家`}
          {totalCount === 0 && '暂无玩家数据'}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Button
                variant="ghost"
                size="sm"
                onClick={onOpenBanRecords}
                disabled={!isRconConnected}
                aria-label="封禁记录"
              >
                <ScrollText aria-hidden />
                封禁记录
              </Button>
            </span>
          </TooltipTrigger>
          {!isRconConnected && <TooltipContent>需要 RCON 连接</TooltipContent>}
        </Tooltip>
        <Button variant="outline" size="sm" onClick={handleExport} disabled={exporting || players.length === 0}>
          <Download aria-hidden />
          {exporting ? '导出中…' : '导出 Excel'}
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Button variant="default" size="sm" onClick={onAddWhitelist} disabled={!isRconConnected}>
                <UserPlus aria-hidden />
                添加白名单
              </Button>
            </span>
          </TooltipTrigger>
          {!isRconConnected && <TooltipContent>需要 RCON 连接</TooltipContent>}
        </Tooltip>
      </div>
    </div>
  )
}
