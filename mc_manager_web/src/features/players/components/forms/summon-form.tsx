/**
 * SummonForm - /summon 命令（在指定坐标召唤实体），自 action-forms.tsx 原样迁入。
 * 执行走 onAction({kind:'command', command})。
 * 设计纪律：全部 --mcs-* token
 */
import { useState, type FormEvent } from 'react'
import { Zap } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SearchInput } from '@/components/mcs/search-input'
import { CommandPreview } from '@/components/mcs/command-preview'
import { LoadingButton } from '@/components/mcs/loading-button'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { searchEntities, type McEntity } from '@/lib/mc-entities'
import type { ActionFormProps } from './types'
import { OfflineBanner } from './offline-banner'

export function SummonForm({ isRconConnected, onAction }: ActionFormProps) {
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
