/**
 * 发放清单（工作台右栏）——行式清单 + 行内属性 + 折叠命令 + 发放按钮
 *
 * 每一项只占一行（缩略图 / 名称与属性摘要 / 数量步进器 / 属性入口 / 移除），属性编辑就地
 * 展开在该行下方。命令是结果不是内容：默认只留一条可见，其余折进「等 N 条」，不与清单
 * 争夺纵向空间。
 */
import { useState } from 'react'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Copy,
  FlaskConical,
  Minus,
  Package,
  Plus,
  Terminal,
  Wand2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { NoticeBanner } from '@/components/mcs/notice-banner'
import { cn } from '@/lib/utils'
import { copyText } from '@/lib/clipboard'
import { getEnchantmentsForItem, isEnchantmentDisabledBy, toRoman } from '@/lib/mc-enchantments'
import {
  POTION_BOTTLE_TYPES,
  POTION_LEVEL_ROMAN,
  POTION_MAX_LEVEL,
  durationsForLevel,
} from '@/lib/mc-potions'
import {
  giveEntryBlockReason,
  summarizeGiveEntry,
  tryBuildGiveCommand,
  type GiveEntry,
} from '@/lib/mc-give'
import type { KitPreset } from '@/lib/mc-kits'
import { ItemThumb, effectColorHex } from './give-item-catalog'
import { EnchantToggle } from './give-item-enchant-toggle'

/** 快速数量档 */
const QUICK_COUNTS = [1, 16, 64, 256, 640, 6400]

/** 清单行内的数量步进器（− 输入 + 快速档） */
function CountStepper({
  entry,
  onSetCount,
}: {
  entry: GiveEntry
  onSetCount: (count: number) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? String(entry.count)
  const commit = (raw: string) => {
    const value = Number(raw)
    setDraft(null)
    if (!Number.isFinite(value) || raw.trim() === '') return
    onSetCount(Math.floor(value))
  }
  return (
    /* 步进器高 24px（h-6）：WCAG 2.2 SC 2.5.8 的指针目标下限。三个按钮各占 24px 宽
       （w-6），不再用 w-5/w-4——20px 与 16px 的按钮在触摸屏上点不中，且它们是本界面
       最高频的操作。 */
    <span className="inline-flex h-6 shrink-0 items-center overflow-hidden rounded-mcs-xs border border-mcs-border-muted bg-mcs-bg-default">
      <button
        type="button"
        onClick={() => onSetCount(entry.count - 1)}
        aria-label={`减少 ${entry.item.name} 数量`}
        className="flex h-full w-6 items-center justify-center text-mcs-text-muted hover:bg-mcs-state-hover hover:text-mcs-text-default"
      >
        <Minus className="size-3" aria-hidden />
      </button>
      <input
        type="number"
        min={1}
        max={6400}
        value={shown}
        aria-label={`${entry.item.name} 数量`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit(e.currentTarget.value)
            e.currentTarget.blur()
          }
        }}
        className="h-full w-9 border-0 bg-transparent p-0 text-center font-mono text-mcs-xs font-semibold text-mcs-accent-fg tabular-nums [appearance:textfield] focus-visible:ring-1 focus-visible:ring-mcs-focus-ring focus-visible:outline-2 focus-visible:outline-mcs-focus-ring focus-visible:-outline-offset-2 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <button
        type="button"
        onClick={() => onSetCount(entry.count + 1)}
        aria-label={`增加 ${entry.item.name} 数量`}
        className="flex h-full w-6 items-center justify-center text-mcs-text-muted hover:bg-mcs-state-hover hover:text-mcs-text-default"
      >
        <Plus className="size-3" aria-hidden />
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`${entry.item.name} 快速数量`}
            className="flex h-full w-6 items-center justify-center border-l border-mcs-border-muted text-mcs-text-muted hover:bg-mcs-state-hover hover:text-mcs-text-default"
          >
            <ChevronDown className="size-3" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {QUICK_COUNTS.map((n) => (
            <DropdownMenuItem key={n} onClick={() => onSetCount(n)}>
              {n}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  )
}

/** 附魔配置（就地展开在该行下方） */
function EnchantBody({
  entry,
  onToggle,
  onSetLevel,
}: {
  entry: GiveEntry
  onToggle: (enchId: string) => void
  onSetLevel: (enchId: string, level: number) => void
}) {
  const available = getEnchantmentsForItem(entry.item)
  const selectedIds = Object.keys(entry.enchants)
  return (
    <div className="rounded-mcs-sm border border-mcs-purple-border bg-mcs-purple-bg-subtle p-2">
      <div className="mb-1.5 flex items-center gap-1.5">
        <Wand2 className="size-3.5 shrink-0 text-mcs-purple-fg" aria-hidden />
        <span className="truncate text-mcs-xs font-semibold text-mcs-purple-fg">
          附魔 · {entry.item.name}
        </span>
        <span className="shrink-0 font-mono text-mcs-2xs text-mcs-text-muted">
          {available.length} 种可用
        </span>
      </div>
      <div className="grid max-h-[168px] grid-cols-1 gap-x-1.5 gap-y-0.5 overflow-y-auto border-t border-mcs-purple-border pt-1 @[300px]:grid-cols-2">
        {available.map((ench) => {
          const isOn = entry.enchants[ench.id] !== undefined
          const isDisabled = !isOn && isEnchantmentDisabledBy(ench.id, selectedIds)
          return (
            <div
              key={ench.id}
              className={cn(
                'flex h-6 min-w-0 items-center gap-1.5 rounded-mcs-xs px-1',
                isDisabled && 'opacity-35',
              )}
            >
              <EnchantToggle
                label={`${ench.name} 附魔开关`}
                on={isOn}
                disabled={isDisabled}
                onToggle={() => onToggle(ench.id)}
              />
              <span
                className={cn(
                  'min-w-0 flex-1 truncate text-mcs-xs',
                  isOn ? 'font-medium text-mcs-purple-fg' : 'text-mcs-text-default',
                )}
              >
                {ench.name}
              </span>
              <span className="shrink-0 font-mono text-mcs-2xs text-mcs-text-muted">
                I-{toRoman(ench.maxLevel)}
              </span>
              {isOn && ench.maxLevel > 1 ? (
                <Select
                  value={String(entry.enchants[ench.id] ?? 1)}
                  onValueChange={(v) => onSetLevel(ench.id, Number(v))}
                >
                  <SelectTrigger size="sm" aria-label={`${ench.name} 等级`} className="h-5 w-12">
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
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** 药水配置（就地展开在该行下方） */
function PotionBody({
  entry,
  onSet,
}: {
  entry: GiveEntry
  onSet: (potion: NonNullable<GiveEntry['potion']>) => void
}) {
  const potion = entry.potion
  if (!potion) return null
  const effect = potion.effect
  const durations = durationsForLevel(effect, potion.level)
  const color = effectColorHex(effect)
  return (
    <div
      className="rounded-mcs-sm border p-2"
      style={{
        borderColor: `color-mix(in srgb, ${color} 30%, transparent)`,
        backgroundColor: `color-mix(in srgb, ${color} 10%, var(--mcs-bg-default))`,
      }}
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        <span
          data-testid="potion-panel-dot"
          className="size-3.5 shrink-0 rounded-mcs-xs"
          style={{ backgroundColor: color }}
        />
        {/* 数据色只作色点/描边：MC 药水色作文字时亮暗各有约半数不达 4.5:1 */}
        <span className="truncate text-mcs-xs font-semibold text-mcs-text-default">
          药水 · {effect.name}
        </span>
        <span className="shrink-0 text-mcs-2xs text-mcs-text-muted">
          等级{' '}
          {potion.level > effect.vanillaMaxLevel
            ? `${POTION_LEVEL_ROMAN[potion.level - 1]}（自定义）`
            : POTION_LEVEL_ROMAN[potion.level - 1]}
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <span className="w-8 shrink-0 text-mcs-2xs text-mcs-text-muted">瓶型</span>
          <Select
            value={potion.bottle.itemId}
            onValueChange={(v) => {
              const bottle = POTION_BOTTLE_TYPES.find((b) => b.itemId === v)
              if (bottle) onSet({ ...potion, bottle })
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
          <span className="w-8 shrink-0 text-mcs-2xs text-mcs-text-muted">等级</span>
          <Select
            value={String(potion.level)}
            onValueChange={(v) => {
              const level = Number(v)
              const nextDurations = durationsForLevel(effect, level)
              onSet({ ...potion, level, duration: nextDurations[0]?.ticks ?? 1 })
            }}
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
            <span className="w-8 shrink-0 text-mcs-2xs text-mcs-text-muted">时长</span>
            <Select
              value={String(potion.duration)}
              onValueChange={(v) => onSet({ ...potion, duration: Number(v) })}
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
          <p className="text-mcs-xs text-mcs-text-muted">
            <FlaskConical className="mr-1 inline size-3 align-[-2px]" aria-hidden />
            瞬时效果（duration=1tick），饮用即刻生效
          </p>
        )}
      </div>
    </div>
  )
}

/** 单行（属性就地展开在该行下方） */
function TicketRow({
  entry,
  openPanel,
  onTogglePanel,
  onSetCount,
  onToggleEnchant,
  onSetEnchantLevel,
  onSetPotion,
  onRemove,
}: {
  entry: GiveEntry
  openPanel: 'ench' | 'potion' | null
  onTogglePanel: (kind: 'ench' | 'potion') => void
  onSetCount: (count: number) => void
  onToggleEnchant: (enchId: string) => void
  onSetEnchantLevel: (enchId: string, level: number) => void
  onSetPotion: (potion: NonNullable<GiveEntry['potion']>) => void
  onRemove: () => void
}) {
  const canEnchant = getEnchantmentsForItem(entry.item).length > 0
  const effect = entry.potion?.effect ?? null
  const summary = summarizeGiveEntry(entry)
  return (
    <li className="border-b border-mcs-border-subtle" data-testid={`give-line-${entry.item.id}`}>
      <div className="flex items-center gap-2 px-2.5 py-2 hover:bg-mcs-state-hover">
        <span className="flex size-7 shrink-0 items-center justify-center">
          <ItemThumb item={entry.item} size={28} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col justify-center">
          <span className="truncate text-mcs-xs font-medium text-mcs-text-default">
            {entry.item.name}
          </span>
          <span
            className={cn(
              'truncate text-mcs-2xs',
              Object.keys(entry.enchants).length > 0 ? 'text-mcs-purple-fg' : 'text-mcs-text-muted',
            )}
          >
            {summary || '无附加属性'}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-0.5">
          <CountStepper entry={entry} onSetCount={onSetCount} />
          {canEnchant ? (
            <button
              type="button"
              onClick={() => onTogglePanel('ench')}
              aria-expanded={openPanel === 'ench'}
              aria-label={`${entry.item.name} 附魔设置`}
              className={cn(
                'flex size-6 items-center justify-center rounded-mcs-xs',
                openPanel === 'ench'
                  ? 'bg-mcs-purple-bg-subtle text-mcs-purple-fg'
                  : 'text-mcs-text-muted hover:bg-mcs-state-hover hover:text-mcs-text-default',
              )}
            >
              <Wand2 className="size-3.5" aria-hidden />
            </button>
          ) : effect ? (
            <button
              type="button"
              onClick={() => onTogglePanel('potion')}
              aria-expanded={openPanel === 'potion'}
              aria-label={`${entry.item.name} 药水配置`}
              className={cn(
                'flex size-6 items-center justify-center rounded-mcs-xs',
                openPanel === 'potion'
                  ? 'bg-mcs-bg-secondary text-mcs-text-default'
                  : 'text-mcs-text-muted hover:bg-mcs-state-hover hover:text-mcs-text-default',
              )}
              style={{ color: openPanel === 'potion' ? effectColorHex(effect) : undefined }}
            >
              <FlaskConical className="size-3.5" aria-hidden />
            </button>
          ) : null}
          <button
            type="button"
            onClick={onRemove}
            aria-label={`移除 ${entry.item.name}`}
            className="flex size-6 items-center justify-center rounded-mcs-xs text-mcs-text-muted hover:bg-mcs-state-hover hover:text-mcs-error-fg"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </span>
      </div>
      {openPanel === 'ench' && (
        <div className="px-2.5 pb-2.5">
          <EnchantBody entry={entry} onToggle={onToggleEnchant} onSetLevel={onSetEnchantLevel} />
        </div>
      )}
      {openPanel === 'potion' && entry.potion !== null && (
        <div className="px-2.5 pb-2.5">
          <PotionBody entry={entry} onSet={onSetPotion} />
        </div>
      )}
    </li>
  )
}

export interface GiveTicketProps {
  entries: GiveEntry[]
  playerName: string
  /** 批量模式（决定 CTA 文案：批量必须显式写人数，避免「以为是给一个人」） */
  batchMode: boolean
  /** 批量模式的人头数（单人为 1） */
  targetCount: number
  mcVersion: string
  isRconConnected: boolean
  running: boolean
  openPanelId: string | null
  openPanelKind: 'ench' | 'potion' | null
  kits: KitPreset[]
  onTogglePanel: (id: string, kind: 'ench' | 'potion') => void
  onSetCount: (id: string, count: number) => void
  onToggleEnchant: (id: string, enchId: string) => void
  onSetEnchantLevel: (id: string, enchId: string, level: number) => void
  onSetPotion: (id: string, potion: NonNullable<GiveEntry['potion']>) => void
  onRemove: (id: string) => void
  onClear: () => void
  onApplyKit: (kit: KitPreset) => void
  onGive: () => void
  /** 窄容器下的底部抽屉关闭（宽容器不需要） */
  onCloseDrawer?: () => void
}

/** 清单：头 + 目标 + 行列表 + 底部（命令/告警/CTA） */
export function GiveTicket({
  entries,
  playerName,
  batchMode,
  targetCount,
  mcVersion,
  isRconConnected,
  running,
  openPanelId,
  openPanelKind,
  kits,
  onTogglePanel,
  onSetCount,
  onToggleEnchant,
  onSetEnchantLevel,
  onSetPotion,
  onRemove,
  onClear,
  onApplyKit,
  onGive,
  onCloseDrawer,
}: GiveTicketProps) {
  const [showAllCommands, setShowAllCommands] = useState(false)

  const commands = entries.map((e) =>
    tryBuildGiveCommand({
      playerName,
      item: e.item,
      count: e.count,
      enchants: e.enchants,
      potion: e.potion,
      mcVersion,
    }),
  )
  const blocked = entries
    .map((e) => ({ entry: e, reason: giveEntryBlockReason(e, mcVersion) }))
    .filter((b) => b.reason !== null)
  const totalCount = entries.reduce((sum, e) => sum + e.count, 0)
  const needsRcon = entries.some((e) => Object.keys(e.enchants).length > 0 || e.potion !== null)
  const rconBlocked = !isRconConnected && needsRcon
  const canGive = entries.length > 0 && blocked.length === 0 && !rconBlocked && !running

  const copyAll = async () => {
    const text = commands.map((c) => (c.ok ? c.command : `# 无法生成：${c.error}`)).join('\n')
    const ok = await copyText(text)
    if (ok) toast.success('命令已复制', { duration: 1500 })
    else toast.error('复制失败，请手动复制')
  }

  const first = commands[0]
  const targetLabel = batchMode
    ? `${targetCount} 名玩家`
    : playerName.length > 0
      ? playerName
      : '玩家'

  return (
    <aside
      className="flex min-h-0 flex-col bg-mcs-bg-muted"
      aria-label="发放清单"
      data-testid="give-ticket"
    >
      {/* 头部 */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-mcs-border-muted px-2.5">
        <span className="text-mcs-xs font-semibold text-mcs-text-default">发放清单</span>
        <span className="font-mono text-mcs-2xs text-mcs-text-muted">{entries.length} 种</span>
        {entries.length > 0 && (
          <button
            type="button"
            onClick={onClear}
            aria-label="清空已选物品"
            className="ml-auto rounded-mcs-xs px-1.5 py-0.5 text-mcs-xs text-mcs-text-muted hover:bg-mcs-state-hover hover:text-mcs-error-fg"
          >
            清空
          </button>
        )}
        {onCloseDrawer && (
          <Button
            variant="ghost"
            size="icon-sm"
            className={cn(entries.length === 0 && 'ml-auto', '@[760px]:hidden')}
            onClick={onCloseDrawer}
            aria-label="收起清单"
          >
            <X aria-hidden />
          </Button>
        )}
      </div>

      {/* 目标：换人时清单一并保留，这里显式写明发给谁 */}
      <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-mcs-border-muted px-2.5 text-mcs-xs text-mcs-text-muted">
        发放给 <strong className="font-semibold text-mcs-text-default">{targetLabel}</strong>
        {batchMode && <span className="text-mcs-2xs">（在线目标跳过离线）</span>}
        {!batchMode && (
          <span className="ml-auto size-1.5 rounded-full bg-mcs-success-fg" aria-hidden />
        )}
      </div>

      {/* 清单 */}
      {entries.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-6 text-center">
          <span className="flex size-11 items-center justify-center rounded-full border border-dashed border-mcs-border-default text-mcs-text-muted">
            <Package className="size-5" aria-hidden />
          </span>
          <p className="max-w-[208px] text-mcs-xs text-mcs-text-muted">
            还没有物品。点选目录里的物品，或直接从礼包开始。
          </p>
          <div className="flex w-full flex-col gap-1">
            {kits.slice(0, 2).map((kit) => (
              <button
                key={kit.name}
                type="button"
                onClick={() => onApplyKit(kit)}
                className="flex items-center gap-1.5 rounded-mcs-xs border border-mcs-border-muted bg-mcs-bg-default px-2 py-1.5 text-left text-mcs-xs text-mcs-text-default hover:border-mcs-border-default hover:bg-mcs-bg-secondary"
              >
                <span>{kit.icon}</span>
                <span className="truncate">{kit.name}</span>
                <span className="ml-auto font-mono text-mcs-2xs text-mcs-text-muted">
                  {kit.items.length} 件
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto p-0">
          {entries.map((entry) => (
            <TicketRow
              key={entry.item.id}
              entry={entry}
              openPanel={openPanelId === entry.item.id ? openPanelKind : null}
              onTogglePanel={(kind) => onTogglePanel(entry.item.id, kind)}
              onSetCount={(count) => onSetCount(entry.item.id, count)}
              onToggleEnchant={(enchId) => onToggleEnchant(entry.item.id, enchId)}
              onSetEnchantLevel={(enchId, level) => onSetEnchantLevel(entry.item.id, enchId, level)}
              onSetPotion={(potion) => onSetPotion(entry.item.id, potion)}
              onRemove={() => onRemove(entry.item.id)}
            />
          ))}
        </ul>
      )}

      {/* 底部：命令 + 告警 + 汇总与 CTA（常驻不滚，空态也保留 CTA 位置） */}
      <div className="flex shrink-0 flex-col gap-2 border-t border-mcs-border-muted px-2.5 pb-2.5 pt-2">
        {entries.length > 0 && (
          <>
            <div className="flex items-center gap-1.5 rounded-mcs-xs border border-mcs-border-muted bg-mcs-terminal-bg px-2 py-1.5">
              <Terminal className="size-3 shrink-0 text-mcs-terminal-accent" aria-hidden />
              <code
                className="min-w-0 flex-1 truncate font-mono text-mcs-2xs text-mcs-terminal-fg-bright"
                title={first?.ok ? first.command : first?.error}
                data-testid="give-command-preview"
              >
                {first?.ok ? first.command : first?.error}
              </code>
              {commands.length > 1 && (
                <button
                  type="button"
                  onClick={() => setShowAllCommands((v) => !v)}
                  aria-expanded={showAllCommands}
                  className="shrink-0 rounded-mcs-xs px-1 py-0.5 text-mcs-2xs text-mcs-terminal-subtle hover:bg-mcs-state-hover hover:text-mcs-text-default"
                >
                  {showAllCommands ? '收起' : `等 ${commands.length} 条`}
                </button>
              )}
              <button
                type="button"
                onClick={() => void copyAll()}
                aria-label="复制命令"
                className="shrink-0 rounded-mcs-xs p-0.5 text-mcs-terminal-subtle hover:bg-mcs-state-hover hover:text-mcs-text-default"
              >
                <Copy className="size-3" aria-hidden />
              </button>
            </div>
            {showAllCommands && (
              <div className="flex max-h-32 flex-col gap-0.5 overflow-y-auto rounded-mcs-xs border border-mcs-border-muted bg-mcs-terminal-bg p-1.5">
                {commands.map((c, i) => (
                  <code
                    key={entries[i]!.item.id}
                    className="break-all font-mono text-mcs-2xs text-mcs-terminal-fg"
                  >
                    {c.ok ? c.command : `# ${c.error}`}
                  </code>
                ))}
              </div>
            )}

            {blocked.length > 0 && (
              <NoticeBanner variant="warning" icon={AlertTriangle}>
                {blocked.length} 件物品在 MC {mcVersion} 不存在，发送会失败，请先移除。
              </NoticeBanner>
            )}
            {rconBlocked && (
              <NoticeBanner variant="warning" icon={AlertTriangle}>
                附魔与药水命令需要 RCON。请到实例设置 → RCON 开启后重试。
                <strong className="font-semibold">（当前已断开）</strong>
              </NoticeBanner>
            )}

            <div className="flex items-center gap-2">
              <span className="min-w-0 text-mcs-xs text-mcs-text-muted" data-testid="give-summary">
                共 <strong className="font-semibold text-mcs-text-default">{totalCount}</strong> 个
                · <strong className="font-semibold text-mcs-text-default">{entries.length}</strong>{' '}
                条 give 命令
              </span>
              <Button
                size="sm"
                className="ml-auto"
                disabled={!canGive}
                onClick={onGive}
                aria-label={`给予 ${targetLabel}`}
              >
                <Check aria-hidden />
                {running ? '执行中…' : `给予 ${targetLabel}`}
              </Button>
            </div>
          </>
        )}
        {entries.length === 0 && (
          <div className="flex items-center gap-2">
            <span className="min-w-0 text-mcs-xs text-mcs-text-muted">清单为空</span>
            <Button size="sm" className="ml-auto" disabled aria-label={`给予 ${targetLabel}`}>
              <Check aria-hidden />
              给予 {targetLabel}
            </Button>
          </div>
        )}
      </div>
    </aside>
  )
}
