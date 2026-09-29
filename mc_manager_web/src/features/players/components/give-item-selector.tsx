/**
 * 物品选择器 —— 搜索 + 分类 chips + ItemCell 网格
 * 从 give-item-dialog.tsx 提取，物品选择/展示独立可测试。
 */
import { memo, useMemo } from 'react'
import { Check, Terminal } from 'lucide-react'
import { SearchInput } from '@/components/mcs/search-input'
import { cn } from '@/lib/utils'
import {
  ITEM_CATEGORIES,
  MINECRAFT_ITEMS,
  fullItemId,
  itemImageUrl,
  type MinecraftItem,
} from '@/lib/mc-items'
import { MINECRAFT_POTIONS, type PotionEffect } from '@/lib/mc-potions'
import { isItemAvailableIn, requiredVersionFor } from '@/lib/mc-item-versions'
import { effectColorHex } from './give-item-preview-bar'
import type { SelectedEntry } from './give-item-enchant-editor'
import {
  TONE_SELECTED_CLASSES,
  TONE_SELECTED_SURFACE_CLASSES,
  toneClasses,
} from '@/components/mcs/tone'

/** 药水效果虚拟物品（id 用效果 id，category 固定「药水」，UI 展示用） */
export const POTION_VIRTUAL_ITEMS: MinecraftItem[] = MINECRAFT_POTIONS.map((e) => ({
  id: e.effectId,
  name: e.name,
  category: '药水',
  stackSize: 1,
}))

/** 药水效果查找（id 在效果目录中即为效果药水虚拟物品） */
export function potionEffectFor(itemId: string): PotionEffect | undefined {
  return MINECRAFT_POTIONS.find((e) => e.effectId === itemId)
}

/** 物品网格单元格（memo：211 项大列表，仅选中/数量/附魔变化时重渲染；onToggle 由 useCallback 稳定） */
const ItemCell = memo(function ItemCell({
  item,
  entry,
  effect,
  isSelected,
  onToggle,
  mcVersion,
}: {
  item: MinecraftItem
  entry: SelectedEntry | undefined
  effect?: PotionEffect
  isSelected: boolean
  onToggle: (item: MinecraftItem) => void
  mcVersion?: string
}) {
  // 目标版本装不下这个物品时打警示角标（而不是隐藏它）：用户可能正想确认
  // 「这东西哪版才有」，藏起来反而答不了。拼装层还会再拦一次（双保险）。
  // 先把 mcVersion 收窄成 string：`mcVersion` 是可选的，直接传会让 TS 报
  // 「string | undefined 不可赋给 string」，也避免空串被当成真实版本去比较。
  const target = mcVersion ?? ''
  const needs = target ? requiredVersionFor(item.id) : null
  const unavailable = needs !== null && target !== '' && !isItemAvailableIn(item.id, target)
  return (
    <button
      type="button"
      onClick={() => onToggle(item)}
      aria-pressed={isSelected}
      data-testid={`item-cell-${item.id}`}
      className={cn(
        'relative flex flex-col items-center gap-0.5 rounded-mcs-sm border px-1 pb-1 pt-1 transition-colors',
        isSelected
          ? TONE_SELECTED_SURFACE_CLASSES
          : 'border-mcs-border-subtle bg-mcs-bg-muted hover:border-mcs-border-default',
      )}
    >
      <span className="relative">
        <ItemThumb item={item} effect={effect} size={36} />
        {isSelected && (
          <span
            className="absolute right-0 top-0 flex size-3.5 -translate-y-1/3 translate-x-1/3 items-center justify-center rounded-full bg-mcs-accent text-mcs-on-accent"
            aria-label="已选中"
          >
            <Check className="size-2.5" aria-hidden />
          </span>
        )}
        {/* 版本角标：仅对「已知晚于目标版本」的物品显示，未标注的不显示任何角标
            （注册表只覆盖正式版，「未标注」= 无版本要求，不是「不适用」） */}
        {needs !== null && unavailable && (
          <span
            className={`absolute left-0 top-0 rounded-mcs-xs border px-1 text-mcs-2xs font-semibold leading-tight ${toneClasses('warning')}`}
            title={`需要 MC ${needs}+，当前实例为 ${mcVersion}`}
          >
            {needs}+
          </span>
        )}
        {isSelected && entry !== undefined && entry.count > 1 && (
          <span className="absolute bottom-0 right-0 rounded-mcs-xs bg-mcs-accent px-1 text-mcs-2xs font-semibold leading-tight text-mcs-on-accent tabular-nums">
            {entry.count}
          </span>
        )}
        {isSelected && entry !== undefined && Object.keys(entry.enchants).length > 0 && (
          <span
            className={`absolute left-0 top-0 rounded-mcs-xs border px-1 text-mcs-2xs font-semibold leading-tight ${toneClasses('purple')}`}
          >
            附{Object.keys(entry.enchants).length}
          </span>
        )}
      </span>
      <span
        className="w-full truncate text-center text-mcs-xs text-mcs-text-default"
        title={item.name}
      >
        {item.name}
      </span>
      <span
        className="w-full truncate text-center font-mono text-mcs-2xs text-mcs-text-muted"
        title={fullItemId(item.id)}
      >
        {item.id}
      </span>
    </button>
  )
})

/** 物品贴图 / 药水效果色块（36px 主网格） */
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

/** 物品选择器：搜索 + 分类 chips + 物品网格 */
export function ItemSelector({
  search,
  onSearchChange,
  activeCategory,
  onCategoryChangeWithPanelReset,
  selected,
  onToggle,
  mcVersion = '',
}: {
  search: string
  onSearchChange: (v: string) => void
  activeCategory: string
  onCategoryChangeWithPanelReset: (cat: string) => void
  selected: Map<string, SelectedEntry>
  onToggle: (item: MinecraftItem) => void
  /**
   * 目标实例的 MC 版本，用于给「晚于该版本的物品」打版本徽章。
   * 缺省空串 = 未知版本 ⇒ 全部按「不判断」处理（不显示「不适用」的假告警）。
   */
  mcVersion?: string
}) {
  const filteredItems = useMemo(() => {
    let items: MinecraftItem[]
    if (activeCategory === '药水') {
      items = POTION_VIRTUAL_ITEMS
    } else if (activeCategory === '全部') {
      items = [...MINECRAFT_ITEMS, ...POTION_VIRTUAL_ITEMS]
    } else {
      items = MINECRAFT_ITEMS.filter((i) => i.category === activeCategory)
    }
    const query = search.trim().toLowerCase()
    if (query.length > 0) {
      items = items.filter(
        (i) =>
          i.name.toLowerCase().includes(query) ||
          i.id.toLowerCase().includes(query) ||
          fullItemId(i.id).toLowerCase().includes(query),
      )
    }
    return items
  }, [activeCategory, search])

  return (
    <>
      {/* 搜索框 */}
      <SearchInput
        value={search}
        onValueChange={onSearchChange}
        placeholder="搜索物品名称或 ID..."
        aria-label="搜索物品"
      />

      {/* 分类 chips + 匹配数 */}
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-mcs-2xs text-mcs-text-muted">
          找到 {filteredItems.length} 个物品
        </span>
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {ITEM_CATEGORIES.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => onCategoryChangeWithPanelReset(cat)}
              className={cn(
                'shrink-0 rounded-full border border-transparent px-2 py-0.5 text-mcs-xs transition-colors',
                activeCategory === cat
                  ? `${TONE_SELECTED_CLASSES} font-medium`
                  : 'text-mcs-text-muted hover:bg-mcs-state-hover hover:text-mcs-text-default',
              )}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* 物品网格：列数按**面板实宽**切档（@container 在 PlayerDetailPanel 的 aside 上）。
          本面板 embedded 内嵌在详情面板里，容器宽在两种形态下差 580px（内联 w-105=420px /
          Sheet 全宽约 1000px）。原来按视口断（sm 5 列 / lg 6 列）完全反向：内联 420px
          在 1280 视口下拿到 6 列，每格仅 ~54px，36px 缩略图下的物品名与 id 双双被
          truncate 截掉；而 Sheet 全宽在 <1024 视口下只给 5 列，白白少排一列。
          档位按格子最小可用宽反推：一格要放得下 36px 缩略图 + 不截断的物品名 ⇒ ≥88px，
          故 <576px 4 列、≥576px 5 列、≥896px 6 列 */}
      {filteredItems.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1.5 py-8">
          <Terminal className="size-6 text-mcs-text-muted" aria-hidden />
          <p className="text-mcs-sm text-mcs-text-muted">没有找到匹配的物品</p>
        </div>
      ) : (
        <div
          className="grid flex-1 grid-cols-4 content-start gap-1.5 overflow-y-auto pb-1 @xl:grid-cols-5 @4xl:grid-cols-6"
          data-testid="give-item-grid"
        >
          {filteredItems.map((item) => (
            <ItemCell
              key={item.id}
              item={item}
              entry={selected.get(item.id)}
              effect={potionEffectFor(item.id)}
              isSelected={selected.has(item.id)}
              onToggle={onToggle}
              mcVersion={mcVersion}
            />
          ))}
        </div>
      )}
    </>
  )
}
