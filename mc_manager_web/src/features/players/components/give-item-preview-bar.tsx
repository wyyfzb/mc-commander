/**
 * 预览条 —— CommandPreview（命令预览 + 复制）+ SelectedItemsBar（已选 chips 横滚）+ FooterSummary（汇总 + 给予按钮）
 * 从 give-item-dialog.tsx 提取，预览/汇总独立可测试。
 */
import {
  Check,
  ChevronDown,
  FlaskConical,
  Minus,
  Plus,
  Wand2,
  X,
} from 'lucide-react'
export { CommandPreview } from '@/components/mcs/command-preview'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { getEnchantmentsForItem } from '@/lib/mc-enchantments'
import { itemImageUrl, type MinecraftItem } from '@/lib/mc-items'
import { potionLevelLabel, type PotionEffect } from '@/lib/mc-potions'
import type { SelectedEntry } from './give-item-enchant-editor'

/** 快速数量档 */
const QUICK_COUNTS = [1, 16, 64, 256, 640, 6400]

/** 药水效果色（RGB int → #rrggbb，游戏数据展示色） */
export function effectColorHex(effect: PotionEffect): string {
  return `#${effect.color.toString(16).padStart(6, '0')}`
}



/** 物品贴图 / 药水效果色块（复用于已选 chip 缩略图） */
function ItemThumb({
  item,
  effect,
  size,
}: {
  item: MinecraftItem
  effect?: PotionEffect
  size: number
}) {
  if (effect) {
    return (
      <span
        data-testid={`potion-dot-${item.id}`}
        role="img"
        aria-label={`${effect.name} 效果色`}
        title={effect.name}
        className="flex shrink-0 items-center justify-center rounded-mcs-xs"
        style={{ width: size, height: size, backgroundColor: effectColorHex(effect) }}
      />
    )
  }
  return (
    <img
      src={itemImageUrl(item.id)}
      alt={item.name}
      width={size}
      height={size}
      draggable={false}
      loading="lazy"
      className="shrink-0 select-none"
    />
  )
}

/** 已选物品横向滚动 chips（含数量 +-、附魔/药水入口、快速数量、移除） */
export function SelectedItemsBar({
  entries,
  expandedEnchantId,
  expandedPotionId,
  onSetItemCount,
  onToggleEnchantPanel,
  onTogglePotionPanel,
  onToggleItem,
  onClear,
}: {
  entries: SelectedEntry[]
  expandedEnchantId: string | null
  expandedPotionId: string | null
  onSetItemCount: (id: string, count: number) => void
  onToggleEnchantPanel: (id: string) => void
  onTogglePotionPanel: (id: string) => void
  onToggleItem: (item: MinecraftItem) => void
  onClear: () => void
}) {
  if (entries.length === 0) return null

  return (
    <div className="flex gap-1.5 overflow-x-auto pb-0.5">
      {entries.map((entry) => {
        const effect = entry.potion?.effect
        const isEnchantOpen = expandedEnchantId === entry.item.id
        const isPotionOpen = expandedPotionId === entry.item.id
        const canEnchant = getEnchantmentsForItem(entry.item).length > 0
        const enchCount = Object.keys(entry.enchants).length
        return (
          <div
            key={entry.item.id}
            className="flex w-60 shrink-0 items-center gap-1 rounded-mcs-sm border border-mcs-border-subtle bg-mcs-bg-muted py-1 pl-1 pr-1.5"
            style={
              isPotionOpen && effect
                ? { borderColor: effectColorHex(effect) }
                : isEnchantOpen
                  ? { borderColor: 'var(--mcs-purple-border)' }
                  : undefined
            }
            data-testid={`selected-chip-${entry.item.id}`}
          >
            <ItemThumb item={entry.item} effect={effect} size={22} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-mcs-xs text-mcs-text-default">
                {entry.item.name}
              </div>
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => onSetItemCount(entry.item.id, entry.count - 1)}
                  aria-label={`减少 ${entry.item.name} 数量`}
                  className="rounded-mcs-xs p-0.5 text-mcs-text-muted hover:bg-mcs-state-hover hover:text-mcs-text-default"
                >
                  <Minus className="size-3" aria-hidden />
                </button>
                <span className="w-6 text-center text-mcs-xs font-semibold tabular-nums text-mcs-accent-fg">
                  {entry.count}
                </span>
                <button
                  type="button"
                  onClick={() => onSetItemCount(entry.item.id, entry.count + 1)}
                  aria-label={`增加 ${entry.item.name} 数量`}
                  className="rounded-mcs-xs p-0.5 text-mcs-text-muted hover:bg-mcs-state-hover hover:text-mcs-text-default"
                >
                  <Plus className="size-3" aria-hidden />
                </button>
                {canEnchant ? (
                  <button
                    type="button"
                    onClick={() => onToggleEnchantPanel(entry.item.id)}
                    aria-label={`${entry.item.name} 附魔设置`}
                    className={cn(
                      'ml-0.5 inline-flex items-center gap-0.5 rounded-mcs-xs border px-1 py-px',
                      enchCount > 0
                        ? 'border-mcs-purple-border bg-mcs-purple-bg-subtle text-mcs-purple-fg'
                        : 'border-mcs-border-muted text-mcs-text-muted hover:text-mcs-text-default',
                    )}
                  >
                    <Wand2 className="size-3" aria-hidden />
                    {enchCount > 0 && (
                      <span className="text-mcs-2xs font-semibold">{enchCount}</span>
                    )}
                  </button>
                ) : effect && entry.potion ? (
                  <button
                    type="button"
                    onClick={() => onTogglePotionPanel(entry.item.id)}
                    aria-label={`${entry.item.name} 药水配置`}
                    className="ml-0.5 inline-flex max-w-20 items-center gap-0.5 rounded-mcs-xs border px-1 py-px"
                    style={{
                      color: effectColorHex(effect),
                      borderColor: `color-mix(in srgb, ${effectColorHex(effect)} 45%, transparent)`,
                      backgroundColor: `color-mix(in srgb, ${effectColorHex(effect)} 12%, transparent)`,
                    }}
                  >
                    <FlaskConical className="size-3 shrink-0" aria-hidden />
                    <span className="truncate text-mcs-2xs font-semibold">
                      {potionLevelLabel(entry.potion)}
                    </span>
                  </button>
                ) : null}
              </div>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={`${entry.item.name} 快速数量`}
                  className="shrink-0 rounded-mcs-xs p-0.5 text-mcs-text-muted hover:bg-mcs-state-hover hover:text-mcs-text-default"
                >
                  <ChevronDown className="size-3.5" aria-hidden />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {QUICK_COUNTS.map((n) => (
                  <DropdownMenuItem key={n} onClick={() => onSetItemCount(entry.item.id, n)}>
                    {n}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <button
              type="button"
              onClick={() => onToggleItem(entry.item)}
              aria-label={`移除 ${entry.item.name}`}
              className="shrink-0 rounded-mcs-xs p-0.5 text-mcs-text-muted hover:bg-mcs-state-hover hover:text-mcs-text-default"
            >
              <X className="size-3" aria-hidden />
            </button>
          </div>
        )
      })}
      <Button
        variant="ghost"
        size="xs"
        onClick={onClear}
        aria-label="清空已选物品"
        className="ml-auto shrink-0 text-mcs-text-muted hover:text-mcs-error-fg"
      >
        清空
      </Button>
    </div>
  )
}

/** 页脚汇总 + 给予按钮 */
export function FooterSummary({
  entries,
  running,
  onGive,
}: {
  entries: SelectedEntry[]
  running: boolean
  onGive: () => void
}) {
  const totalCount = entries.reduce((sum, e) => sum + e.count, 0)
  const enchItemCount = entries.filter((e) => Object.keys(e.enchants).length > 0).length

  return (
    <div className="flex items-center justify-between gap-2 border-t border-mcs-border-muted pt-2">
      {entries.length > 0 ? (
        <div className="min-w-0">
          <p className="text-mcs-sm text-mcs-text-default">
            已选 {entries.length} 种物品，共 {totalCount} 个
          </p>
          <p className="text-mcs-xs text-mcs-text-muted">
            {enchItemCount > 0
              ? `将执行 ${entries.length} 条 give 命令（含 ${enchItemCount} 个附魔物品）`
              : `将执行 ${entries.length} 条 give 命令`}
          </p>
        </div>
      ) : (
        <p className="text-mcs-sm text-mcs-text-muted">请点击上方物品添加</p>
      )}
      <Button
        size="sm"
        disabled={entries.length === 0 || running}
        onClick={onGive}
      >
        <Check aria-hidden />
        {running ? '执行中…' : entries.length > 0 ? `给予 (${entries.length})` : '给予'}
      </Button>
    </div>
  )
}