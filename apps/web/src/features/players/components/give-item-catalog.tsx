/**
 * 物品目录（工作台左栏）——搜索 + 分类 + 最近/礼包快捷入口 + 物品栅格
 *
 * 栅格列数用 auto-fill（每格 ≥88px）而不是容器断点：一格要同时放下 32px 缩略图与
 * 不截断的最长中文名（7 字 ≈ 84px），列数随可用宽自然增减，工作台在 606px 与更宽时
 * 都得到同样的格子尺寸。键盘模型中整张栅格只占一个 Tab 停靠点（roving tabindex）。
 *
 * 货架只列**目标实例能发**的物品：版本判据在数据层就过滤掉（不是灰格子 + 点击 toast），
 * 最近发放与礼包同样过这道闸——它们都可能来自别的实例。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Gift, Search, Terminal } from 'lucide-react'
import { Chip } from '@/components/mcs/chip'
import { ItemIcon } from '@/components/mcs/item-icon'
import { SearchInput } from '@/components/mcs/search-input'
import { toneClasses, TONE_SELECTED_SURFACE_CLASSES } from '@/components/mcs/tone'
import { cn } from '@/lib/utils'
import { ITEM_CATEGORIES, MINECRAFT_ITEMS, fullItemId, type MinecraftItem } from '@/lib/mc-items'
import { MINECRAFT_POTIONS, type PotionEffect } from '@/lib/mc-potions'
import { itemAvailabilityError } from '@/lib/mc-give'
import type { KitPreset } from '@/lib/mc-kits'
import { useGiveDraftStore } from '../give-draft'

/** 药水效果虚拟物品（id 用效果 id，category 固定「药水」） */
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

/** 药水效果色（RGB int → #rrggbb，游戏数据展示色） */
export function effectColorHex(effect: PotionEffect): string {
  return `#${effect.color.toString(16).padStart(6, '0')}`
}

/** 物品贴图 / 药水效果色块 */
export function ItemThumb({ item, size }: { item: MinecraftItem; size: number }) {
  const effect = potionEffectFor(item.id)
  if (effect) {
    return (
      <span
        data-testid={`potion-dot-${item.id}`}
        role="img"
        aria-label={`${effect.name} 效果色`}
        title={effect.name}
        className="flex shrink-0 items-center justify-center rounded-mcs-xs border"
        style={{
          width: size,
          height: size,
          backgroundColor: `color-mix(in srgb, ${effectColorHex(effect)} 26%, var(--mcs-bg-muted))`,
          borderColor: `color-mix(in srgb, ${effectColorHex(effect)} 55%, transparent)`,
        }}
      >
        <span
          className="block rounded-full"
          style={{
            width: Math.round(size * 0.38),
            height: Math.round(size * 0.38),
            backgroundColor: effectColorHex(effect),
          }}
        />
      </span>
    )
  }
  // 缺图 id（26.x 新物品）由 ItemIcon 渲染中性占位块，不指向不存在的文件
  return <ItemIcon id={item.id} alt={item.name} size={size} />
}

/** 单格：选中标记 / 数量角标 / 附魔角标 */
function ItemCell({
  item,
  index,
  selected,
  count,
  enchantCount,
  tabbable,
  onToggle,
  onFocus,
}: {
  item: MinecraftItem
  index: number
  selected: boolean
  count: number
  enchantCount: number
  tabbable: boolean
  onToggle: (item: MinecraftItem) => void
  onFocus: () => void
}) {
  return (
    <button
      type="button"
      data-grid-index={index}
      data-testid={`item-cell-${item.id}`}
      onClick={() => onToggle(item)}
      onFocus={onFocus}
      tabIndex={tabbable ? 0 : -1}
      aria-pressed={selected}
      title={`${item.name} · minecraft:${item.id}`}
      className={cn(
        'relative flex min-h-18 flex-col items-center gap-0.5 rounded-mcs-xs border px-1 pb-1.5 pt-1.5 transition-colors',
        selected
          ? TONE_SELECTED_SURFACE_CLASSES
          : 'border-mcs-border-muted bg-mcs-bg-muted hover:border-mcs-border-default hover:bg-mcs-bg-secondary',
      )}
    >
      <span className="relative">
        <ItemThumb item={item} size={32} />
        {selected && (
          <span
            className="absolute -right-1 -top-1 flex size-3.5 items-center justify-center rounded-full bg-mcs-accent text-mcs-on-accent"
            aria-label="已选中"
          >
            <Check className="size-2.5" aria-hidden />
          </span>
        )}
      </span>
      <span className="w-full truncate text-center text-mcs-xs text-mcs-text-default">
        {item.name}
      </span>
      {/* id 只给读屏与检索：同名物品（如「药水」）靠它区分 */}
      <span className="sr-only">{item.id}</span>
      {selected && enchantCount > 0 && (
        <span
          className={cn(
            'absolute bottom-1 left-1 rounded-mcs-xs border px-1 text-mcs-2xs font-semibold leading-tight',
            toneClasses('purple'),
          )}
        >
          附{enchantCount}
        </span>
      )}
      {selected && count > 1 && (
        <span className="absolute bottom-1 right-1 rounded-mcs-xs bg-mcs-accent px-1 text-mcs-2xs font-semibold leading-tight text-mcs-on-accent tabular-nums">
          {count}
        </span>
      )}
    </button>
  )
}

/** 目录：检索 + 分类 + 最近/礼包 + 栅格 */
export function GiveCatalog({
  mcVersion,
  kits,
  recentIds,
  onManageKits,
  onApplyKit,
}: {
  mcVersion: string
  kits: KitPreset[]
  /** 最近发放的物品 id（本机习惯，由面板在成功发放后更新） */
  recentIds: string[]
  onManageKits: () => void
  onApplyKit: (kit: KitPreset) => void
}) {
  const search = useGiveDraftStore((s) => s.search)
  const category = useGiveDraftStore((s) => s.category)
  const entries = useGiveDraftStore((s) => s.entries)
  const setSearch = useGiveDraftStore((s) => s.setSearch)
  const setCategory = useGiveDraftStore((s) => s.setCategory)
  const toggleItem = useGiveDraftStore((s) => s.toggleItem)
  const addItem = useGiveDraftStore((s) => s.addItem)

  const searchRef = useRef<HTMLInputElement | null>(null)
  /** 漫游焦点的停靠格（整张栅格只占一个 Tab 停靠点） */
  const [activeIndex, setActiveIndex] = useState(0)

  /* 打开面板即聚焦搜索：目录是这个界面的主入口，键盘用户不必先穿越页头与 Tab 条。
     推迟到下一帧：鼠标点 Tab 时 Radix 在 mousedown 里先 focus() 了触发器，同一帧内
     commit 阶段的聚焦会被随后的默认行为回滚（实测焦点最终停在 tab 按钮上）。 */
  useEffect(() => {
    const frame = requestAnimationFrame(() => searchRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [])

  /* 「/」把焦点送回搜索框（目录挂载期才生效，即只在给予 Tab 打开时）。
     落点已在输入类元素里时不抢键：`/` 本身是可输入字符，管理员在别的输入框打字必须能打出来。 */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      // 窄容器下清单抽屉打开时目录被 aria-hidden（Radix 给遮罩外节点打的）：
      // 焦点不能跳回遮罩后的搜索框
      if (searchRef.current?.closest('[aria-hidden="true"]')) return
      e.preventDefault()
      searchRef.current?.focus()
      searchRef.current?.select()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const selectedById = useMemo(() => new Map(entries.map((e) => [e.item.id, e])), [entries])

  /* 目录只列**这个实例能发的**物品：版本不支持的 id 不进货架，而不是摆成灰格子让用户点了
     才被 toast 拒——面板拿到 mcVersion 就是为了替用户判掉，不是把判断转嫁给点击。
     版本未知（''）时不过滤：判据不存在时不能猜，此时全列出来由清单的常驻告警兜底。 */
  const { filteredItems, hiddenByVersion } = useMemo(() => {
    let items: MinecraftItem[]
    if (category === '药水') items = POTION_VIRTUAL_ITEMS
    else if (category === '全部') items = [...MINECRAFT_ITEMS, ...POTION_VIRTUAL_ITEMS]
    else items = MINECRAFT_ITEMS.filter((i) => i.category === category)
    const query = search.trim().toLowerCase()
    if (query.length > 0) {
      items = items.filter(
        (i) =>
          i.name.toLowerCase().includes(query) ||
          i.id.toLowerCase().includes(query) ||
          fullItemId(i.id).toLowerCase().includes(query),
      )
    }
    const available = items.filter((i) => itemAvailabilityError(i, mcVersion) === null)
    return { filteredItems: available, hiddenByVersion: items.length - available.length }
  }, [category, search, mcVersion])

  // 过滤后停靠格越界（换了分类/搜索词）时渲染期夹取：整张栅格仍保留一个 Tab 停靠点，
  // 用户下一次方向键会在新落点继续走（无须用 effect 回写状态，那会多一轮渲染）
  const tabbableIndex = Math.min(activeIndex, Math.max(0, filteredItems.length - 1))

  /** 最近发放来自本机其他实例，可能含当前版本没有的 id：同样在入口处判掉 */
  const recentItems = recentIds
    .map((id) => MINECRAFT_ITEMS.find((i) => i.id === id))
    .filter((i): i is MinecraftItem => i !== undefined)
    .filter((i) => itemAvailabilityError(i, mcVersion) === null)

  /** 方向键走格（列数从计算样式取，与 auto-fill 实际排布一致） */
  const onGridKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const total = filteredItems.length
    if (total === 0) return
    const cols = getComputedStyle(e.currentTarget).gridTemplateColumns.split(' ').length
    const current = Number((document.activeElement as HTMLElement | null)?.dataset.gridIndex)
    if (!Number.isInteger(current)) return
    let next: number | null = null
    if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = total - 1
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const target = current + (e.key === 'ArrowLeft' ? -1 : 1)
      // 横向不跨行：跨行会跳到视觉上另一端的格子，与方向键的预期不符
      if (
        target >= 0 &&
        target < total &&
        Math.floor(target / cols) === Math.floor(current / cols)
      ) {
        next = target
      }
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const target = current + (e.key === 'ArrowUp' ? -cols : cols)
      if (target >= 0 && target < total) next = target
    }
    if (next === null) return
    e.preventDefault()
    setActiveIndex(next)
    e.currentTarget.querySelector<HTMLElement>(`[data-grid-index="${next}"]`)?.focus()
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-col">
      {/* 检索与分类 */}
      <div className="flex flex-col gap-2 px-3 pt-2.5">
        <div className="relative">
          <SearchInput
            ref={searchRef}
            value={search}
            onValueChange={setSearch}
            placeholder="搜索物品名称或 ID（如 钻石 / diamond_sword）"
            aria-label="搜索物品"
          />
          {search.length === 0 && (
            <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded-mcs-xs border border-mcs-border-muted px-1 font-mono text-mcs-2xs text-mcs-text-muted">
              /
            </kbd>
          )}
        </div>
        <div className="flex gap-1 overflow-x-auto pb-0.5">
          {ITEM_CATEGORIES.map((cat) => (
            <Chip
              key={cat}
              onClick={() => setCategory(cat)}
              selected={category === cat}
              className="shrink-0"
            >
              {cat}
            </Chip>
          ))}
        </div>
      </div>

      {/* 快速入口：最近发放 + 礼包预设 */}
      <div className="flex flex-col gap-1.5 border-b border-mcs-border-muted px-3 pb-2 pt-2">
        {recentItems.length > 0 && (
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="w-14 shrink-0 text-mcs-2xs text-mcs-text-muted">最近</span>
            <div className="flex min-w-0 gap-1 overflow-x-auto">
              {recentItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => addItem(item)}
                  aria-label={`最近：${item.name}`}
                  title={`再给一个 ${item.name}`}
                  className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full border border-mcs-border-muted bg-mcs-bg-muted pl-1 pr-2 text-mcs-xs text-mcs-text-default hover:border-mcs-border-default hover:bg-mcs-bg-secondary"
                >
                  <ItemThumb item={item} size={16} />
                  {item.name}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="flex w-14 shrink-0 items-center gap-1 text-mcs-2xs text-mcs-text-muted">
            <Gift className="size-3" aria-hidden />
            礼包
          </span>
          <div className="flex min-w-0 gap-1 overflow-x-auto">
            {kits.map((kit) => (
              <button
                key={kit.name}
                type="button"
                onClick={() => onApplyKit(kit)}
                data-testid={`kit-chip-${kit.name}`}
                title={kit.desc || `含 ${kit.items.length} 件物品`}
                className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-mcs-xs border border-mcs-border-muted bg-mcs-bg-muted pl-1.5 pr-2 text-mcs-xs text-mcs-text-default hover:border-mcs-border-default hover:bg-mcs-bg-secondary"
              >
                <span>{kit.icon}</span>
                {kit.name}
                <span className="font-mono text-mcs-2xs text-mcs-text-muted">
                  {kit.items.length} 件
                </span>
              </button>
            ))}
            <button
              type="button"
              onClick={onManageKits}
              className="inline-flex h-7 shrink-0 items-center gap-1 rounded-mcs-xs border border-dashed border-mcs-border-default px-2 text-mcs-xs text-mcs-text-muted hover:bg-mcs-state-hover hover:text-mcs-text-default"
            >
              管理
            </button>
          </div>
        </div>
      </div>

      {/* 结果行 */}
      <div className="flex items-center gap-2 px-3 pb-1 pt-2 text-mcs-2xs text-mcs-text-muted">
        <span>
          找到 {filteredItems.length} 件{search.trim().length > 0 && ` · “${search.trim()}”`}
          {/* 因版本被挡在货架外的数量要明说：否则搜「硫磺」得到空结果像目录缺数据 */}
          {hiddenByVersion > 0 && `（${hiddenByVersion} 件需更高版本）`}
        </span>
        <span className="ml-auto hidden items-center gap-1 @[560px]:inline-flex">
          <Terminal className="size-3" aria-hidden />
          点击添加，再在清单里调数量与属性
        </span>
      </div>

      {/* 物品栅格（整张栅格一个 Tab 停靠点） */}
      {filteredItems.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-6 py-8 text-center">
          <Search className="size-6 text-mcs-text-muted" aria-hidden />
          <p className="text-mcs-sm text-mcs-text-muted">
            {hiddenByVersion > 0 ? '该版本没有匹配的物品' : '没有找到匹配的物品'}
          </p>
          {hiddenByVersion > 0 && (
            <p className="text-mcs-xs text-mcs-text-muted">
              有 {hiddenByVersion} 件匹配，但需要比 MC {mcVersion} 更新的版本
            </p>
          )}
          <button
            type="button"
            onClick={() => setSearch('')}
            className="rounded-mcs-xs px-2 py-1 text-mcs-xs text-mcs-accent-fg hover:bg-mcs-state-hover"
          >
            查看全部物品
          </button>
        </div>
      ) : (
        <div
          role="group"
          aria-label="物品目录"
          data-testid="give-item-grid"
          onKeyDown={onGridKeyDown}
          className="grid flex-1 content-start gap-1.5 overflow-y-auto px-3 pb-3 pt-1"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(88px, 1fr))' }}
        >
          {filteredItems.map((item, index) => {
            const entry = selectedById.get(item.id)
            return (
              <ItemCell
                key={item.id}
                item={item}
                index={index}
                selected={entry !== undefined}
                count={entry?.count ?? 0}
                enchantCount={entry ? Object.keys(entry.enchants).length : 0}
                tabbable={index === tabbableIndex}
                onToggle={toggleItem}
                onFocus={() => setActiveIndex(index)}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}
