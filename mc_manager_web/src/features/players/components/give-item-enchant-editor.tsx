/**
 * 附魔编辑器 —— EnchantPanel（紫底面板）+ EnchantToggle（开关）
 * 从 give-item-dialog.tsx 提取，附魔配置独立可测试。
 */
import {
  ChevronUp,
  Wand2,
} from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  buildGiveCommand,
  getEnchantmentsForItem,
  isEnchantmentDisabledBy,
  toRoman,
  type Enchantment,
} from '@/lib/mc-enchantments'
import type { PotionConfig } from '@/lib/mc-potions'
import type { MinecraftItem } from '@/lib/mc-items'
import { CommandPreview } from './give-item-preview-bar'

/** 选中条目的运行时配置（与主组件保持同步） */
export interface SelectedEntry {
  item: MinecraftItem
  count: number
  enchants: Record<string, number>
  potion: PotionConfig | null
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
export function EnchantPanel({
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
