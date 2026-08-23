/**
 * PropertiesPanel —— server.properties 属性表单
 * - 只读态/编辑态：快照 → 编辑（NoticeBanner + 取消/保存）→ PUT → restartRequired 中文标签 toast
 * - 三分类 FilterChip + 搜索；未知属性自动追加展示（只读，服务端白名单外不可写）
 * - 敏感 9 键锁定（锁图标 + 占位符，tooltip 说明）；热改 4 键编辑态标记「即时生效」
 * - 编辑值在组件 state，与 30s 轮询 query data 隔离，无需暂停轮询
 */
import { useMemo, useState } from 'react'
import { Lock, Pencil, Save, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Chip } from '@/components/mcs/chip'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { NoticeBanner } from '@/components/mcs/notice-banner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { toast } from 'sonner'
import { getFriendlyErrorText } from '@/api/errors'
import {
  buildPropertiesPayload,
  buildUnknownPropertyDef,
  HOT_RELOAD_KEYS,
  SERVER_PROPERTY_DEF_MAP,
  SENSITIVE_PROPERTY_KEYS,
  SENSITIVE_PROPERTY_PLACEHOLDER,
  type PropertyDef,
} from '@/lib/mc-properties'

const CATEGORY_LABELS: Array<{ value: string; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'gameplay', label: '游戏玩法' },
  { value: 'worldGen', label: '世界生成' },
  { value: 'serverSettings', label: '服务器设置' },
]

interface PropertiesPanelProps {
  /** 服务端当前属性值（GET /properties，敏感键已掩码） */
  properties: Record<string, string> | undefined
  isLoading: boolean
  /** 保存回调：PUT /properties；返回 restartRequired 键数组（由调用方 mutation 返回） */
  onSave: (payload: Record<string, string>) => Promise<string[]>
  /** 编辑态变化回调（页面级未保存守卫用） */
  onEditingChange?: (editing: boolean) => void
}

export function PropertiesPanel({ properties, isLoading, onSave, onEditingChange }: PropertiesPanelProps) {
  const [isEditing, setIsEditingState] = useState(false)

  /** 编辑态统一入口（state + 通知页面守卫） */
  const setEditing = (editing: boolean) => {
    setIsEditingState(editing)
    onEditingChange?.(editing)
  }
  const [saving, setSaving] = useState(false)
  /** 编辑态值（键→值；初始=快照） */
  const [edited, setEdited] = useState<Record<string, string>>({})
  const [snapshot, setSnapshot] = useState<Record<string, string>>({})
  const [category, setCategory] = useState('all')
  const [search, setSearch] = useState('')

  /** 完整规则行：已知 66 + 未知追加 */
  const rows = useMemo(() => {
    if (!properties) return []
    const defs: PropertyDef[] = []
    const seen = new Set<string>()
    for (const [key, value] of Object.entries(properties)) {
      if (key === '') continue
      const def = SERVER_PROPERTY_DEF_MAP.get(key) ?? buildUnknownPropertyDef(key, value)
      defs.push(def)
      seen.add(key)
    }
    return defs
  }, [properties])

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter((def) => {
      if (category !== 'all' && def.category !== category) return false
      if (q.length === 0) return true
      return def.name.toLowerCase().includes(q) || def.label.toLowerCase().includes(q) || def.desc.toLowerCase().includes(q)
    })
  }, [rows, category, search])

  const startEditing = () => {
    if (!properties) return
    setSnapshot({ ...properties })
    setEdited({ ...properties })
    setEditing(true)
  }

  const cancelEditing = () => {
    setEdited({})
    setSnapshot({})
    setEditing(false)
  }

  const save = async () => {
    setSaving(true)
    try {
      const payload = buildPropertiesPayload(edited, snapshot)
      const restartRequired = await onSave(payload)
      // 保存往返期间又有新编辑 → 保持编辑模式并提示再次保存（防静默丢编辑）
      const hasNewEdits = Object.keys(payload).some((k) => edited[k] !== payload[k])
      if (hasNewEdits) {
        toast.warning('保存成功，但期间有新的修改，请再次保存')
        return
      }
      setEditing(false)
      if (restartRequired.length === 0) {
        toast.success('规则已保存到服务器')
      } else {
        const labels = restartRequired
          .map((k) => SERVER_PROPERTY_DEF_MAP.get(k)?.label ?? k)
          .slice(0, 3)
        const suffix = restartRequired.length > 3 ? `等 ${restartRequired.length} 项` : ''
        // 需重启项用 warning 强调「还需行动」
        toast.warning(`已保存到文件，${labels.join('、')}${suffix}需重启服务器后生效`)
      }
    } catch (e) {
      toast.error(`保存失败：${getFriendlyErrorText(e)}`)
    } finally {
      setSaving(false)
    }
  }

  /** 当前显示值：编辑态取 edited，否则取服务端值 */
  const displayValue = (def: PropertyDef): string => (isEditing ? (edited[def.name] ?? snapshot[def.name] ?? '') : (properties?.[def.name] ?? ''))

  const setEditValue = (key: string, value: string) => {
    setEdited((prev) => ({ ...prev, [key]: value }))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {/* ── 头部：标题 + 编辑/取消/保存 ── */}
      <div className="flex items-center gap-2">
        <span className="text-mcs-sm font-semibold text-mcs-text-default">服务器属性</span>
        <span className="text-mcs-2xs text-mcs-text-subtle">server.properties</span>
        {!isEditing ? (
          <Button variant="outline" size="sm" className="ml-auto" onClick={startEditing} disabled={isLoading || !properties}>
            <Pencil aria-hidden />
            编辑
          </Button>
        ) : (
          <div className="ml-auto flex items-center gap-1.5">
            <Button variant="ghost" size="sm" onClick={cancelEditing} disabled={saving}>
              <X aria-hidden />
              取消
            </Button>
            <Button size="sm" onClick={() => void save()} disabled={saving}>
              <Save aria-hidden />
              {saving ? '保存中…' : '保存'}
            </Button>
          </div>
        )}
      </div>

      {/* ── 编辑态提示条 ── */}
      {isEditing && (
        <NoticeBanner variant="info">
          编辑模式已开启 — 你可以修改服务器属性，完成后点击「保存」或「取消」
        </NoticeBanner>
      )}

      {/* ── 搜索 + 分类 FilterChip ── */}
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="relative w-56">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-mcs-text-subtle" aria-hidden />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索属性…"
            className="h-7 pl-8 text-mcs-xs"
            aria-label="搜索属性"
          />
        </div>
        {CATEGORY_LABELS.map((c) => (
          <Chip key={c.value} onClick={() => setCategory(c.value)} selected={category === c.value}>
            {c.label}
          </Chip>
        ))}
      </div>

      {/* ── 属性列表 ── */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex flex-col gap-1.5">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="h-9 rounded-mcs-xs bg-mcs-bg-muted" aria-hidden />
            ))}
          </div>
        ) : filteredRows.length === 0 ? (
          <p className="py-8 text-center text-mcs-xs text-mcs-text-subtle">无匹配属性</p>
        ) : (
          <div className="flex flex-col">
            {filteredRows.map((def) => (
              <PropertyRow
                key={def.name}
                def={def}
                value={displayValue(def)}
                isEditing={isEditing}
                onChange={(v) => setEditValue(def.name, v)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** 单行：键名 + 描述 + 右对齐控件（敏感键锁定/switch/input/dropdown） */
function PropertyRow({
  def,
  value,
  isEditing,
  onChange,
}: {
  def: PropertyDef
  value: string
  isEditing: boolean
  onChange: (v: string) => void
}) {
  const isSensitive = SENSITIVE_PROPERTY_KEYS.has(def.name)
  const isHotReload = HOT_RELOAD_KEYS.has(def.name)

  return (
    <div className="flex items-center gap-3 border-b border-mcs-border-subtle px-2 py-1.5 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-mono text-mcs-xs text-mcs-text-default" title={def.name}>
            {def.name}
          </span>
          {isSensitive && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Lock className="size-3 shrink-0 text-mcs-text-subtle" aria-label="敏感属性" />
              </TooltipTrigger>
              <TooltipContent>安全敏感项不可通过面板修改，请在服务器上直接编辑 server.properties</TooltipContent>
            </Tooltip>
          )}
          {isHotReload && (
            <span className="shrink-0 rounded-mcs-xs bg-mcs-success-bg-subtle px-1 text-mcs-2xs text-mcs-success-fg">
              即时生效
            </span>
          )}
        </div>
        <div className="truncate text-mcs-2xs text-mcs-text-subtle" title={def.desc}>
          {def.label} · {def.desc}
        </div>
      </div>

      <div className="flex w-44 shrink-0 justify-end">
        {isSensitive ? (
          // 敏感键：只读占位符（编辑态也锁定）
          <span className="inline-flex items-center gap-1 rounded-mcs-xs bg-mcs-bg-muted px-2 py-1 font-mono text-mcs-xs text-mcs-text-subtle">
            <Lock className="size-3" aria-hidden />
            {SENSITIVE_PROPERTY_PLACEHOLDER}
          </span>
        ) : def.type === 'checkbox' ? (
          <Switch
            checked={value === 'true'}
            disabled={!isEditing || !def.isWritable}
            onCheckedChange={(checked) => onChange(checked ? 'true' : 'false')}
            aria-label={`${def.label} 开关`}
          />
        ) : def.type === 'dropdown' ? (
          <Select
            value={value || (def.options?.[0] ?? '')}
            onValueChange={onChange}
            disabled={!isEditing || !def.isWritable}
          >
            <SelectTrigger className="h-7 w-40 text-mcs-xs" aria-label={`${def.label} 选项`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(def.options ?? []).map((opt) => (
                <SelectItem key={opt} value={opt}>
                  {opt}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            disabled={!isEditing || !def.isWritable}
            className="h-7 w-40 font-mono text-mcs-xs"
            aria-label={`${def.label} 输入`}
          />
        )}
      </div>
    </div>
  )
}
