/**
 * GiveItemPanel —— 给予物品工作台（目录 + 发放清单）
 *
 * 形态：容器 ≥760px 双栏（目录 + 清单），<760px 清单收成底部抽屉 + 购物车条。
 * 状态归属：清单/搜索词在 give-draft store（切 Tab 不丢、关详情才清），面板本身只管
 * 「哪一行展开哪个属性面板」「执行中」这类一次性的界面状态。
 */
import { useCallback, useState } from 'react'
import { Check, CloudOff, ShoppingCart } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'
import { EmptyState } from '@/components/mcs/empty-state'
import { ApiError } from '@/api/client'
import { getFriendlyErrorMessage } from '@/api/errors'
import { useContainerWidth } from '@/hooks/use-container-width'
import { MINECRAFT_ITEMS } from '@/lib/mc-items'
import { kitsFromPreferences, saveKits, type KitPreset } from '@/lib/mc-kits'
import { usePanelPreferencesStore } from '@/stores/panel-preferences'
import { formatBatchSummary, formatFailureDetails, runBatchForTargets } from '@/lib/mc-batch'
import { itemAvailabilityError, tryBuildGiveCommand, type GiveEntry } from '@/lib/mc-give'
import { pushRecentItemId, readRecentItemIds } from '@/lib/mc-give-recents'
import type { Player } from '@/api/types'
import type { PlayerActionRequest } from '../mutations'
import { useGiveDraftStore } from '../give-draft'
import { GiveCatalog } from './give-item-catalog'
import { GiveTicket } from './give-item-ticket'
import { KitEditorDialog, KitManagerDialog } from './give-item-kit-editor'

export interface GiveItemPanelProps {
  player: Player | null
  batchTargets: Player[]
  isBatchMode: boolean
  mcVersion: string
  isRconConnected: boolean
  onAction: (req: PlayerActionRequest) => Promise<void>
  onDone?: () => void
}

/**
 * 双栏最小容器宽：目录要 4 列（≥88px/格 ⇒ ≥400px）+ 清单 352px + 分隔线。
 * 低于它清单改底部抽屉——把两栏压成一条更挤的纵向流只会两边都不好用。
 */
const TWO_COLUMN_MIN_WIDTH = 760

const friendlyError = (err: unknown) =>
  err instanceof ApiError ? getFriendlyErrorMessage(err.code, err.message, err.details) : '网络错误'

export function GiveItemPanel({
  player,
  batchTargets,
  isBatchMode,
  mcVersion,
  isRconConnected,
  onAction,
  onDone,
}: GiveItemPanelProps) {
  const entries = useGiveDraftStore((s) => s.entries)
  const addItem = useGiveDraftStore((s) => s.addItem)
  const removeItem = useGiveDraftStore((s) => s.removeItem)
  const setCount = useGiveDraftStore((s) => s.setCount)
  const setEnchants = useGiveDraftStore((s) => s.setEnchants)
  const setPotion = useGiveDraftStore((s) => s.setPotion)
  const clearDraft = useGiveDraftStore((s) => s.clear)

  const [openPanel, setOpenPanel] = useState<{ id: string; kind: 'ench' | 'potion' } | null>(null)
  const [running, setRunning] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [confirmBatchOpen, setConfirmBatchOpen] = useState(false)
  const [kitManagerOpen, setKitManagerOpen] = useState(false)
  const [editing, setEditing] = useState<{ index: number | null; kit: KitPreset } | null>(null)
  const [deleteIndex, setDeleteIndex] = useState<number | null>(null)
  const [recentIds, setRecentIds] = useState<string[]>(() => readRecentItemIds())

  const [rootRef, containerWidth] = useContainerWidth<HTMLDivElement>()
  // 未测到宽（jsdom/首帧）按宽兜底：双栏是降级形态，不该在测量完成前闪出抽屉
  const twoColumn = containerWidth === null || containerWidth >= TWO_COLUMN_MIN_WIDTH

  // 礼包列表由偏好快照派生：删除/新增按当前最新列表整份覆盖，避免陈旧副本回写
  const kits = kitsFromPreferences(usePanelPreferencesStore((s) => s.remote))

  const previewName = player?.name ?? batchTargets[0]?.name ?? ''
  const targetCount = isBatchMode ? batchTargets.length : 1
  const totalCount = entries.reduce((sum, e) => sum + e.count, 0)

  // ── 清单操作 ──

  const togglePanel = useCallback((id: string, kind: 'ench' | 'potion') => {
    setOpenPanel((current) => (current?.id === id && current.kind === kind ? null : { id, kind }))
  }, [])

  const toggleEnchant = useCallback(
    (id: string, enchId: string) => {
      const entry = entries.find((e) => e.item.id === id)
      if (!entry) return
      const enchants = { ...entry.enchants }
      if (enchants[enchId] !== undefined) delete enchants[enchId]
      else enchants[enchId] = 1
      setEnchants(id, enchants)
    },
    [entries, setEnchants],
  )

  const setEnchantLevel = useCallback(
    (id: string, enchId: string, level: number) => {
      const entry = entries.find((e) => e.item.id === id)
      if (!entry) return
      setEnchants(id, { ...entry.enchants, [enchId]: level })
    },
    [entries, setEnchants],
  )

  const clearAll = () => {
    clearDraft()
    setOpenPanel(null)
  }

  // ── 礼包 ──

  const persistKits = async (next: KitPreset[]): Promise<boolean> => {
    try {
      await saveKits(next)
      return true
    } catch {
      return false
    }
  }

  const saveKit = async (draft: KitPreset, index: number | null) => {
    const next = [...kits]
    if (index === null) next.push(draft)
    else next[index] = draft
    const ok = await persistKits(next)
    if (ok) {
      toast.success(index === null ? `已添加礼包「${draft.name}」` : `已更新礼包「${draft.name}」`)
    } else toast.error('礼包保存失败，请重试')
    setEditing(null)
  }

  const doDeleteKit = async (index: number) => {
    const kit = kits[index]
    if (!kit) return
    const next = kits.filter((_, i) => i !== index)
    const ok = await persistKits(next)
    if (ok) toast.info(`已删除礼包「${kit.name}」`)
    else toast.error('礼包保存失败，请重试')
    setDeleteIndex(null)
  }

  const applyKit = (kit: KitPreset) => {
    // 礼包是跨实例的偏好快照：不在目录的 id、以及当前版本没有的物品都不能静默入单——
    // 用户点了礼包却少了东西，界面还报「已添加」是最差的一种反馈
    const missing: string[] = []
    const wrongVersion: string[] = []
    for (const ki of kit.items) {
      const item = MINECRAFT_ITEMS.find((i) => i.id === ki.id)
      if (!item) {
        missing.push(ki.id)
        continue
      }
      if (itemAvailabilityError(item, mcVersion) !== null) {
        wrongVersion.push(item.name)
        continue
      }
      addItem(item, Math.max(1, ki.count))
    }
    const skipped: string[] = []
    if (missing.length > 0)
      skipped.push(`${missing.length} 件物品不在目录中已跳过：${missing.join('、')}`)
    if (wrongVersion.length > 0) {
      skipped.push(
        `${wrongVersion.length} 件物品在 MC ${mcVersion} 不存在已跳过：${wrongVersion.join('、')}`,
      )
    }
    if (skipped.length > 0) {
      toast.warning(`已添加「${kit.name}」，但 ${skipped.join('；')}`)
      return
    }
    toast.success(`已添加「${kit.name}」到发放清单`)
  }

  // ── 执行链路 ──

  const requestGive = () => {
    if (entries.length === 0 || running) return
    if (isBatchMode && batchTargets.some((t) => t.isOnline)) {
      setDrawerOpen(false)
      setConfirmBatchOpen(true)
      return
    }
    void runGive()
  }

  /** 单条命令（失败由调用方按条处理） */
  const buildCommand = (entry: GiveEntry, name: string): string | null => {
    const result = tryBuildGiveCommand({
      playerName: name,
      item: entry.item,
      count: entry.count,
      enchants: entry.enchants,
      potion: entry.potion,
      mcVersion,
    })
    if (!result.ok) {
      toast.error(`${entry.item.name} 无法生成命令：${result.error}`)
      return null
    }
    return result.command
  }

  const rememberGiven = () => {
    let next = recentIds
    for (const entry of entries) next = pushRecentItemId(entry.item.id, next)
    setRecentIds(next)
  }

  const runGive = async () => {
    setRunning(true)
    try {
      if (isBatchMode) {
        const result = await runBatchForTargets({
          targets: batchTargets.map((p) => ({ name: p.name, isOnline: p.isOnline })),
          requireOnline: true,
          execute: async (t) => {
            for (const e of entries) {
              const command = buildCommand(e, t.name)
              if (command === null) throw new Error('命令生成失败')
              await onAction({ kind: 'command', command })
            }
          },
        })
        const summary = formatBatchSummary('给予', result)
        const details = formatFailureDetails(result)
        if (result.allOffline || result.failCount > 0) {
          toast.warning(summary, { description: details })
        } else {
          toast.success(summary)
          rememberGiven()
          clearAll()
        }
      } else {
        const target = player ?? batchTargets[0]
        if (!target) return
        let ok = 0
        for (const e of entries) {
          const command = buildCommand(e, target.name)
          if (command === null) continue
          try {
            await onAction({ kind: 'command', command })
            ok++
          } catch (err) {
            toast.error(`${e.item.name} 给予失败：${friendlyError(err)}`)
          }
        }
        if (ok > 0) toast.success(`已给予 ${target.name} ${ok} 种物品`)
        // 全部成功才收口：有失败时保留清单，用户可直接重试
        if (ok === entries.length) {
          rememberGiven()
          clearAll()
        }
      }
    } finally {
      setRunning(false)
      setDrawerOpen(false)
      onDone?.()
    }
  }

  // 单模式离线拦截：与传送 Tab 离线空态统一走 EmptyState
  if (!isBatchMode && player && !player.isOnline) {
    return (
      <EmptyState icon={CloudOff} title="玩家已离线，无法给予物品" hint="给予物品需要玩家在线" />
    )
  }

  const ticket = (
    <GiveTicket
      entries={entries}
      playerName={previewName}
      batchMode={isBatchMode}
      targetCount={targetCount}
      mcVersion={mcVersion}
      isRconConnected={isRconConnected}
      running={running}
      openPanelId={openPanel?.id ?? null}
      openPanelKind={openPanel?.kind ?? null}
      kits={kits}
      onTogglePanel={togglePanel}
      onSetCount={setCount}
      onToggleEnchant={toggleEnchant}
      onSetEnchantLevel={setEnchantLevel}
      onSetPotion={setPotion}
      onRemove={removeItem}
      onClear={clearAll}
      onApplyKit={applyKit}
      onGive={requestGive}
      onCloseDrawer={twoColumn ? undefined : () => setDrawerOpen(false)}
    />
  )

  return (
    <div ref={rootRef} className="@container relative flex min-h-0 flex-1 flex-col">
      {twoColumn ? (
        <div
          className="grid min-h-0 flex-1"
          style={{ gridTemplateColumns: 'minmax(0, 1fr) 352px' }}
        >
          <GiveCatalog
            mcVersion={mcVersion}
            kits={kits}
            recentIds={recentIds}
            onManageKits={() => setKitManagerOpen(true)}
            onApplyKit={applyKit}
          />
          {ticket}
        </div>
      ) : (
        <>
          <GiveCatalog
            mcVersion={mcVersion}
            kits={kits}
            recentIds={recentIds}
            onManageKits={() => setKitManagerOpen(true)}
            onApplyKit={applyKit}
          />
          {/* 购物车条：窄容器下清单的常驻入口 */}
          <div className="flex shrink-0 items-center gap-2 border-t border-mcs-border-muted bg-mcs-bg-muted px-3 py-2">
            <span className="flex min-w-0 items-center gap-1.5 text-mcs-xs text-mcs-text-muted">
              <ShoppingCart className="size-3.5 shrink-0" aria-hidden />
              {entries.length > 0 ? (
                <>
                  <strong className="font-semibold text-mcs-text-default">{entries.length}</strong>{' '}
                  种 · {totalCount} 个
                </>
              ) : (
                '清单为空'
              )}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              disabled={entries.length === 0}
              onClick={() => setDrawerOpen(true)}
            >
              查看清单
            </Button>
            <Button size="sm" disabled={entries.length === 0 || running} onClick={requestGive}>
              <Check aria-hidden />
              {running ? '执行中…' : '给予'}
            </Button>
          </div>
          {drawerOpen && (
            <Sheet
              open
              onOpenChange={(next) => {
                if (!next) setDrawerOpen(false)
              }}
            >
              <SheetContent
                side="bottom"
                showCloseButton={false}
                className="max-h-[88dvh] gap-0 rounded-t-mcs-lg p-0"
              >
                <SheetTitle className="sr-only">发放清单</SheetTitle>
                {ticket}
              </SheetContent>
            </Sheet>
          )}
        </>
      )}

      {kitManagerOpen && (
        <KitManagerDialog
          kits={kits}
          onApply={(kit) => {
            applyKit(kit)
            setKitManagerOpen(false)
          }}
          onEdit={(index, kit) => setEditing({ index, kit })}
          onDelete={(index) => setDeleteIndex(index)}
          onNew={() =>
            setEditing({ index: null, kit: { name: '', icon: '📦', desc: '', items: [] } })
          }
          onClose={() => setKitManagerOpen(false)}
        />
      )}
      {editing !== null && (
        <KitEditorDialog
          initial={editing.kit}
          isNew={editing.index === null}
          onSave={(draft) => void saveKit(draft, editing.index)}
          onClose={() => setEditing(null)}
        />
      )}
      <ConfirmDialog
        open={confirmBatchOpen}
        onOpenChange={(o) => {
          if (!o) setConfirmBatchOpen(false)
        }}
        title="确认批量给予"
        description={`将向 ${batchTargets.filter((t) => t.isOnline).length} 名在线玩家给予 ${entries.length} 种物品（共 ${entries.length * batchTargets.filter((t) => t.isOnline).length} 条命令）`}
        confirmText="确认给予"
        warning="批量执行将逐条发送命令，且无法撤销"
        onConfirm={() => {
          setConfirmBatchOpen(false)
          void runGive()
        }}
      />
      <ConfirmDialog
        open={deleteIndex !== null}
        onOpenChange={(o) => {
          if (!o) setDeleteIndex(null)
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
          if (deleteIndex !== null) void doDeleteKit(deleteIndex)
        }}
      />
    </div>
  )
}
