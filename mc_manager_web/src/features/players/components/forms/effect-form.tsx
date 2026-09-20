/**
 * EffectForm - /effect give|clear 命令（赋予/清除状态效果），自 action-forms.tsx 原样迁入。
 * 执行走 onAction({kind:'command', command})；批量用 runBatchForTargets + formatBatchSummary toast。
 * 设计纪律：全部 --mcs-* token
 */
import { useState, type FormEvent } from 'react'
import { AlertTriangle, Sparkles, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { SearchInput } from '@/components/mcs/search-input'
import { CommandPreview } from '@/components/mcs/command-preview'
import { LoadingButton } from '@/components/mcs/loading-button'
import { Label } from '@/components/ui/label'
import { useRadioGroup } from '@/hooks/use-radio-group'
import { cn } from '@/lib/utils'
import { TONE_SELECTED_CLASSES } from '@/components/mcs/tone'
import { MINECRAFT_POTIONS, type PotionEffect } from '@/lib/mc-potions'
import { formatBatchSummary, formatFailureDetails, runBatchForTargets } from '@/lib/mc-batch'
import type { ActionFormProps } from './types'
import { OfflineBanner } from './offline-banner'

const DURATION_PRESETS = [
  { label: '30秒', seconds: 30 },
  { label: '1分钟', seconds: 60 },
  { label: '3分钟', seconds: 180 },
  { label: '5分钟', seconds: 300 },
  { label: '10分钟', seconds: 600 },
  { label: '30分钟', seconds: 1800 },
  { label: '1小时', seconds: 3600 },
  { label: '无限', seconds: -1 },
]

const EFFECT_CATEGORIES = ['正向增益', '负面效果', '中性/特殊'] as const

function categorizeEffect(e: PotionEffect): string {
  if (
    [
      'slowness',
      'mining_fatigue',
      'nausea',
      'blindness',
      'hunger',
      'weakness',
      'poison',
      'wither',
      'levitation',
      'darkness',
      'wind_charged',
    ].includes(e.effectId)
  )
    return '负面效果'
  if (
    [
      'saturation',
      'glowing',
      'luck',
      'bad_omen',
      'hero_of_the_village',
      'trial_omen',
      'infested',
      'oozing',
      'weaving',
      'cobweb',
    ].includes(e.effectId)
  )
    return '中性/特殊'
  return '正向增益'
}

export function EffectForm({
  player,
  batchTargets,
  isBatchMode,
  isRconConnected,
  onAction,
}: ActionFormProps) {
  const [effectId, setEffectId] = useState('')
  const [level, setLevel] = useState(1)
  const [durationSeconds, setDurationSeconds] = useState(180)
  const [effectMode, setEffectMode] = useState<'give' | 'clear'>('give')
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')

  const selectedEffect = MINECRAFT_POTIONS.find((e) => e.effectId === effectId)
  const levelOptions = selectedEffect
    ? selectedEffect.isInstant
      ? [1]
      : Array.from({ length: 5 }, (_, i) => i + 1)
    : [1, 2, 3, 4, 5]

  const filteredEffects = search
    ? MINECRAFT_POTIONS.filter(
        (e) => e.name.includes(search) || e.effectId.toLowerCase().includes(search.toLowerCase()),
      )
    : MINECRAFT_POTIONS

  const effectsByCategory = EFFECT_CATEGORIES.map((cat) => ({
    category: cat,
    effects: filteredEffects.filter((e) => categorizeEffect(e) === cat),
  })).filter((g) => g.effects.length > 0)

  // 四组互斥选择（操作模式/效果/等级/时长）都是单选组：语义与方向键由 hook 统一提供。
  // 效果网格按分类渲染成三段，但语义上是一个组，故按**渲染顺序压平**后定下标
  const flatEffects = effectsByCategory.flatMap((g) => g.effects)
  const effectIndexById = new Map(flatEffects.map((e, i) => [e.effectId, i]))
  const modeGroup = useRadioGroup<'give' | 'clear'>({
    label: '操作模式',
    value: effectMode,
    values: ['give', 'clear'],
    onChange: setEffectMode,
  })
  const effectGroup = useRadioGroup<string>({
    label: '状态效果',
    value: effectId === '' ? null : effectId,
    values: flatEffects.map((e) => e.effectId),
    onChange: setEffectId,
  })
  const levelGroup = useRadioGroup<number>({
    label: '等级',
    value: level,
    values: levelOptions,
    onChange: setLevel,
  })
  const durationGroup = useRadioGroup<number>({
    label: '持续时间',
    value: durationSeconds,
    values: DURATION_PRESETS.map((p) => p.seconds),
    onChange: setDurationSeconds,
  })

  function buildCommand(targetName: string): string {
    if (effectMode === 'clear') return `/effect clear ${targetName}`
    if (!selectedEffect) return ''
    const dur = selectedEffect.isInstant
      ? '1'
      : durationSeconds === -1
        ? '999999'
        : String(durationSeconds * 20)
    return `/effect give ${targetName} ${selectedEffect.effectId} ${dur} ${level}`
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (effectMode === 'give' && !selectedEffect) return
    setLoading(true)
    try {
      if (isBatchMode) {
        const results = await runBatchForTargets({
          targets: batchTargets,
          requireOnline: true,
          execute: async (p) => {
            await onAction({ kind: 'command', command: buildCommand(p.name) })
          },
        })
        toast.success(formatBatchSummary('赋予效果', results), {
          description: formatFailureDetails(results),
        })
      } else if (player) {
        await onAction({ kind: 'command', command: buildCommand(player.name) })
        toast.success(`已执行：${buildCommand(player.name)}`)
      }
    } finally {
      setLoading(false)
    }
  }

  const canExecute =
    isRconConnected &&
    (effectMode === 'clear' || !!selectedEffect) &&
    (!isBatchMode ? player?.isOnline : batchTargets.some((p) => p.isOnline))

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {!isRconConnected && <OfflineBanner />}

      {/* 模式切换 */}
      <div className="flex gap-1.5" {...modeGroup.groupProps}>
        <Button
          type="button"
          variant={effectMode === 'give' ? 'selected' : 'outline'}
          size="sm"
          {...modeGroup.itemProps(0)}
          onClick={() => setEffectMode('give')}
          className="text-mcs-xs"
        >
          赋予效果
        </Button>
        <Button
          type="button"
          variant={effectMode === 'clear' ? 'selected' : 'outline'}
          size="sm"
          {...modeGroup.itemProps(1)}
          onClick={() => setEffectMode('clear')}
          className="text-mcs-xs"
        >
          <Trash2 className="mr-1 size-3" aria-hidden="true" />
          清除全部
        </Button>
      </div>

      {effectMode === 'give' && (
        <>
          {/* 搜索 */}
          <SearchInput
            value={search}
            onValueChange={setSearch}
            placeholder="搜索效果（中文/ID）"
            aria-label="搜索效果"
          />

          {/* 效果选择网格（跨分类的一个单选组） */}
          <div className="max-h-48 space-y-3 overflow-auto pr-1" {...effectGroup.groupProps}>
            {effectsByCategory.map((group) => (
              <div key={group.category}>
                <div className="mb-1 text-mcs-2xs font-medium text-mcs-text-muted">
                  {group.category}
                </div>
                <div className="flex flex-wrap gap-1">
                  {group.effects.map((e) => (
                    <button
                      key={e.effectId}
                      type="button"
                      {...effectGroup.itemProps(effectIndexById.get(e.effectId) ?? 0)}
                      onClick={() => setEffectId(e.effectId)}
                      className={cn(
                        'inline-flex items-center gap-1 rounded-mcs-sm border px-2 py-0.5 text-mcs-xs transition-colors',
                        effectId === e.effectId
                          ? TONE_SELECTED_CLASSES
                          : 'border-mcs-border-default bg-mcs-bg-default text-mcs-text-default hover:bg-mcs-state-hover',
                      )}
                    >
                      <span
                        className="inline-block size-2 rounded-full"
                        style={{ backgroundColor: `#${e.color.toString(16).padStart(6, '0')}` }}
                      />
                      {e.name}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* 等级 */}
          {selectedEffect && !selectedEffect.isInstant && (
            <div className="space-y-1.5">
              <Label className="text-mcs-xs text-mcs-text-muted">等级</Label>
              <div className="flex gap-1" {...levelGroup.groupProps}>
                {levelOptions.map((l, index) => (
                  <Button
                    key={l}
                    type="button"
                    variant={level === l ? 'selected' : 'outline'}
                    size="sm"
                    className="h-7 px-2.5 text-mcs-xs"
                    {...levelGroup.itemProps(index)}
                    onClick={() => setLevel(l)}
                  >
                    {l}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {/* 时长 */}
          {selectedEffect && !selectedEffect.isInstant && (
            <div className="space-y-1.5">
              <Label className="text-mcs-xs text-mcs-text-muted">持续时间</Label>
              <div className="flex flex-wrap gap-1" {...durationGroup.groupProps}>
                {DURATION_PRESETS.map((preset, index) => (
                  <Button
                    key={preset.label}
                    type="button"
                    variant={durationSeconds === preset.seconds ? 'selected' : 'outline'}
                    size="sm"
                    className="h-7 px-2.5 text-mcs-xs"
                    {...durationGroup.itemProps(index)}
                    onClick={() => setDurationSeconds(preset.seconds)}
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {effectMode === 'clear' && (
        <div className="rounded-mcs-sm border border-mcs-warning-border bg-mcs-warning-bg-subtle p-3">
          <div className="flex items-start gap-2 text-mcs-xs text-mcs-warning-fg">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>将清除目标玩家的全部状态效果，包括正向增益效果。</span>
          </div>
        </div>
      )}

      {/* 命令预览 */}
      {effectMode === 'give' && selectedEffect && player && (
        <CommandPreview command={buildCommand(player.name)} />
      )}
      {effectMode === 'clear' && player && <CommandPreview command={buildCommand(player.name)} />}

      {/* 执行 */}
      <LoadingButton type="submit" loading={loading} disabled={!canExecute} className="w-full">
        <Sparkles className="mr-1.5 size-3.5" />
        {effectMode === 'clear' ? '清除全部效果' : `赋予${selectedEffect?.name ?? ''}效果`}
        {isBatchMode && `（${batchTargets.length} 名玩家）`}
      </LoadingButton>
    </form>
  )
}
