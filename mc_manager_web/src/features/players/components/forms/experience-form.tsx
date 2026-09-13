/**
 * ExperienceForm - /xp 命令（给予/设置/移除经验值或经验等级），自 action-forms.tsx 原样迁入。
 * 执行走 onAction({kind:'command', command})；批量用 runBatchForTargets + formatBatchSummary toast。
 * 设计纪律：全部 --mcs-* token
 */
import { useState, type FormEvent } from 'react'
import { Star } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { CommandPreview } from '@/components/mcs/command-preview'
import { LoadingButton } from '@/components/mcs/loading-button'
import { Label } from '@/components/ui/label'
import { useRadioGroup } from '@/hooks/use-radio-group'
import { formatBatchSummary, formatFailureDetails, runBatchForTargets } from '@/lib/mc-batch'
import type { ActionFormProps } from './types'
import { OfflineBanner } from './offline-banner'

const XP_QUICK_AMOUNTS = [1, 10, 30, 50, 100, 500, 1000]
const XP_QUICK_LEVELS = [1, 5, 10, 20, 30]

export function ExperienceForm({ player, batchTargets, isBatchMode, isRconConnected, onAction }: ActionFormProps) {
  const [mode, setMode] = useState<'points' | 'levels'>('points')
  const [amount, setAmount] = useState('10')
  const [action, setAction] = useState<'add' | 'set' | 'remove'>('add')
  const [loading, setLoading] = useState(false)

  const numAmount = Number(amount) || 0

  // 类型/操作/快捷数值都是互斥单选：语义与方向键由 hook 统一提供
  // （快捷数值是「填数按钮」，用户手输其它值时无选中——合法的无选中态）
  const modeGroup = useRadioGroup<'points' | 'levels'>({
    label: '类型',
    value: mode,
    values: ['points', 'levels'],
    onChange: setMode,
  })
  const actionGroup = useRadioGroup<'add' | 'set' | 'remove'>({
    label: '操作',
    value: action,
    values: ['add', 'set', 'remove'],
    onChange: setAction,
  })
  const quickAmountValues = (mode === 'levels' ? XP_QUICK_LEVELS : XP_QUICK_AMOUNTS).map(String)
  const quickAmountGroup = useRadioGroup<string>({
    label: mode === 'levels' ? '快捷等级' : '快捷经验值',
    value: amount,
    values: quickAmountValues,
    onChange: setAmount,
  })

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
        <Label className="text-mcs-xs text-mcs-text-muted">类型</Label>
        <div className="flex gap-1.5" {...modeGroup.groupProps}>
          <Button
            type="button"
            variant={mode === 'points' ? 'selected' : 'outline'}
            size="sm"
            {...modeGroup.itemProps(0)}
            onClick={() => setMode('points')}
            className="text-mcs-xs"
          >
            经验值
          </Button>
          <Button
            type="button"
            variant={mode === 'levels' ? 'selected' : 'outline'}
            size="sm"
            {...modeGroup.itemProps(1)}
            onClick={() => setMode('levels')}
            className="text-mcs-xs"
          >
            等级
          </Button>
        </div>
      </div>

      {/* 操作 */}
      <div className="space-y-1.5">
        <Label className="text-mcs-xs text-mcs-text-muted">操作</Label>
        <div className="flex gap-1.5" {...actionGroup.groupProps}>
          {([['add', '给予'], ['set', '设置'], ['remove', '移除']] as const).map(([act, label], index) => (
            <Button
              key={act}
              type="button"
              variant={action === act ? 'selected' : 'outline'}
              size="sm"
              {...actionGroup.itemProps(index)}
              onClick={() => setAction(act)}
              className="text-mcs-xs"
            >
              {label}
            </Button>
          ))}
        </div>
      </div>

      {/* 数值 */}
      <div className="space-y-1.5">
        <Label className="text-mcs-xs text-mcs-text-muted">
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
        <div className="flex flex-wrap gap-1" {...quickAmountGroup.groupProps}>
          {(mode === 'levels' ? XP_QUICK_LEVELS : XP_QUICK_AMOUNTS).map((v, index) => (
            <Button
              key={v}
              type="button"
              variant="outline"
              size="sm"
              className="h-6 px-2 text-mcs-2xs"
              {...quickAmountGroup.itemProps(index)}
              onClick={() => setAmount(String(v))}
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
