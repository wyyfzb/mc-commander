/**
 * 市场过滤栏（拆分自 market-sheet.tsx，issue 473 治理线延续，纯搬移）
 *
 * 纯受控组件：关键词（防抖由 SearchInput 内部管理）+ 加载器/版本筛选 +
 * 手动刷新 + 结果计数。全部状态由 MarketSheet 持有，本组件只负责展示
 * 与回调透传，保持拆分前后行为等价。
 */
import { RefreshCw } from 'lucide-react'
import { SearchInput } from '@/components/mcs/search-input'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { LOADER_OPTIONS, SEARCH_DEBOUNCE_MS } from './market-config'

interface MarketFilterBarProps {
  query: string
  onQueryChange: (v: string) => void
  onDebouncedChange: (v: string) => void
  loader: string
  onLoaderChange: (v: string) => void
  gameVersion: string
  onGameVersionChange: (v: string) => void
  loading: boolean
  onRefresh: () => void
  totalHits: number
}

export function MarketFilterBar({
  query,
  onQueryChange,
  onDebouncedChange,
  loader,
  onLoaderChange,
  gameVersion,
  onGameVersionChange,
  loading,
  onRefresh,
  totalHits,
}: MarketFilterBarProps) {
  return (
    <div className="space-y-2 border-b border-mcs-border-muted px-5 py-3">
      <SearchInput
        value={query}
        onValueChange={onQueryChange}
        onDebouncedChange={onDebouncedChange}
        debounceMs={SEARCH_DEBOUNCE_MS}
        placeholder="搜索插件（留空浏览热门）…"
        aria-label="搜索插件关键词"
        testId="market-search-input"
      />
      <div className="flex items-center gap-2">
        <Select value={loader} onValueChange={onLoaderChange}>
          <SelectTrigger className="w-32.5" aria-label="按加载器过滤">
            <SelectValue placeholder="全部加载器" />
          </SelectTrigger>
          <SelectContent>
            {LOADER_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          value={gameVersion}
          onChange={(e) => onGameVersionChange(e.target.value.trim())}
          placeholder="MC 版本（如 1.21.4）"
          className="flex-1"
          aria-label="按 MC 版本过滤"
          data-testid="market-game-version"
        />
        <Button
          variant="ghost"
          size="icon"
          onClick={onRefresh}
          disabled={loading}
          aria-label="重新搜索"
          title="重新搜索"
        >
          <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} aria-hidden />
        </Button>
      </div>
      {totalHits > 0 && (
        <p className="text-mcs-xs text-mcs-text-muted" aria-live="polite">
          共 {totalHits.toLocaleString()} 个结果
        </p>
      )}
    </div>
  )
}
