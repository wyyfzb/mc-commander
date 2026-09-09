/**
 * 药水编辑器 —— PotionPanel（效果色边框、瓶型/等级/时长档 + 瞬时提示）
 * 从 give-item-dialog.tsx 提取，药水配置独立可测试。
 */
import { ChevronUp, FlaskConical } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import {
  POTION_BOTTLE_TYPES,
  POTION_LEVEL_ROMAN,
  POTION_MAX_LEVEL,
  durationsForLevel,
  potionLevelLabel,
  type PotionConfig,
} from '@/lib/mc-potions'
import { buildGiveCommand } from '@/lib/mc-enchantments'
import { effectColorHex, CommandPreview } from './give-item-preview-bar'
import type { SelectedEntry } from './give-item-enchant-editor'

/** 药水面板：瓶型 / 等级（I-V，超原版上限标「·自定义」）/ 时长（切换等级重置）+ 瞬时提示 */
export function PotionPanel({
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
        {/* 数据色只作色点/描边：MC 药水色作文字时亮暗各有约半数不达 4.5:1（亮 1.09–2.24 / 暗 1.26–1.48） */}
        <span className="truncate text-mcs-xs font-semibold text-mcs-text-default">
          药水 · {effect.name}
        </span>
        <span className="shrink-0 text-mcs-2xs text-mcs-text-muted">
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
          <span className="w-8 shrink-0 text-mcs-xs text-mcs-text-muted">瓶型</span>
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
          <span className="w-8 shrink-0 text-mcs-xs text-mcs-text-muted">等级</span>
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
            <span className="w-8 shrink-0 text-mcs-xs text-mcs-text-muted">时长</span>
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
          <p className="text-mcs-xs text-mcs-text-muted">
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
