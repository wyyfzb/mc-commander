/**
 * GiveItemPanel —— 给予物品面板（embedded 内嵌模式；弹窗模式由调用方用 Dialog 包裹本组件）。
 * 物品选择/搜索/分类网格 + 数量与快速档 + 附魔面板（冲突禁用、等级选择）+ 药水面板（瓶型/等级/时长档）+
 * 命令预览与复制；附魔/药水命令含特殊字符需 RCON，执行逐条走 onAction 并按单/批量模式汇总 toast。
 * 预设礼包 Tab：默认礼包 + 新建/编辑/删除，localStorage 持久化，缺失物品静默跳过。
 */
import { memo, useCallback, useMemo, useState } from 'react'
import {
  Check,
  ChevronDown,
  ChevronUp,
  CloudOff,
  Copy,
  FlaskConical,
  Minus,
  MoreVertical,
  Pencil,
  Plus,
  Search,
  SearchX,
  Terminal,
  Trash2,
  Wand2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'
import { cn } from '@/lib/utils'
import { ApiError } from '@/api/client'
import { getFriendlyErrorMessage } from '@/api/errors'
import {
  ITEM_CATEGORIES,
  MINECRAFT_ITEMS,
  fullItemId,
  itemImageUrl,
  type MinecraftItem,
} from '@/lib/mc-items'
import {
  MINECRAFT_POTIONS,
  POTION_BOTTLE_TYPES,
  POTION_LEVEL_ROMAN,
  POTION_MAX_LEVEL,
  durationsForLevel,
  potionLevelLabel,
  type PotionConfig,
  type PotionEffect,
} from '@/lib/mc-potions'
import {
  buildGiveCommand,
  getEnchantmentsForItem,
  isEnchantmentDisabledBy,
  toRoman,
  type Enchantment,
} from '@/lib/mc-enchantments'
import {
  loadKitsFromStorage,
  saveKitsToStorage,
  type KitItem,
  type KitPreset,
} from '@/lib/mc-kits'
import { formatBatchSummary, formatFailureDetails, runBatchForTargets } from '@/lib/mc-batch'
import type { Player } from '@/api/types'
import type { PlayerActionRequest } from '../mutations'

export interface GiveItemPanelProps {
  /** 单个模式目标玩家；批量模式为 null */
  player: Player | null
  /** 批量目标（单个模式为 [player]） */
  batchTargets: Player[]
  isBatchMode: boolean
  instanceId: string
  /** MC 服务端版本（NBT 三格式判定来源，空串按新版） */
  mcVersion: string
  isRconConnected: boolean
  onAction: (req: PlayerActionRequest) => Promise<void>
  /** 成功后回调（关闭弹窗等，由调用方决定） */
  onDone?: () => void
}

/** 数量上限（1-6400 clamp） */
const MAX_COUNT = 6400
/** 快速数量档 */
const QUICK_COUNTS = [1, 16, 64, 256, 640, 6400]
/** 礼包图标 emoji 预设（24 种） */
const KIT_ICON_PRESETS = [
  '📦', '🎁', '🌱', '💎', '🔥', '🧱', '🍖', '⚗️', '⚔️', '🛡️', '⛏️', '🪓',
  '🏹', '🎣', '🚀', '⭐', '🌟', '✨', '🎉', '🏆', '💰', '🎯', '🧪', '🍞',
]

/** 选中条目的运行时配置 */
interface SelectedEntry {
  item: MinecraftItem
  count: number
  /** 附魔映射：附魔 ID → 等级 */
  enchants: Record<string, number>
  /** 药水配置；仅效果药水条目非空 */
  potion: PotionConfig | null
}

/** 药水效果虚拟物品（id 用效果 id，category 固定「药水」，UI 展示用） */
const POTION_VIRTUAL_ITEMS: MinecraftItem[] = MINECRAFT_POTIONS.map((e) => ({
  id: e.effectId,
  name: e.name,
  category: '药水',
  stackSize: 1,
}))

/** 药水效果色（RGB int → #rrggbb，游戏数据展示色） */
function effectColorHex(effect: PotionEffect): string {
  return `#${effect.color.toString(16).padStart(6, '0')}`
}

/** 错误 → 友好文案（ApiError 走错误码映射，其余网络错误兜底） */
function friendlyError(err: unknown): string {
  if (err instanceof ApiError) return getFriendlyErrorMessage(err.code, err.message)
  return '网络错误'
}

export function GiveItemPanel({
  player,
  batchTargets,
  isBatchMode,
  mcVersion,
  isRconConnected,
  onAction,
  onDone,
}: GiveItemPanelProps) {
  const [mainTab, setMainTab] = useState<'items' | 'kits'>('items')
  const [search, setSearch] = useState('')
  const [activeCategory, setActiveCategory] = useState<string>('全部')
  const [selected, setSelected] = useState<Map<string, SelectedEntry>>(() => new Map())
  const [expandedEnchantId, setExpandedEnchantId] = useState<string | null>(null)
  const [expandedPotionId, setExpandedPotionId] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [kits, setKits] = useState<KitPreset[]>(() => loadKitsFromStorage(window.localStorage))
  const [editing, setEditing] = useState<{ index: number | null; kit: KitPreset } | null>(null)
  const [deleteIndex, setDeleteIndex] = useState<number | null>(null)
  const [confirmBatchOpen, setConfirmBatchOpen] = useState(false)

  /** 过滤后物品（分类 → 搜索；「全部」含药水效果虚拟物品） */
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

  const entries = useMemo(() => [...selected.values()], [selected])
  const totalCount = entries.reduce((sum, e) => sum + e.count, 0)
  const enchItemCount = entries.filter((e) => Object.keys(e.enchants).length > 0).length
  /** 命令预览/执行目标名（批量取首个目标） */
  const previewName = player?.name ?? batchTargets[0]?.name ?? ''

  // ── 已选列表操作（不可变 Map 更新）──────────────────────────

  // useCallback 稳定引用：ItemCell memo 依赖 onToggle 不变才跳过未选中 cell 的重渲染
  const toggleItem = useCallback((item: MinecraftItem) => {
    const id = item.id
    setSelected((prev) => {
      const removed = prev.has(id)
      const next = new Map(prev)
      if (removed) {
        next.delete(id)
        // 删除展开面板（幂等；updater 内触发清理以复用 prev 判定）
        setExpandedEnchantId((c) => (c === id ? null : c))
        setExpandedPotionId((c) => (c === id ? null : c))
      } else {
        // 药水效果条目：创建默认配置（饮用药水 + I 级 + 默认时长）
        const effect = MINECRAFT_POTIONS.find((e) => e.effectId === id)
        const entry: SelectedEntry = { item, count: 1, enchants: {}, potion: null }
        if (effect) {
          const durations = durationsForLevel(effect, 1)
          entry.potion = {
            effect,
            bottle: POTION_BOTTLE_TYPES[0]!,
            level: 1,
            duration: durations.length > 0 ? durations[0]!.ticks : 1,
          }
        }
        next.set(id, entry)
      }
      return next
    })
  }, [])

  /** 数量 −/+：1-6400 clamp；减到 0 移除（同时清理展开面板） */
  const setItemCount = (id: string, count: number) => {
    const next = new Map(selected)
    const cur = next.get(id)
    if (!cur) return
    if (count < 1) {
      next.delete(id)
      if (expandedEnchantId === id) setExpandedEnchantId(null)
      if (expandedPotionId === id) setExpandedPotionId(null)
    } else {
      next.set(id, { ...cur, count: Math.min(MAX_COUNT, count) })
    }
    setSelected(next)
  }

  /** 清空全部已选 */
  const clearSelected = () => {
    setSelected(new Map())
    setExpandedEnchantId(null)
    setExpandedPotionId(null)
  }

  const toggleEnchantPanel = (id: string) => {
    setExpandedEnchantId((cur) => (cur === id ? null : id))
    setExpandedPotionId(null)
  }

  const togglePotionPanel = (id: string) => {
    setExpandedPotionId((cur) => (cur === id ? null : id))
    setExpandedEnchantId(null)
  }

  const toggleEnchant = (id: string, ench: Enchantment) => {
    setSelected((prev) => {
      const cur = prev.get(id)
      if (!cur) return prev
      const enchants = { ...cur.enchants }
      if (enchants[ench.id] !== undefined) {
        delete enchants[ench.id]
      } else {
        enchants[ench.id] = 1
      }
      return new Map(prev).set(id, { ...cur, enchants })
    })
  }

  const setEnchantLevel = (id: string, enchId: string, level: number) => {
    setSelected((prev) => {
      const cur = prev.get(id)
      if (!cur) return prev
      return new Map(prev).set(id, {
        ...cur,
        enchants: { ...cur.enchants, [enchId]: level },
      })
    })
  }

  const setPotionBottle = (id: string, bottle: PotionConfig['bottle']) => {
    setSelected((prev) => {
      const cur = prev.get(id)
      if (!cur?.potion) return prev
      return new Map(prev).set(id, {
        ...cur,
        potion: { ...cur.potion, bottle },
      })
    })
  }

  /** 等级切换：时长重置为该等级默认档位 */
  const setPotionLevel = (id: string, level: number) => {
    setSelected((prev) => {
      const cur = prev.get(id)
      if (!cur?.potion) return prev
      const durations = durationsForLevel(cur.potion.effect, level)
      return new Map(prev).set(id, {
        ...cur,
        potion: {
          ...cur.potion,
          level,
          duration: durations.length > 0 ? durations[0]!.ticks : 1,
        },
      })
    })
  }

  const setPotionDuration = (id: string, duration: number) => {
    setSelected((prev) => {
      const cur = prev.get(id)
      if (!cur?.potion) return prev
      return new Map(prev).set(id, {
        ...cur,
        potion: { ...cur.potion, duration },
      })
    })
  }

  // ── 礼包操作 ────────────────────────────────────────────────

  const persistKits = (next: KitPreset[]): boolean => {
    try {
      saveKitsToStorage(window.localStorage, next)
      return true
    } catch {
      return false
    }
  }

  const saveKit = (draft: KitPreset, index: number | null) => {
    const next = [...kits]
    if (index === null) {
      next.push(draft)
    } else {
      next[index] = draft
    }
    const saved = persistKits(next)
    if (saved) setKits(next)
    if (saved) {
      toast.success(index === null ? `已添加礼包「${draft.name}」` : `已更新礼包「${draft.name}」`)
    } else {
      toast.error('礼包保存失败，请重试')
    }
    setEditing(null)
  }

  const doDeleteKit = (index: number) => {
    const kit = kits[index]
    if (!kit) return
    const next = kits.filter((_, i) => i !== index)
    const saved = persistKits(next)
    if (saved) {
      setKits(next)
      toast.info(`已删除礼包「${kit.name}」`)
    } else {
      toast.error('礼包保存失败，请重试')
    }
    setDeleteIndex(null)
  }

  /** 应用礼包：目录外 id 静默跳过；已有条目数量累加 clamp 1-6400（防连点越界） */
  const applyKit = (kit: KitPreset) => {
    const next = new Map(selected)
    for (const entry of kit.items) {
      const item = MINECRAFT_ITEMS.find((i) => i.id === entry.id)
      if (!item) continue
      const cur = next.get(item.id)
      if (cur) {
        next.set(item.id, { ...cur, count: Math.min(MAX_COUNT, cur.count + entry.count) })
      } else {
        next.set(item.id, {
          item,
          count: Math.min(MAX_COUNT, Math.max(1, entry.count)),
          enchants: {},
          potion: null,
        })
      }
    }
    setSelected(next)
    setMainTab('items')
    toast.success(`已添加「${kit.name}」到已选列表`)
  }

  // ── 执行链路（executeGiveResults 规格）──────────────────────

  // RCON 前置守卫（附魔/药水命令含特殊字符必须走 RCON）
  const guardGive = (): boolean => {
    const hasEnchanted = entries.some((e) => Object.keys(e.enchants).length > 0)
    const hasPotion = entries.some((e) => e.potion !== null)
    if ((hasEnchanted || hasPotion) && !isRconConnected) {
      toast.error(
        hasPotion
          ? '附魔/药水物品给予需启用 RCON，请检查实例 RCON 配置'
          : '附魔物品给予需启用 RCON，请检查实例 RCON 配置',
      )
      return false
    }
    return true
  }

  /** 批量：至少一名在线才弹确认；全部离线直接走执行器（由其提示） */
  const requestGive = () => {
    if (entries.length === 0 || running) return
    if (!guardGive()) return
    if (isBatchMode && batchTargets.some((t) => t.isOnline)) {
      setConfirmBatchOpen(true)
      return
    }
    void runGive()
  }

  const confirmBatchGive = () => {
    setConfirmBatchOpen(false)
    void runGive()
  }

  const runGive = async () => {
    setRunning(true)
    try {
      if (isBatchMode) {
        const result = await runBatchForTargets({
          targets: batchTargets.map((p) => ({ name: p.name, isOnline: p.isOnline })),
          requireOnline: true,
          execute: async (target) => {
            for (const e of entries) {
              await onAction({
                kind: 'command',
                command: buildGiveCommand({
                  playerName: target.name,
                  item: e.item,
                  count: e.count,
                  enchants: e.enchants,
                  potion: e.potion,
                  mcVersion,
                }),
              })
            }
          },
        })
        const summary = formatBatchSummary('给予', result)
        const details = formatFailureDetails(result)
        if (result.allOffline || result.failCount > 0) {
          toast.warning(summary, { description: details })
        } else {
          toast.success(summary)
        }
      } else {
        const target = player ?? batchTargets[0] ?? null
        if (!target) return
        let successCount = 0
        for (const e of entries) {
          try {
            await onAction({
              kind: 'command',
              command: buildGiveCommand({
                playerName: target.name,
                item: e.item,
                count: e.count,
                enchants: e.enchants,
                potion: e.potion,
                mcVersion,
              }),
            })
            successCount += 1
          } catch (err) {
            toast.error(`${e.item.name} 给予失败：${friendlyError(err)}`)
          }
        }
        if (successCount > 0) {
          toast.success(`已给予 ${target.name} ${successCount} 种物品`)
        }
      }
    } finally {
      setRunning(false)
      onDone?.()
    }
  }

  // 单模式离线拦截（离线时整面板提示卡；批量模式由执行器跳过离线）
  if (!isBatchMode && player && !player.isOnline) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 rounded-mcs-sm border border-mcs-border-muted p-6 text-center">
        <CloudOff className="size-8 text-mcs-text-subtle" aria-hidden />
        <p className="text-mcs-sm text-mcs-text-default">玩家已离线，无法给予物品</p>
        <p className="text-mcs-xs text-mcs-text-subtle">给予物品需要玩家在线</p>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {/* ── 主 Tab：物品选择 / 预设礼包 ── */}
      <Tabs
        value={mainTab}
        onValueChange={(v) => setMainTab(v as 'items' | 'kits')}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList className="h-8 w-full justify-start gap-0 rounded-none border-b border-mcs-border-muted bg-transparent p-0">
          <TabsTrigger
            value="items"
            className="h-8 rounded-none border-b-2 border-transparent px-3 text-mcs-xs data-[state=active]:border-mcs-accent data-[state=active]:text-mcs-text-default data-[state=active]:shadow-none"
          >
            物品选择
          </TabsTrigger>
          <TabsTrigger
            value="kits"
            className="h-8 rounded-none border-b-2 border-transparent px-3 text-mcs-xs data-[state=active]:border-mcs-accent data-[state=active]:text-mcs-text-default data-[state=active]:shadow-none"
          >
            预设礼包
          </TabsTrigger>
        </TabsList>

        {/* ── Tab 1：物品选择 ── */}
        <TabsContent value="items" className="flex min-h-0 flex-1 flex-col gap-2">
          {/* 搜索框 */}
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-mcs-text-subtle"
              aria-hidden
            />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索物品名称或 ID..."
              aria-label="搜索物品"
              className="h-8 w-full rounded-mcs-sm border border-mcs-border-default bg-mcs-bg-default pl-8 pr-8 text-mcs-sm text-mcs-text-default placeholder:text-mcs-text-subtle focus:border-mcs-accent-border focus:outline-none focus:ring-1 focus:ring-mcs-focus-ring"
            />
            {search.length > 0 && (
              <button
                type="button"
                onClick={() => setSearch('')}
                aria-label="清空搜索"
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-mcs-xs p-0.5 text-mcs-text-subtle hover:bg-mcs-bg-hover hover:text-mcs-text-default"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            )}
          </div>

          {/* 分类 chips + 匹配数 */}
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-mcs-2xs text-mcs-text-subtle">
              找到 {filteredItems.length} 个物品
            </span>
            <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
              {ITEM_CATEGORIES.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => {
                    setActiveCategory(cat)
                    // 切换分类时关闭附魔/药水属性面板
                    setExpandedEnchantId(null)
                    setExpandedPotionId(null)
                  }}
                  className={cn(
                    'shrink-0 rounded-full px-2 py-0.5 text-mcs-xs transition-colors',
                    activeCategory === cat
                      ? 'bg-mcs-accent-bg-subtle font-medium text-mcs-accent-fg'
                      : 'text-mcs-text-muted hover:bg-mcs-bg-hover hover:text-mcs-text-default',
                  )}
                >
                  {cat}
                </button>
              ))}
            </div>
          </div>

          {/* 已选栏（横向滚动 chips） */}
          {entries.length > 0 && (
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
                    className="flex w-[240px] shrink-0 items-center gap-1 rounded-mcs-sm border border-mcs-border-subtle bg-mcs-bg-muted py-1 pl-1 pr-1.5"
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
                          onClick={() => setItemCount(entry.item.id, entry.count - 1)}
                          aria-label={`减少 ${entry.item.name} 数量`}
                          className="rounded-mcs-xs p-0.5 text-mcs-text-muted hover:bg-mcs-bg-hover hover:text-mcs-text-default"
                        >
                          <Minus className="size-3" aria-hidden />
                        </button>
                        <span className="w-6 text-center text-mcs-xs font-semibold tabular-nums text-mcs-accent-fg">
                          {entry.count}
                        </span>
                        <button
                          type="button"
                          onClick={() => setItemCount(entry.item.id, entry.count + 1)}
                          aria-label={`增加 ${entry.item.name} 数量`}
                          className="rounded-mcs-xs p-0.5 text-mcs-text-muted hover:bg-mcs-bg-hover hover:text-mcs-text-default"
                        >
                          <Plus className="size-3" aria-hidden />
                        </button>
                        {canEnchant ? (
                          <button
                            type="button"
                            onClick={() => toggleEnchantPanel(entry.item.id)}
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
                            onClick={() => togglePotionPanel(entry.item.id)}
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
                          className="shrink-0 rounded-mcs-xs p-0.5 text-mcs-text-subtle hover:bg-mcs-bg-hover hover:text-mcs-text-default"
                        >
                          <ChevronDown className="size-3.5" aria-hidden />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {QUICK_COUNTS.map((n) => (
                          <DropdownMenuItem key={n} onClick={() => setItemCount(entry.item.id, n)}>
                            {n}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <button
                      type="button"
                      onClick={() => toggleItem(entry.item)}
                      aria-label={`移除 ${entry.item.name}`}
                      className="shrink-0 rounded-mcs-xs p-0.5 text-mcs-text-subtle hover:bg-mcs-bg-hover hover:text-mcs-text-default"
                    >
                      <X className="size-3" aria-hidden />
                    </button>
                  </div>
                )
              })}
              <Button
                variant="ghost"
                size="xs"
                onClick={clearSelected}
                aria-label="清空已选物品"
                className="ml-auto shrink-0 text-mcs-text-muted hover:text-mcs-error-fg"
              >
                清空
              </Button>
            </div>
          )}

          {/* 附魔面板（同时展开一个） */}
          {expandedEnchantId !== null && selected.has(expandedEnchantId) && (
            <EnchantPanel
              entry={selected.get(expandedEnchantId)!}
              playerName={previewName}
              mcVersion={mcVersion}
              onToggle={(ench) => toggleEnchant(expandedEnchantId, ench)}
              onSetLevel={(enchId, level) => setEnchantLevel(expandedEnchantId, enchId, level)}
              onClose={() => setExpandedEnchantId(null)}
            />
          )}

          {/* 药水面板（同时展开一个） */}
          {expandedPotionId !== null && selected.has(expandedPotionId) && (
            <PotionPanel
              entry={selected.get(expandedPotionId)!}
              playerName={previewName}
              mcVersion={mcVersion}
              onSetBottle={(b) => setPotionBottle(expandedPotionId, b)}
              onSetLevel={(l) => setPotionLevel(expandedPotionId, l)}
              onSetDuration={(d) => setPotionDuration(expandedPotionId, d)}
              onClose={() => setExpandedPotionId(null)}
            />
          )}

          {/* 物品网格 */}
          {filteredItems.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-1.5 py-8">
              <SearchX className="size-6 text-mcs-text-subtle" aria-hidden />
              <p className="text-mcs-sm text-mcs-text-subtle">没有找到匹配的物品</p>
            </div>
          ) : (
            <div className="grid flex-1 grid-cols-4 content-start gap-1.5 overflow-y-auto pb-1 sm:grid-cols-5 lg:grid-cols-6" data-testid="give-item-grid">
              {filteredItems.map((item) => (
                <ItemCell
                  key={item.id}
                  item={item}
                  entry={selected.get(item.id)}
                  effect={potionEffectFor(item.id)}
                  isSelected={selected.has(item.id)}
                  onToggle={toggleItem}
                />
              ))}
            </div>
          )}
        </TabsContent>

        {/* ── Tab 2：预设礼包 ── */}
        <TabsContent value="kits" className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col gap-2 pb-1">
            {/* 新建礼包卡 */}
            <button
              type="button"
              onClick={() =>
                setEditing({ index: null, kit: { name: '', icon: '📦', desc: '', items: [] } })
              }
              className="flex items-center gap-2.5 rounded-mcs-md border border-dashed border-mcs-accent-border bg-mcs-accent-bg-subtle px-3 py-2.5 text-left transition-colors hover:bg-mcs-bg-hover"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-mcs-sm bg-mcs-accent-bg-subtle">
                <Plus className="size-4 text-mcs-accent-fg" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-mcs-sm font-semibold text-mcs-accent-fg">新建礼包</span>
                <span className="block text-mcs-xs text-mcs-text-subtle">点击创建自定义物品礼包</span>
              </span>
            </button>

            {/* 礼包卡片 */}
            {kits.map((kit, index) => (
              <div
                key={`${kit.name}-${index}`}
                data-testid={`kit-card-${kit.name}`}
                className="flex items-center gap-2.5 rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-default px-3 py-2.5"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-mcs-sm bg-mcs-accent-bg-subtle text-mcs-lg">
                  {kit.icon}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-mcs-sm font-medium text-mcs-text-default">
                    {kit.name}
                  </div>
                  <div className="truncate text-mcs-xs text-mcs-text-subtle">
                    {kit.desc || `含 ${kit.items.length} 件物品`}
                  </div>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label={`${kit.name} 礼包操作`}>
                      <MoreVertical aria-hidden />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={() => setEditing({ index, kit: { ...kit, items: kit.items.map((it) => ({ ...it })) } })}
                    >
                      <Pencil aria-hidden />
                      编辑
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="text-mcs-error-fg focus:text-mcs-error-fg"
                      onClick={() => setDeleteIndex(index)}
                    >
                      <Trash2 aria-hidden />
                      删除
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button size="xs" onClick={() => applyKit(kit)}>
                  <Plus aria-hidden />
                  添加
                </Button>
              </div>
            ))}
          </div>
        </TabsContent>
      </Tabs>

      {/* ── 主命令预览（契约第 3 条：随配置实时 buildGiveCommand；批量预览首个目标）
            附魔/药水面板展开的条目面板内已有预览，此处跳过避免同一条命令重复渲染 ── */}
      {entries.length > 0 && (
        <div className="flex flex-col gap-1" data-testid="command-previews">
          {entries.map((entry) => {
            const isPanelOpen = expandedEnchantId === entry.item.id || expandedPotionId === entry.item.id
            if (isPanelOpen) return null
            return (
              <CommandPreview
                key={entry.item.id}
                command={buildGiveCommand({
                  playerName: previewName,
                  item: entry.item,
                  count: entry.count,
                  enchants: entry.enchants,
                  potion: entry.potion,
                  mcVersion,
                })}
              />
            )
          })}
        </div>
      )}

      {/* ── 页脚汇总 + 给予按钮 ── */}
      <div className="flex items-center justify-between gap-2 border-t border-mcs-border-muted pt-2">
        {entries.length > 0 ? (
          <div className="min-w-0">
            <p className="text-mcs-sm text-mcs-text-default">
              已选 {entries.length} 种物品，共 {totalCount} 个
            </p>
            <p className="text-mcs-xs text-mcs-text-subtle">
              {enchItemCount > 0
                ? `将执行 ${entries.length} 条 give 命令（含 ${enchItemCount} 个附魔物品）`
                : `将执行 ${entries.length} 条 give 命令`}
            </p>
          </div>
        ) : (
          <p className="text-mcs-sm text-mcs-text-subtle">请点击上方物品添加</p>
        )}
        <Button
          size="sm"
          disabled={entries.length === 0 || running}
          onClick={requestGive}
        >
          <Check aria-hidden />
          {running ? '执行中…' : entries.length > 0 ? `给予 (${entries.length})` : '给予'}
        </Button>
      </div>

      {/* ── 礼包编辑器 ── */}
      {editing !== null && (
        <KitEditorDialog
          initial={editing.kit}
          isNew={editing.index === null}
          onSave={(draft) => saveKit(draft, editing.index)}
          onClose={() => setEditing(null)}
        />
      )}

      {/* ── 批量给予确认（Tasteful Friction：事故场景最后一道确认） ── */}
      <ConfirmDialog
        open={confirmBatchOpen}
        onOpenChange={(open) => {
          if (!open) setConfirmBatchOpen(false)
        }}
        title="确认批量给予"
        description={`将向 ${batchTargets.filter((t) => t.isOnline).length} 名在线玩家给予 ${entries.length} 种物品（共 ${entries.length * batchTargets.filter((t) => t.isOnline).length} 条命令）`}
        confirmText="确认给予"
        warning="批量执行将逐条发送命令，且无法撤销"
        onConfirm={confirmBatchGive}
      />

      {/* ── 删除礼包确认 ── */}
      <ConfirmDialog
        open={deleteIndex !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteIndex(null)
        }}
        title="删除礼包"
        description={
          deleteIndex !== null
            ? `确定要删除「${kits[deleteIndex]?.name ?? ''}」吗？此操作不可撤销。`
            : ''
        }
        confirmText="删除"
        danger
        onConfirm={() => {
          if (deleteIndex !== null) doDeleteKit(deleteIndex)
        }}
      />
    </div>
  )
}

/** 药水效果查找（id 在效果目录中即为效果药水虚拟物品） */
function potionEffectFor(itemId: string): PotionEffect | undefined {
  return MINECRAFT_POTIONS.find((e) => e.effectId === itemId)
}

/** 物品网格单元格（memo：212 项大列表，仅选中/数量/附魔变化时重渲染；onToggle 由 useCallback 稳定） */
const ItemCell = memo(function ItemCell({
  item,
  entry,
  effect,
  isSelected,
  onToggle,
}: {
  item: MinecraftItem
  entry: SelectedEntry | undefined
  effect?: PotionEffect
  isSelected: boolean
  onToggle: (item: MinecraftItem) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onToggle(item)}
      aria-pressed={isSelected}
      data-testid={`item-cell-${item.id}`}
      className={cn(
        'relative flex flex-col items-center gap-0.5 rounded-mcs-sm border px-1 pb-1 pt-1 transition-colors',
        isSelected
          ? 'border-mcs-accent-border bg-mcs-accent-bg-subtle'
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
        {isSelected && entry !== undefined && entry.count > 1 && (
          <span className="absolute bottom-0 right-0 rounded-mcs-xs bg-mcs-accent px-1 text-mcs-2xs font-semibold leading-tight text-mcs-on-accent tabular-nums">
            {entry.count}
          </span>
        )}
        {isSelected && entry !== undefined && Object.keys(entry.enchants).length > 0 && (
          <span className="absolute left-0 top-0 rounded-mcs-xs border border-mcs-purple-border bg-mcs-purple-bg-subtle px-1 text-mcs-2xs font-semibold leading-tight text-mcs-purple-fg">
            附{Object.keys(entry.enchants).length}
          </span>
        )}
      </span>
      <span className="w-full truncate text-center text-mcs-xs text-mcs-text-default" title={item.name}>
        {item.name}
      </span>
      <span
        className="w-full truncate text-center font-mono text-mcs-2xs text-mcs-text-subtle"
        title={fullItemId(item.id)}
      >
        {item.id}
      </span>
    </button>
  )
})

/** 物品贴图 / 药水效果色块（36px 主网格 / 22px 已选 chip 复用；props 全稳定，memo 防重渲染） */
const ItemThumb = memo(function ItemThumb({
  item,
  effect,
  size,
}: {
  item: MinecraftItem
  effect?: PotionEffect
  size: number
}) {
  if (effect) {
    // 效果药水无 mc-heads 贴图：用效果色块替代（游戏数据色）
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
})

/** 命令预览：终端深底 + mono 小字 + 复制按钮 */
function CommandPreview({ command }: { command: string }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command)
      toast.success('命令已复制')
    } catch {
      toast.error('复制失败')
    }
  }
  return (
    <div
      className="flex items-center gap-1.5 rounded-mcs-xs border border-mcs-border-muted px-2 py-1.5"
      style={{ backgroundColor: 'var(--mcs-terminal-bg)' }}
      data-testid="command-preview"
    >
      <Terminal className="size-3 shrink-0 text-mcs-terminal-accent" aria-hidden />
      <code className="min-w-0 flex-1 truncate font-mono text-mcs-2xs leading-snug text-mcs-terminal-fg-bright">
        {command}
      </code>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label="复制命令"
        className="shrink-0 rounded-mcs-xs p-0.5 text-mcs-terminal-subtle hover:bg-mcs-bg-hover hover:text-mcs-text-default"
      >
        <Copy className="size-3" aria-hidden />
      </button>
    </div>
  )
}

/** 附魔开关（紫 accent） */
function EnchantToggle({
  label,
  on,
  disabled,
  onToggle,
}: {
  label: string
  on: boolean
  disabled?: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={on}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        'relative h-4 w-7 shrink-0 rounded-full border transition-colors',
        on
          ? 'border-mcs-purple-border bg-mcs-purple-bg-subtle'
          : 'border-mcs-border-default bg-mcs-bg-muted',
        disabled && 'pointer-events-none',
      )}
    >
      <span
        className={cn(
          'absolute top-1/2 size-2.5 -translate-y-1/2 rounded-full transition-[left,background-color]',
          on ? 'left-[14px] bg-mcs-purple-fg' : 'left-0.5 bg-mcs-text-subtle',
        )}
      />
    </button>
  )
}

/** 附魔面板（紫底，同时展开一个；命令预览随配置实时） */
function EnchantPanel({
  entry,
  playerName,
  mcVersion,
  onToggle,
  onSetLevel,
  onClose,
}: {
  entry: SelectedEntry
  playerName: string
  mcVersion: string
  onToggle: (ench: Enchantment) => void
  onSetLevel: (enchId: string, level: number) => void
  onClose: () => void
}) {
  const available = getEnchantmentsForItem(entry.item)
  const selectedIds = Object.keys(entry.enchants)
  const command = buildGiveCommand({
    playerName,
    item: entry.item,
    count: entry.count,
    enchants: entry.enchants,
    potion: entry.potion,
    mcVersion,
  })

  return (
    <div className="rounded-mcs-sm border border-mcs-purple-border bg-mcs-purple-bg-subtle p-2">
      <div className="mb-1.5 flex items-center gap-1.5">
        <Wand2 className="size-3.5 shrink-0 text-mcs-purple-fg" aria-hidden />
        <span className="truncate text-mcs-xs font-semibold text-mcs-purple-fg">
          附魔 · {entry.item.name}
        </span>
        <span className="shrink-0 text-mcs-2xs text-mcs-text-subtle">{available.length} 种可用</span>
        <Button
          variant="ghost"
          size="icon-xs"
          className="ml-auto"
          onClick={onClose}
          aria-label="收起附魔面板"
        >
          <ChevronUp className="size-3.5" aria-hidden />
        </Button>
      </div>
      <div className="max-h-40 overflow-y-auto border-t border-mcs-purple-border pt-1">
        {available.map((ench) => {
          const isOn = entry.enchants[ench.id] !== undefined
          const isDisabled = !isOn && isEnchantmentDisabledBy(ench.id, selectedIds)
          return (
            <div
              key={ench.id}
              className={cn('flex items-center gap-2 py-1', isDisabled && 'opacity-35')}
            >
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                <span
                  className={cn(
                    'truncate text-mcs-xs',
                    isOn ? 'font-medium text-mcs-purple-fg' : 'text-mcs-text-default',
                  )}
                >
                  {ench.name}
                </span>
                <span className="shrink-0 font-mono text-mcs-2xs text-mcs-text-subtle">
                  I-{toRoman(ench.maxLevel)}
                </span>
                {ench.isNew121 && (
                  <span className="shrink-0 rounded-mcs-xs border border-mcs-orange-border bg-mcs-orange-bg-subtle px-1 text-mcs-2xs font-medium text-mcs-orange-fg">
                    1.21+
                  </span>
                )}
              </div>
              {isOn && ench.maxLevel > 1 && (
                <Select
                  value={String(entry.enchants[ench.id] ?? 1)}
                  onValueChange={(v) => onSetLevel(ench.id, Number(v))}
                >
                  <SelectTrigger size="sm" aria-label={`${ench.name} 等级`} className="h-6 w-14">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: ench.maxLevel }, (_, i) => i + 1).map((lvl) => (
                      <SelectItem key={lvl} value={String(lvl)}>
                        {lvl}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {isOn && ench.maxLevel === 1 && (
                <span className="shrink-0 text-mcs-xs font-medium text-mcs-purple-fg">Lv.1</span>
              )}
              <EnchantToggle
                label={`${ench.name} 附魔开关`}
                on={isOn}
                disabled={isDisabled}
                onToggle={() => onToggle(ench)}
              />
            </div>
          )
        })}
      </div>
      <div className="mt-1.5">
        <CommandPreview command={command} />
      </div>
    </div>
  )
}

/** 药水面板：瓶型 / 等级（I-V，超原版上限标「·自定义」）/ 时长（切换等级重置）+ 瞬时提示 */
function PotionPanel({
  entry,
  playerName,
  mcVersion,
  onSetBottle,
  onSetLevel,
  onSetDuration,
  onClose,
}: {
  entry: SelectedEntry
  playerName: string
  mcVersion: string
  onSetBottle: (bottle: PotionConfig['bottle']) => void
  onSetLevel: (level: number) => void
  onSetDuration: (duration: number) => void
  onClose: () => void
}) {
  const potion = entry.potion
  if (!potion) return null
  const effect = potion.effect
  const durations = durationsForLevel(effect, potion.level)
  const color = effectColorHex(effect)
  const command = buildGiveCommand({
    playerName,
    item: entry.item,
    count: entry.count,
    enchants: entry.enchants,
    potion,
    mcVersion,
  })

  return (
    <div
      className="rounded-mcs-sm border p-2"
      style={{
        borderColor: `color-mix(in srgb, ${color} 25%, transparent)`,
        backgroundColor: `color-mix(in srgb, ${color} 8%, transparent)`,
      }}
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        <span
          data-testid="potion-panel-dot"
          className="size-3.5 shrink-0 rounded-mcs-xs"
          style={{ backgroundColor: color }}
        />
        <span className="truncate text-mcs-xs font-semibold" style={{ color }}>
          药水 · {effect.name}
        </span>
        <span className="shrink-0 text-mcs-2xs text-mcs-text-subtle">
          等级 {potionLevelLabel(potion)}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          className="ml-auto"
          onClick={onClose}
          aria-label="收起药水面板"
        >
          <ChevronUp className="size-3.5" aria-hidden />
        </Button>
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <span className="w-8 shrink-0 text-mcs-xs text-mcs-text-subtle">瓶型</span>
          <Select
            value={potion.bottle.itemId}
            onValueChange={(v) => {
              const bottle = POTION_BOTTLE_TYPES.find((b) => b.itemId === v)
              if (bottle) onSetBottle(bottle)
            }}
          >
            <SelectTrigger size="sm" aria-label="瓶型" className="min-w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {POTION_BOTTLE_TYPES.map((b) => (
                <SelectItem key={b.itemId} value={b.itemId}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-8 shrink-0 text-mcs-xs text-mcs-text-subtle">等级</span>
          <Select
            value={String(potion.level)}
            onValueChange={(v) => onSetLevel(Number(v))}
          >
            <SelectTrigger size="sm" aria-label="效果等级" className="min-w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Array.from({ length: POTION_MAX_LEVEL }, (_, i) => i + 1).map((lvl) => (
                <SelectItem key={lvl} value={String(lvl)}>
                  {lvl > effect.vanillaMaxLevel
                    ? `${POTION_LEVEL_ROMAN[lvl - 1] ?? lvl}·自定义`
                    : (POTION_LEVEL_ROMAN[lvl - 1] ?? String(lvl))}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {durations.length > 0 ? (
          <div className="flex items-center gap-2">
            <span className="w-8 shrink-0 text-mcs-xs text-mcs-text-subtle">时长</span>
            <Select
              value={String(potion.duration)}
              onValueChange={(v) => onSetDuration(Number(v))}
            >
              <SelectTrigger size="sm" aria-label="时长" className="min-w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {durations.map((d) => (
                  <SelectItem key={d.ticks} value={String(d.ticks)}>
                    {d.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : (
          <p className="text-mcs-xs text-mcs-text-subtle">
            <FlaskConical className="mr-1 inline size-3 align-[-1px]" aria-hidden />
            瞬时效果（duration=1tick），饮用即刻生效
          </p>
        )}
      </div>
      <div className="mt-1.5">
        <CommandPreview command={command} />
      </div>
    </div>
  )
}

/** 礼包编辑器：名称 + emoji 24 预设 + 描述 + 物品 chip 列表 + 物品选择器 */
function KitEditorDialog({
  initial,
  isNew,
  onSave,
  onClose,
}: {
  initial: KitPreset
  isNew: boolean
  onSave: (kit: KitPreset) => void
  onClose: () => void
}) {
  const [name, setName] = useState(initial.name)
  const [icon, setIcon] = useState(initial.icon)
  const [desc, setDesc] = useState(initial.desc)
  const [items, setItems] = useState<KitItem[]>(() => initial.items.map((it) => ({ ...it })))
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState<string>('全部')

  const filteredItems = useMemo(() => {
    let list = category === '全部' ? MINECRAFT_ITEMS : MINECRAFT_ITEMS.filter((i) => i.category === category)
    const query = search.trim().toLowerCase()
    if (query.length > 0) {
      list = list.filter(
        (i) =>
          i.name.toLowerCase().includes(query) ||
          i.id.toLowerCase().includes(query) ||
          fullItemId(i.id).toLowerCase().includes(query),
      )
    }
    return list
  }, [category, search])

  const addItem = (item: MinecraftItem) => {
    setItems((prev) => [...prev, { id: item.id, count: 1 }])
  }

  const setItemCount = (index: number, count: number) => {
    setItems((prev) =>
      prev.map((it, i) => (i === index ? { ...it, count: Math.min(MAX_COUNT, Math.max(1, count)) } : it)),
    )
  }

  const removeItem = (index: number) => {
    setItems((prev) => prev.filter((_, i) => i !== index))
  }

  const save = () => {
    const trimmedName = name.trim()
    if (trimmedName.length === 0) {
      toast.warning('请输入礼包名称')
      return
    }
    if (items.length === 0) {
      toast.warning('请至少添加一个物品')
      return
    }
    onSave({
      name: trimmedName,
      icon: icon.trim().length > 0 ? icon.trim() : '📦',
      desc: desc.trim(),
      items,
    })
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="glass-overlay max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isNew ? '新建礼包' : '编辑礼包'}</DialogTitle>
          <DialogDescription className="sr-only">
            {isNew ? '创建自定义物品礼包' : '编辑礼包内容'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {/* 名称 + 图标 */}
          <div className="flex items-start gap-3">
            <div className="flex w-16 shrink-0 flex-col gap-1">
              <span className="text-mcs-xs text-mcs-text-subtle">图标</span>
              <input
                value={icon}
                onChange={(e) => setIcon(e.target.value)}
                aria-label="礼包图标"
                maxLength={4}
                className="h-9 rounded-mcs-sm border border-mcs-border-default bg-mcs-bg-default text-center text-mcs-lg text-mcs-text-default focus:border-mcs-accent-border focus:outline-none focus:ring-1 focus:ring-mcs-focus-ring"
              />
            </div>
            <div className="min-w-0 flex-1">
              <span className="text-mcs-xs text-mcs-text-subtle">名称</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                aria-label="礼包名称"
                placeholder="如：新手起步包"
                maxLength={20}
                className="mt-1 h-9 w-full rounded-mcs-sm border border-mcs-border-default bg-mcs-bg-default px-2.5 text-mcs-sm text-mcs-text-default placeholder:text-mcs-text-subtle focus:border-mcs-accent-border focus:outline-none focus:ring-1 focus:ring-mcs-focus-ring"
              />
            </div>
          </div>

          {/* emoji 预设 */}
          <div className="flex flex-wrap gap-1">
            {KIT_ICON_PRESETS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => setIcon(emoji)}
                aria-label={`选择图标 ${emoji}`}
                aria-pressed={icon === emoji}
                className={cn(
                  'flex size-6 items-center justify-center rounded-mcs-xs text-mcs-sm transition-colors',
                  icon === emoji
                    ? 'border border-mcs-accent-border bg-mcs-accent-bg-subtle'
                    : 'border border-transparent bg-mcs-bg-muted hover:bg-mcs-bg-hover',
                )}
              >
                {emoji}
              </button>
            ))}
          </div>

          {/* 描述 */}
          <div className="flex flex-col gap-1">
            <span className="text-mcs-xs text-mcs-text-subtle">描述（可选）</span>
            <textarea
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              aria-label="礼包描述"
              placeholder="如：木镐+石剑+面包×16"
              rows={2}
              maxLength={60}
              className="resize-none rounded-mcs-sm border border-mcs-border-default bg-mcs-bg-default px-2.5 py-1.5 text-mcs-sm text-mcs-text-default placeholder:text-mcs-text-subtle focus:border-mcs-accent-border focus:outline-none focus:ring-1 focus:ring-mcs-focus-ring"
            />
          </div>

          {/* 当前物品 */}
          <div className="flex flex-col gap-1.5">
            <span className="text-mcs-xs font-medium text-mcs-text-default">
              当前物品（{items.length}）
            </span>
            {items.length === 0 ? (
              <p className="rounded-mcs-sm border border-dashed border-mcs-border-muted px-3 py-3 text-center text-mcs-xs text-mcs-text-subtle">
                未添加物品，请从下方选择
              </p>
            ) : (
              <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
                {items.map((entry, index) => {
                  const item = MINECRAFT_ITEMS.find((i) => i.id === entry.id)
                  return (
                    <div
                      key={`${entry.id}-${index}`}
                      className="flex w-[200px] shrink-0 items-center gap-1 rounded-mcs-sm border border-mcs-border-subtle bg-mcs-bg-muted py-1 pl-1 pr-1.5"
                    >
                      {item ? (
                        <img
                          src={itemImageUrl(item.id)}
                          alt={item.name}
                          width={22}
                          height={22}
                          draggable={false}
                          className="shrink-0 select-none"
                        />
                      ) : (
                        <span className="flex size-[22px] shrink-0 items-center justify-center rounded-mcs-xs bg-mcs-error-bg-subtle font-mono text-mcs-2xs text-mcs-error-fg">
                          ?
                        </span>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-mcs-xs text-mcs-text-default">
                          {item?.name ?? entry.id}
                        </div>
                        <div className="flex items-center">
                          <button
                            type="button"
                            onClick={() => setItemCount(index, entry.count - 1)}
                            aria-label={`减少 ${item?.name ?? entry.id} 数量`}
                            className="rounded-mcs-xs p-0.5 text-mcs-text-muted hover:bg-mcs-bg-hover hover:text-mcs-text-default"
                          >
                            <Minus className="size-3" aria-hidden />
                          </button>
                          <span className="w-7 text-center text-mcs-xs font-semibold tabular-nums text-mcs-accent-fg">
                            {entry.count}
                          </span>
                          <button
                            type="button"
                            onClick={() => setItemCount(index, entry.count + 1)}
                            aria-label={`增加 ${item?.name ?? entry.id} 数量`}
                            className="rounded-mcs-xs p-0.5 text-mcs-text-muted hover:bg-mcs-bg-hover hover:text-mcs-text-default"
                          >
                            <Plus className="size-3" aria-hidden />
                          </button>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeItem(index)}
                        aria-label={`移除 ${item?.name ?? entry.id}`}
                        className="shrink-0 rounded-mcs-xs p-0.5 text-mcs-text-subtle hover:bg-mcs-bg-hover hover:text-mcs-text-default"
                      >
                        <X className="size-3" aria-hidden />
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* 物品选择器 */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between">
              <span className="text-mcs-xs font-medium text-mcs-text-default">添加物品</span>
              <span className="text-mcs-2xs text-mcs-text-subtle">找到 {filteredItems.length} 个</span>
            </div>
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-mcs-text-subtle"
                aria-hidden
              />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索物品名称或 ID..."
                aria-label="搜索礼包物品"
                className="h-8 w-full rounded-mcs-sm border border-mcs-border-default bg-mcs-bg-default pl-8 pr-2.5 text-mcs-sm text-mcs-text-default placeholder:text-mcs-text-subtle focus:border-mcs-accent-border focus:outline-none focus:ring-1 focus:ring-mcs-focus-ring"
              />
            </div>
            <div className="flex gap-1 overflow-x-auto">
              {ITEM_CATEGORIES.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setCategory(cat)}
                  className={cn(
                    'shrink-0 rounded-full px-2 py-0.5 text-mcs-xs transition-colors',
                    category === cat
                      ? 'bg-mcs-accent-bg-subtle font-medium text-mcs-accent-fg'
                      : 'text-mcs-text-muted hover:bg-mcs-bg-hover hover:text-mcs-text-default',
                  )}
                >
                  {cat}
                </button>
              ))}
            </div>
            <div className="max-h-48 overflow-y-auto">
              {filteredItems.length === 0 ? (
                <p className="py-6 text-center text-mcs-xs text-mcs-text-subtle">
                  没有找到匹配的物品
                </p>
              ) : (
                <div className="grid grid-cols-6 gap-1" data-testid="kit-picker-grid">
                  {filteredItems.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => addItem(item)}
                      className="flex flex-col items-center gap-0.5 rounded-mcs-sm border border-mcs-border-subtle bg-mcs-bg-muted px-0.5 py-1 transition-colors hover:border-mcs-accent-border hover:bg-mcs-accent-bg-subtle"
                    >
                      <img
                        src={itemImageUrl(item.id)}
                        alt={item.name}
                        width={28}
                        height={28}
                        draggable={false}
                        className="select-none"
                      />
                      <span className="w-full truncate text-center text-mcs-2xs text-mcs-text-default">
                        {item.name}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <DialogFooter>
          <span className="mr-auto text-mcs-xs text-mcs-text-subtle">共 {items.length} 件物品</span>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={save}>{isNew ? '创建' : '保存'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
