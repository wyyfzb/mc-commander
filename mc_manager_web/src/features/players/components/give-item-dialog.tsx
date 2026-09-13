/**
 * GiveItemPanel —— 给予物品面板（embedded 内嵌模式；弹窗模式由调用方用 Dialog 包裹本组件）。
 * 拆分为 5 个子组件后，本文件仅保留状态管理 + 子组件编排 + 执行链路。
 */
import { useCallback, useMemo, useState } from 'react'
import { CloudOff } from 'lucide-react'
import { toast } from 'sonner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'
import { EmptyState } from '@/components/mcs/empty-state'
import { ApiError } from '@/api/client'
import { getFriendlyErrorMessage } from '@/api/errors'
import { MINECRAFT_ITEMS, type MinecraftItem } from '@/lib/mc-items'
import { MINECRAFT_POTIONS, POTION_BOTTLE_TYPES, durationsForLevel, type PotionConfig } from '@/lib/mc-potions'
import { buildGiveCommand, type Enchantment } from '@/lib/mc-enchantments'
import { loadKitsFromStorage, saveKitsToStorage, type KitPreset } from '@/lib/mc-kits'
import { formatBatchSummary, formatFailureDetails, runBatchForTargets } from '@/lib/mc-batch'
import type { Player } from '@/api/types'
import type { PlayerActionRequest } from '../mutations'
import { ItemSelector } from './give-item-selector'
import { EnchantPanel, type SelectedEntry } from './give-item-enchant-editor'
import { PotionPanel } from './give-item-potion-editor'
import { SelectedItemsBar, CommandPreview, FooterSummary } from './give-item-preview-bar'
import { KitTab, KitEditorDialog } from './give-item-kit-editor'

export interface GiveItemPanelProps {
  player: Player | null
  batchTargets: Player[]
  isBatchMode: boolean
  instanceId: string
  mcVersion: string
  isRconConnected: boolean
  onAction: (req: PlayerActionRequest) => Promise<void>
  onDone?: () => void
}

const MAX_COUNT = 6400
const friendlyError = (err: unknown) =>
  err instanceof ApiError ? getFriendlyErrorMessage(err.code, err.message) : '网络错误'

export function GiveItemPanel({
  player, batchTargets, isBatchMode, mcVersion, isRconConnected, onAction, onDone,
}: GiveItemPanelProps) {
  const [mainTab, setMainTab] = useState<'items' | 'kits'>('items')
  const [search, setSearch] = useState('')
  const [activeCategory, setActiveCategory] = useState('全部')
  const [selected, setSelected] = useState<Map<string, SelectedEntry>>(() => new Map())
  const [expandedEnchantId, setExpandedEnchantId] = useState<string | null>(null)
  const [expandedPotionId, setExpandedPotionId] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [kits, setKits] = useState<KitPreset[]>(() => loadKitsFromStorage(window.localStorage))
  const [editing, setEditing] = useState<{ index: number | null; kit: KitPreset } | null>(null)
  const [deleteIndex, setDeleteIndex] = useState<number | null>(null)
  const [confirmBatchOpen, setConfirmBatchOpen] = useState(false)

  const entries = useMemo(() => [...selected.values()], [selected])
  const previewName = player?.name ?? batchTargets[0]?.name ?? ''
  /** 构建 give 命令（统一参数缩减重复） */
  const cmd = (e: SelectedEntry, name: string) =>
    buildGiveCommand({ playerName: name, item: e.item, count: e.count, enchants: e.enchants, potion: e.potion, mcVersion })

  // ── 选中列表操作 ──

  const toggleItem = useCallback((item: MinecraftItem) => {
    const id = item.id
    setSelected((prev) => {
      const next = new Map(prev)
      if (prev.has(id)) {
        next.delete(id)
        setExpandedEnchantId((c) => (c === id ? null : c))
        setExpandedPotionId((c) => (c === id ? null : c))
      } else {
        const effect = MINECRAFT_POTIONS.find((e) => e.effectId === id)
        const entry: SelectedEntry = { item, count: 1, enchants: {}, potion: null }
        if (effect) {
          const dur = durationsForLevel(effect, 1)
          entry.potion = { effect, bottle: POTION_BOTTLE_TYPES[0]!, level: 1, duration: dur.length > 0 ? dur[0]!.ticks : 1 }
        }
        next.set(id, entry)
      }
      return next
    })
  }, [])

  const setItemCount = (id: string, count: number) => {
    const next = new Map(selected)
    const cur = next.get(id)
    if (!cur) return
    if (count < 1) {
      next.delete(id)
      if (expandedEnchantId === id) setExpandedEnchantId(null)
      if (expandedPotionId === id) setExpandedPotionId(null)
    } else next.set(id, { ...cur, count: Math.min(MAX_COUNT, count) })
    setSelected(next)
  }

  const clearSelected = () => { setSelected(new Map()); setExpandedEnchantId(null); setExpandedPotionId(null) }
  const toggleEnchantPanel = (id: string) => { setExpandedEnchantId((c) => (c === id ? null : id)); setExpandedPotionId(null) }
  const togglePotionPanel = (id: string) => { setExpandedPotionId((c) => (c === id ? null : id)); setExpandedEnchantId(null) }

  const toggleEnchant = (id: string, ench: Enchantment) => setSelected((prev) => {
    const cur = prev.get(id); if (!cur) return prev
    const e = { ...cur.enchants }; if (e[ench.id] !== undefined) { delete e[ench.id] } else { e[ench.id] = 1 }
    return new Map(prev).set(id, { ...cur, enchants: e })
  })

  const setEnchantLevel = (id: string, eid: string, lv: number) => setSelected((prev) => {
    const cur = prev.get(id); if (!cur) return prev
    return new Map(prev).set(id, { ...cur, enchants: { ...cur.enchants, [eid]: lv } })
  })

  const setPotionBottle = (id: string, b: PotionConfig['bottle']) => setSelected((prev) => {
    const cur = prev.get(id); if (!cur?.potion) return prev
    return new Map(prev).set(id, { ...cur, potion: { ...cur.potion, bottle: b } })
  })

  const setPotionLevel = (id: string, lv: number) => setSelected((prev) => {
    const cur = prev.get(id); if (!cur?.potion) return prev
    const dur = durationsForLevel(cur.potion.effect, lv)
    return new Map(prev).set(id, { ...cur, potion: { ...cur.potion, level: lv, duration: dur.length > 0 ? dur[0]!.ticks : 1 } })
  })

  const setPotionDuration = (id: string, d: number) => setSelected((prev) => {
    const cur = prev.get(id); if (!cur?.potion) return prev
    return new Map(prev).set(id, { ...cur, potion: { ...cur.potion, duration: d } })
  })

  // ── 礼包操作 ──

  const persistKits = (next: KitPreset[]) => { try { saveKitsToStorage(window.localStorage, next); return true } catch { return false } }

  const saveKit = (draft: KitPreset, index: number | null) => {
    const next = [...kits]
    if (index === null) { next.push(draft) } else { next[index] = draft }
    const ok = persistKits(next)
    if (ok) {
      setKits(next)
      toast.success(index === null ? `已添加礼包「${draft.name}」` : `已更新礼包「${draft.name}」`)
    } else toast.error('礼包保存失败，请重试')
    setEditing(null)
  }

  const doDeleteKit = (index: number) => {
    const kit = kits[index]; if (!kit) return
    const next = kits.filter((_, i) => i !== index); const ok = persistKits(next)
    if (ok) { setKits(next); toast.info(`已删除礼包「${kit.name}」`) } else toast.error('礼包保存失败，请重试')
    setDeleteIndex(null)
  }

  const applyKit = (kit: KitPreset) => {
    const next = new Map(selected)
    for (const ki of kit.items) {
      const item = MINECRAFT_ITEMS.find((i) => i.id === ki.id); if (!item) continue
      const cur = next.get(item.id)
      if (cur) next.set(item.id, { ...cur, count: Math.min(MAX_COUNT, cur.count + ki.count) })
      else next.set(item.id, { item, count: Math.min(MAX_COUNT, Math.max(1, ki.count)), enchants: {}, potion: null })
    }
    setSelected(next); setMainTab('items'); toast.success(`已添加「${kit.name}」到已选列表`)
  }

  // ── 执行链路 ──

  const requestGive = () => {
    if (entries.length === 0 || running) return
    const hasEnchanted = entries.some((e) => Object.keys(e.enchants).length > 0)
    const hasPotion = entries.some((e) => e.potion !== null)
    if ((hasEnchanted || hasPotion) && !isRconConnected) {
      toast.error(hasPotion ? '附魔/药水物品给予需启用 RCON，请检查实例 RCON 配置' : '附魔物品给予需启用 RCON，请检查实例 RCON 配置')
      return
    }
    if (isBatchMode && batchTargets.some((t) => t.isOnline)) { setConfirmBatchOpen(true); return }
    void runGive()
  }

  const runGive = async () => {
    setRunning(true)
    try {
      if (isBatchMode) {
        const result = await runBatchForTargets({
          targets: batchTargets.map((p) => ({ name: p.name, isOnline: p.isOnline })), requireOnline: true,
          execute: async (t) => { for (const e of entries) await onAction({ kind: 'command', command: cmd(e, t.name) }) },
        })
        const s = formatBatchSummary('给予', result), d = formatFailureDetails(result)
        if (result.allOffline || result.failCount > 0) { toast.warning(s, { description: d }) } else { toast.success(s) }
      } else {
        const target = player ?? batchTargets[0]; if (!target) return
        let ok = 0
        for (const e of entries) { try { await onAction({ kind: 'command', command: cmd(e, target.name) }); ok++ } catch (err) { toast.error(`${e.item.name} 给予失败：${friendlyError(err)}`) } }
        if (ok > 0) toast.success(`已给予 ${target.name} ${ok} 种物品`)
      }
    } finally { setRunning(false); onDone?.() }
  }

  const handleCategoryChange = (cat: string) => { setActiveCategory(cat); setExpandedEnchantId(null); setExpandedPotionId(null) }

  // 单模式离线拦截：与传送 Tab 离线空态统一走 EmptyState
  if (!isBatchMode && player && !player.isOnline) return (
    <EmptyState
      icon={CloudOff}
      title="玩家已离线，无法给予物品"
      hint="给予物品需要玩家在线"
    />
  )

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <Tabs value={mainTab} onValueChange={(v) => setMainTab(v as 'items' | 'kits')} className="flex min-h-0 flex-1 flex-col">
        <TabsList variant="line" className="h-8 w-full justify-start gap-0 border-b border-mcs-border-muted p-0">
          <TabsTrigger value="items" className="h-8 px-3 text-mcs-xs after:bg-mcs-accent">物品选择</TabsTrigger>
          <TabsTrigger value="kits" className="h-8 px-3 text-mcs-xs after:bg-mcs-accent">预设礼包</TabsTrigger>
        </TabsList>
        <TabsContent value="items" className="flex min-h-0 flex-1 flex-col gap-2">
          <ItemSelector search={search} onSearchChange={setSearch} activeCategory={activeCategory}
            onCategoryChangeWithPanelReset={handleCategoryChange} selected={selected} onToggle={toggleItem} />
          <SelectedItemsBar entries={entries} expandedEnchantId={expandedEnchantId} expandedPotionId={expandedPotionId}
            onSetItemCount={setItemCount} onToggleEnchantPanel={toggleEnchantPanel} onTogglePotionPanel={togglePotionPanel}
            onToggleItem={toggleItem} onClear={clearSelected} />
          {expandedEnchantId !== null && selected.has(expandedEnchantId) && (
            <EnchantPanel entry={selected.get(expandedEnchantId)!} playerName={previewName} mcVersion={mcVersion}
              onToggle={(ench) => toggleEnchant(expandedEnchantId, ench)}
              onSetLevel={(eid, lv) => setEnchantLevel(expandedEnchantId, eid, lv)} onClose={() => setExpandedEnchantId(null)} />)}
          {expandedPotionId !== null && selected.has(expandedPotionId) && (
            <PotionPanel entry={selected.get(expandedPotionId)!} playerName={previewName} mcVersion={mcVersion}
              onSetBottle={(b) => setPotionBottle(expandedPotionId, b)} onSetLevel={(l) => setPotionLevel(expandedPotionId, l)}
              onSetDuration={(d) => setPotionDuration(expandedPotionId, d)} onClose={() => setExpandedPotionId(null)} />)}
        </TabsContent>
        <TabsContent value="kits" className="min-h-0 flex-1 overflow-y-auto">
          <KitTab kits={kits} onApply={applyKit}
            onEdit={(i, k) => setEditing({ index: i, kit: k })} onDelete={(i) => setDeleteIndex(i)}
            onNew={() => setEditing({ index: null, kit: { name: '', icon: '📦', desc: '', items: [] } })} />
        </TabsContent>
      </Tabs>
      {entries.length > 0 && (
        <div className="flex flex-col gap-1" data-testid="command-previews">
          {entries.map((e) => (expandedEnchantId === e.item.id || expandedPotionId === e.item.id) ? null
            : <CommandPreview key={e.item.id} command={cmd(e, previewName)} />)}
        </div>)}
      <FooterSummary entries={entries} running={running} onGive={requestGive} />
      {editing !== null && <KitEditorDialog initial={editing.kit} isNew={editing.index === null}
        onSave={(draft) => saveKit(draft, editing.index)} onClose={() => setEditing(null)} />}
      <ConfirmDialog open={confirmBatchOpen} onOpenChange={(o) => { if (!o) setConfirmBatchOpen(false) }}
        title="确认批量给予"
        description={`将向 ${batchTargets.filter((t) => t.isOnline).length} 名在线玩家给予 ${entries.length} 种物品（共 ${entries.length * batchTargets.filter((t) => t.isOnline).length} 条命令）`}
        confirmText="确认给予" warning="批量执行将逐条发送命令，且无法撤销"
        onConfirm={() => { setConfirmBatchOpen(false); void runGive() }} />
      <ConfirmDialog open={deleteIndex !== null} onOpenChange={(o) => { if (!o) setDeleteIndex(null) }}
        title="删除礼包"
        description={deleteIndex !== null ? `确定要删除「${kits[deleteIndex]?.name ?? ''}」吗？此操作不可撤销。` : ''}
        confirmText="删除" danger onConfirm={() => { if (deleteIndex !== null) doDeleteKit(deleteIndex) }} />
    </div>
  )
}
