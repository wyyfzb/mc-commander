/**
 * ActionForms - 玩家操作表单（经验/效果/召唤），与 GiveItemPanel/TeleportTab 同构模式
 *
 * 三个子组件：
 * 1. ExperienceForm - /xp 命令（给予/移除经验值或经验等级）
 * 2. EffectForm - /effect give|clear 命令（赋予/清除状态效果）
 * 3. SummonForm - /summon 命令（在指定坐标召唤实体）
 *
 * 执行走 onAction({kind:'command', command})；批量用 runBatchForTargets + formatBatchSummary toast。
 * 设计纪律：全部 --mcs-* token
 */
import { useState, type FormEvent } from 'react'
import {
  AlertTriangle,
  CloudOff,
  Sparkles,
  Star,
  Trash2,
  Zap,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SearchInput } from '@/components/mcs/search-input'
import { LoadingButton } from '@/components/mcs/loading-button'
import { CommandPreview } from '@/components/mcs/command-preview'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

import { cn } from '@/lib/utils'
import { MINECRAFT_POTIONS, type PotionEffect } from '@/lib/mc-potions'
import { searchEntities, type McEntity } from '@/lib/mc-entities'
import { formatBatchSummary, formatFailureDetails, runBatchForTargets } from '@/lib/mc-batch'
import type { Player } from '@/api/types'
import type { PlayerActionRequest } from '../mutations'

// ── 共享 Props ──

interface ActionFormProps {
  /** 单个模式目标玩家；批量模式为 null */
  player: Player | null
  /** 批量目标 */
  batchTargets: Player[]
  isBatchMode: boolean
   instanceId: string
   isRconConnected: boolean
   onAction: (req: PlayerActionRequest) => Promise<void>
}

// ── ExperienceForm ──

const XP_QUICK_AMOUNTS = [1, 10, 30, 50, 100, 500, 1000]
const XP_QUICK_LEVELS = [1, 5, 10, 20, 30]

function ExperienceForm({ player, batchTargets, isBatchMode, isRconConnected, onAction }: ActionFormProps) {
  const [mode, setMode] = useState<'points' | 'levels'>('points')
  const [amount, setAmount] = useState('10')
  const [action, setAction] = useState<'add' | 'set' | 'remove'>('add')
  const [loading, setLoading] = useState(false)

  const numAmount = Number(amount) || 0

  function buildCommand(targetName: string): string {
    if (action === 'set') {
      // /xp set <player> <amount>[L] — MC 1.13+ 语法，player 在 amount 前面
      return `/xp set ${targetName} ${numAmount}${mode === 'levels' ? 'L' : ''}`
    }
    if (mode === 'levels') {
      const suffix = action === 'remove' ? '-' : ''
      return `/xp ${suffix}${numAmount}L ${targetName}`
    }
    const suffix = action === 'remove' ? '-' : ''
    return `/xp ${suffix}${numAmount} ${targetName}`
  }

  function getPreview(): string {
    const name = player?.name ?? '<玩家>'
    return buildCommand(name)
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (numAmount <= 0) return
    setLoading(true)
    try {
      if (isBatchMode) {
        const results = await runBatchForTargets({
          targets: batchTargets,
          requireOnline: true,
          execute: async (p) => { await onAction({ kind: 'command', command: buildCommand(p.name) }) },
        })
        toast.success(formatBatchSummary('给予经验', results), {
          description: formatFailureDetails(results),
        })
      } else if (player) {
        await onAction({ kind: 'command', command: buildCommand(player.name) })
        toast.success(`已执行：${getPreview()}`)
      }
    } finally {
      setLoading(false)
    }
  }

  const canExecute = isRconConnected && numAmount > 0 && (!isBatchMode ? player?.isOnline : batchTargets.some((p) => p.isOnline))

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {!isRconConnected && <OfflineBanner />}

      {/* 模式切换 */}
      <div className="space-y-1.5">
        <Label className="text-mcs-xs text-mcs-text-subtle">类型</Label>
        <div className="flex gap-1.5">
          <Button
            type="button"
            variant={mode === 'points' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setMode('points')}
            aria-pressed={mode === 'points'}
            className="text-mcs-xs"
          >
            经验值
          </Button>
          <Button
            type="button"
            variant={mode === 'levels' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setMode('levels')}
            aria-pressed={mode === 'levels'}
            className="text-mcs-xs"
          >
            等级
          </Button>
        </div>
      </div>

      {/* 操作 */}
      <div className="space-y-1.5">
        <Label className="text-mcs-xs text-mcs-text-subtle">操作</Label>
        <div className="flex gap-1.5">
          {([['add', '给予'], ['set', '设置'], ['remove', '移除']] as const).map(([act, label]) => (
            <Button
              key={act}
              type="button"
              variant={action === act ? 'default' : 'outline'}
              size="sm"
              onClick={() => setAction(act)}
              aria-pressed={action === act}
              className="text-mcs-xs"
            >
              {label}
            </Button>
          ))}
        </div>
      </div>

      {/* 数值 */}
      <div className="space-y-1.5">
        <Label className="text-mcs-xs text-mcs-text-subtle">
          {mode === 'levels' ? '等级数' : '经验值'}
        </Label>
        <Input
          type="number"
          min={1}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder={mode === 'levels' ? '输入等级' : '输入经验值'}
          className="h-8 text-mcs-sm"
        />
        <div className="flex flex-wrap gap-1">
          {(mode === 'levels' ? XP_QUICK_LEVELS : XP_QUICK_AMOUNTS).map((v) => (
            <Button
              key={v}
              type="button"
              variant="outline"
              size="sm"
              className="h-6 px-2 text-mcs-2xs"
              onClick={() => setAmount(String(v))}
              aria-pressed={amount === String(v)}
            >
              {v}{mode === 'levels' ? 'L' : ''}
            </Button>
          ))}
        </div>
      </div>

      {/* 命令预览 */}
      <CommandPreview command={getPreview()} />

      {/* 执行 */}
      <LoadingButton type="submit" loading={loading} disabled={!canExecute} className="w-full">
        <Star className="mr-1.5 size-3.5" />
        {action === 'set' ? '设置' : action === 'remove' ? '移除' : '给予'}
        {mode === 'levels' ? '等级' : '经验'}
        {isBatchMode && `（${batchTargets.length} 名玩家）`}
      </LoadingButton>
    </form>
  )
}

// ── EffectForm ──

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
  if (['slowness', 'mining_fatigue', 'nausea', 'blindness', 'hunger', 'weakness', 'poison', 'wither', 'levitation', 'darkness', 'wind_charged'].includes(e.effectId)) return '负面效果'
  if (['saturation', 'glowing', 'luck', 'bad_omen', 'hero_of_the_village', 'trial_omen', 'infested', 'oozing', 'weaving', 'cobweb'].includes(e.effectId)) return '中性/特殊'
  return '正向增益'
}

function EffectForm({ player, batchTargets, isBatchMode, isRconConnected, onAction }: ActionFormProps) {
  const [effectId, setEffectId] = useState('')
  const [level, setLevel] = useState(1)
  const [durationSeconds, setDurationSeconds] = useState(180)
  const [effectMode, setEffectMode] = useState<'give' | 'clear'>('give')
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')

  const selectedEffect = MINECRAFT_POTIONS.find((e) => e.effectId === effectId)
  const levelOptions = selectedEffect ? (selectedEffect.isInstant ? [1] : Array.from({ length: 5 }, (_, i) => i + 1)) : [1, 2, 3, 4, 5]

  const filteredEffects = search
    ? MINECRAFT_POTIONS.filter((e) => e.name.includes(search) || e.effectId.toLowerCase().includes(search.toLowerCase()))
    : MINECRAFT_POTIONS

  const effectsByCategory = EFFECT_CATEGORIES.map((cat) => ({
    category: cat,
    effects: filteredEffects.filter((e) => categorizeEffect(e) === cat),
  })).filter((g) => g.effects.length > 0)

  function buildCommand(targetName: string): string {
    if (effectMode === 'clear') return `/effect clear ${targetName}`
    if (!selectedEffect) return ''
    const dur = selectedEffect.isInstant ? '1' : durationSeconds === -1 ? '999999' : String(durationSeconds * 20)
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
          execute: async (p) => { await onAction({ kind: 'command', command: buildCommand(p.name) }) },
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

  const canExecute = isRconConnected && (effectMode === 'clear' || !!selectedEffect) &&
    (!isBatchMode ? player?.isOnline : batchTargets.some((p) => p.isOnline))

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {!isRconConnected && <OfflineBanner />}

      {/* 模式切换 */}
      <div className="flex gap-1.5">
        <Button
          type="button"
          variant={effectMode === 'give' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setEffectMode('give')}
          aria-pressed={effectMode === 'give'}
          className="text-mcs-xs"
        >
          赋予效果
        </Button>
        <Button
          type="button"
          variant={effectMode === 'clear' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setEffectMode('clear')}
          aria-pressed={effectMode === 'clear'}
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
            inputClassName="h-8 text-mcs-sm"
            size="sm"
          />

          {/* 效果选择网格 */}
          <div className="max-h-48 space-y-3 overflow-auto pr-1">
            {effectsByCategory.map((group) => (
              <div key={group.category}>
                <div className="mb-1 text-mcs-2xs font-medium text-mcs-text-subtle">{group.category}</div>
                <div className="flex flex-wrap gap-1">
                  {group.effects.map((e) => (
                    <button
                      key={e.effectId}
                      type="button"
                      onClick={() => setEffectId(e.effectId)}
                      aria-pressed={effectId === e.effectId}
                      className={cn(
                        'inline-flex items-center gap-1 rounded-mcs-sm border px-2 py-0.5 text-mcs-xs transition-colors',
                        effectId === e.effectId
                          ? 'border-mcs-accent bg-mcs-accent-bg-subtle text-mcs-accent-fg'
                          : 'border-mcs-border-default bg-mcs-bg-default text-mcs-text-default hover:bg-mcs-bg-hover',
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
              <Label className="text-mcs-xs text-mcs-text-subtle">等级</Label>
              <div className="flex gap-1">
                {levelOptions.map((l) => (
                  <Button
                    key={l}
                    type="button"
                    variant={level === l ? 'default' : 'outline'}
                    size="sm"
                    className="h-7 px-2.5 text-mcs-xs"
                    onClick={() => setLevel(l)}
                    aria-pressed={level === l}
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
              <Label className="text-mcs-xs text-mcs-text-subtle">持续时间</Label>
              <div className="flex flex-wrap gap-1">
                {DURATION_PRESETS.map((preset) => (
                  <Button
                    key={preset.label}
                    type="button"
                    variant={durationSeconds === preset.seconds ? 'default' : 'outline'}
                    size="sm"
                    className="h-7 px-2.5 text-mcs-xs"
                    onClick={() => setDurationSeconds(preset.seconds)}
                    aria-pressed={durationSeconds === preset.seconds}
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
        <div className="rounded-mcs-sm border border-mcs-warning-bg-subtle bg-mcs-warning-bg-subtle p-3">
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
      {effectMode === 'clear' && player && (
        <CommandPreview command={buildCommand(player.name)} />
      )}

      {/* 执行 */}
      <LoadingButton type="submit" loading={loading} disabled={!canExecute} className="w-full">
        <Sparkles className="mr-1.5 size-3.5" />
        {effectMode === 'clear' ? '清除全部效果' : `赋予${selectedEffect?.name ?? ''}效果`}
        {isBatchMode && `（${batchTargets.length} 名玩家）`}
      </LoadingButton>
    </form>
  )
}

// ── SummonForm ──

function SummonForm({ isRconConnected, onAction }: ActionFormProps) {
  const [entitySearch, setEntitySearch] = useState('')
  const [selectedEntity, setSelectedEntity] = useState<McEntity | null>(null)
  const [x, setX] = useState('~')
  const [y, setY] = useState('~')
  const [z, setZ] = useState('~')
  const [loading, setLoading] = useState(false)

  const filteredEntities = searchEntities(entitySearch)
  const entitiesByCategory = new Map<string, McEntity[]>()
  for (const e of filteredEntities) {
    const list = entitiesByCategory.get(e.category) ?? []
    list.push(e)
    entitiesByCategory.set(e.category, list)
  }

  function buildCommand(): string {
    if (!selectedEntity) return ''
    return `/summon ${selectedEntity.id} ${x} ${y} ${z}`
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!selectedEntity) return
    setLoading(true)
    try {
      await onAction({ kind: 'command', command: buildCommand() })
      toast.success(`已召唤：${selectedEntity.name}`)
    } finally {
      setLoading(false)
    }
  }

  const canExecute = isRconConnected && !!selectedEntity

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {!isRconConnected && <OfflineBanner />}

      {/* 搜索 */}
      <SearchInput
        value={entitySearch}
        onValueChange={setEntitySearch}
        placeholder="搜索实体（中文/ID）"
        aria-label="搜索实体"
        inputClassName="h-8 text-mcs-sm"
        size="sm"
      />

      {/* 实体选择网格 */}
      <div className="max-h-52 space-y-2.5 overflow-auto pr-1">
        {Array.from(entitiesByCategory.entries()).map(([category, entities]) => (
          <div key={category}>
            <div className="mb-1 text-mcs-2xs font-medium text-mcs-text-subtle">{category}（{entities.length}）</div>
            <div className="flex flex-wrap gap-1">
              {entities.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => setSelectedEntity(e)}
                  aria-pressed={selectedEntity?.id === e.id}
                  className={cn(
                    'rounded-mcs-sm border px-2 py-0.5 text-mcs-xs transition-colors',
                    selectedEntity?.id === e.id
                      ? 'border-mcs-accent bg-mcs-accent-bg-subtle text-mcs-accent-fg'
                      : 'border-mcs-border-default bg-mcs-bg-default text-mcs-text-default hover:bg-mcs-bg-hover',
                  )}
                >
                  {e.name}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* 选中实体名称 */}
      {selectedEntity && (
        <div className="flex items-center gap-2 rounded-mcs-sm border border-mcs-border-muted bg-mcs-bg-muted px-3 py-2">
          <span className="text-mcs-2xs text-mcs-text-subtle">已选：</span>
          <span className="text-mcs-sm font-medium text-mcs-text-default">{selectedEntity.name}</span>
          <span className="font-mono text-mcs-2xs text-mcs-text-muted">minecraft:{selectedEntity.id}</span>
        </div>
      )}

      {/* 坐标 */}
      <div className="space-y-1.5">
        <Label className="text-mcs-xs text-mcs-text-subtle">召唤坐标</Label>
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: 'X', value: x, set: setX, placeholder: '~ 或数字' },
            { label: 'Y', value: y, set: setY, placeholder: '~ 或数字' },
            { label: 'Z', value: z, set: setZ, placeholder: '~ 或数字' },
          ].map(({ label, value, set, placeholder }) => (
            <div key={label} className="space-y-1">
              <div className="text-mcs-2xs text-mcs-text-muted">{label}</div>
              <Input
                value={value}
                onChange={(e) => set(e.target.value)}
                placeholder={placeholder}
                aria-label={label}
                className="h-8 text-mcs-sm font-mono"
              />
            </div>
          ))}
        </div>
        <div className="flex gap-1">
          <Button type="button" variant="outline" size="sm" className="h-6 px-2 text-mcs-2xs" onClick={() => { setX('~'); setY('~'); setZ('~') }}>
            当前位置 (~ ~ ~)
          </Button>
          <Button type="button" variant="outline" size="sm" className="h-6 px-2 text-mcs-2xs" onClick={() => { setX('~ ~1 ~'); setY('~2'); setZ('~') }}>
            头顶上方
          </Button>
        </div>
      </div>

      {/* 命令预览 */}
      {selectedEntity && <CommandPreview command={buildCommand()} />}

      {/* 执行 */}
      <LoadingButton type="submit" loading={loading} disabled={!canExecute} className="w-full">
        <Zap className="mr-1.5 size-3.5" />
        召唤{selectedEntity ? selectedEntity.name : '实体'}
      </LoadingButton>
    </form>
  )
}

// ── 共享组件 ──

function OfflineBanner() {
  return (
    <div className="flex items-center gap-2 rounded-mcs-sm border border-mcs-warning-bg-subtle bg-mcs-warning-bg-subtle p-2.5">
      <CloudOff className="size-4 shrink-0 text-mcs-warning-fg" aria-hidden="true" />
      <span className="text-mcs-xs text-mcs-warning-fg">RCON 未连接，无法执行操作</span>
    </div>
  )
}



// ── 导出（Tab 壳）──

export function ActionForms(props: ActionFormProps) {
  return (
    <Tabs defaultValue="experience" className="space-y-3">
      <TabsList className="h-8 w-full justify-start gap-0 rounded-mcs-sm bg-mcs-bg-muted p-0.5">
        <TabsTrigger value="experience" className="h-7 gap-1 rounded-mcs-xs px-2.5 text-mcs-xs">
          <Star className="size-3" />
          经验
        </TabsTrigger>
        <TabsTrigger value="effect" className="h-7 gap-1 rounded-mcs-xs px-2.5 text-mcs-xs">
          <Sparkles className="size-3" />
          效果
        </TabsTrigger>
        <TabsTrigger value="summon" className="h-7 gap-1 rounded-mcs-xs px-2.5 text-mcs-xs">
          <Zap className="size-3" />
          召唤
        </TabsTrigger>
      </TabsList>

      <TabsContent value="experience">
        <ExperienceForm {...props} />
      </TabsContent>
      <TabsContent value="effect">
        <EffectForm {...props} />
      </TabsContent>
      <TabsContent value="summon">
        <SummonForm {...props} />
      </TabsContent>
    </Tabs>
  )
}
