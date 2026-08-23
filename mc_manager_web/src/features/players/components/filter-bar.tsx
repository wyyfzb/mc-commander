/**
 * FilterBar —— 玩家筛选栏
 * 搜索（名字/UUID）+ 状态/游戏模式/维度下拉 + 重置 + 页头操作区（封禁记录/导出 Excel/添加白名单）
 * 筛选值从 store 反推（store.filter 单一数据源防切页失同步）
 */
import { useState } from 'react'
import { Download, RotateCcw, ScrollText, Search, UserPlus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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

export function FilterBar({ players, totalCount, onOpenBanRecords, onAddWhitelist }: FilterBarProps) {
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
      <div className="relative w-72">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-mcs-text-subtle" aria-hidden />
        <Input
          value={filter.q}
          onChange={(e) => setFilter({ q: e.target.value })}
          placeholder="搜索玩家名或 UUID…"
          className="pl-8 pr-8"
          aria-label="搜索玩家"
        />
        {filter.q.length > 0 && (
          <button
            type="button"
            onClick={() => setFilter({ q: '' })}
            aria-label="清空搜索"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-mcs-xs p-0.5 text-mcs-text-subtle hover:bg-mcs-bg-hover hover:text-mcs-text-default"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        )}
      </div>

      <Select
        value={filter.mode}
        onValueChange={(v) => setFilter({ mode: v as typeof filter.mode })}
      >
        <SelectTrigger className="w-28" aria-label="状态筛选">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {FILTER_MODE_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={gameModeValue} onValueChange={(v) => setFilter({ gameMode: v === '' ? '' : GAME_MODE_VALUE[v] ?? '' })}>
        <SelectTrigger className="w-28" aria-label="游戏模式筛选">
          <SelectValue placeholder="游戏模式" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="全部">全部</SelectItem>
          {GAME_MODE_OPTIONS.map((label) => (
            <SelectItem key={label} value={label}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={filter.dimension} onValueChange={(v) => setFilter({ dimension: v === '全部' ? '' : v })}>
        <SelectTrigger className="w-28" aria-label="维度筛选">
          <SelectValue placeholder="维度" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="全部">全部</SelectItem>
          {DIMENSION_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Button variant="ghost" size="sm" onClick={resetFilter} aria-label="重置筛选">
        <RotateCcw aria-hidden />
        重置
      </Button>

      <div className="ml-auto flex items-center gap-3">
        <span className="text-mcs-xs text-mcs-text-subtle">
          {players.length > 0 && totalCount > 0 && `${players.length} / ${totalCount} 名玩家`}
          {totalCount === 0 && '暂无玩家数据'}
        </span>
        <Button variant="ghost" size="sm" onClick={onOpenBanRecords} aria-label="封禁记录">
          <ScrollText aria-hidden />
          封禁记录
        </Button>
        <Button variant="outline" size="sm" onClick={handleExport} disabled={exporting || players.length === 0}>
          <Download aria-hidden />
          {exporting ? '导出中…' : '导出 Excel'}
        </Button>
        <Button variant="default" size="sm" onClick={onAddWhitelist}>
          <UserPlus aria-hidden />
          添加白名单
        </Button>
      </div>
    </div>
  )
}
