/**
 * GamerulePanel —— 游戏规则面板（世界页「游戏规则」Tab；双版本兼容）
 * - 挂载自动查询：onSendCommand('gamerule') → parseGameruleOutput（1/3 降级阈值）
 * - 双版本选集：pickGameruleSet(mcVersion)（1.21.11 数值化阈值）+ 版本徽章
 * - 行级编辑（非整页编辑模式）：点控件进入该行编辑态，值改动后行尾出现「保存/取消」小按钮
 *   （Tasteful Friction）；确认 → onSendCommand(buildGameruleSetCommand) → 成功 toast + 更新本地值，
 *   失败 toast getFriendlyErrorMessage + 回滚（退出编辑态回到已提交值）
 * - 当前值未查到：控件显示默认值 + 「默认」标记（gameruleDisplayValue 语义），仍可编辑
 * - RCON 未连接：info 提示 + 控件禁用（跳过查询，避免调用方无谓错误 toast）
 * - 解析失败：warning 提示 + 默认值态（可点刷新重试）
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, Plug, RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { NoticeBanner } from '@/components/mcs/notice-banner'
import { Chip } from '@/components/mcs/chip'
import { SearchInput } from '@/components/mcs/search-input'
import { StatusPill } from '@/components/mcs/status-pill'
import { toast } from 'sonner'
import { ApiError } from '@/api/client'
import { getFriendlyErrorMessage } from '@/api/errors'
import {
  GAMERULE_CATEGORY_LABELS,
  GAMERULE_QUERY_COMMAND,
  MINECRAFT_GAMERULES,
  buildGameruleSetCommand,
  parseGameruleOutput,
  pickGameruleSet,
  type GameruleDef,
} from '@/lib/mc-gamerules'

interface GamerulePanelProps {
  instanceId: string
  mcVersion: string
  isRconConnected: boolean
  /** 发送命令；返回命令响应文本（失败抛错，由调用方 toast） */
  onSendCommand: (command: string) => Promise<string | null>
}

/** 错误 → 友好文案（与 give-item-dialog 一致：ApiError 走错误码映射，其余网络错误兜底） */
function friendlyError(err: unknown): string {
  if (err instanceof ApiError) return getFriendlyErrorMessage(err.code, err.message)
  return '网络错误'
}

/** 行级编辑态（同一时间仅一行在编辑） */
interface RowEdit {
  name: string
  draft: string
}

export function GamerulePanel({ instanceId, mcVersion, isRconConnected, onSendCommand }: GamerulePanelProps) {
  const defs = useMemo(() => pickGameruleSet(mcVersion), [mcVersion])
  /** 版本徽章：1.21.11+ 新命名体系 / 旧命名体系（pickGameruleSet 恒返回常量引用） */
  const isNewSet = defs === MINECRAFT_GAMERULES

  /** 当前值（Map<规范名, 值字符串>；查询未成功 → 空 Map → 各行显示默认值 + 「默认」标记） */
  const [values, setValues] = useState<Map<string, string>>(new Map())
  const [loading, setLoading] = useState(true)
  const [queryFailed, setQueryFailed] = useState(false)
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('all')
  const [edit, setEdit] = useState<RowEdit | null>(null)
  const [savingName, setSavingName] = useState<string | null>(null)
  /** 查询序号守卫：避免并发查询（挂载/刷新）时旧响应覆盖新响应 */
  const seqRef = useRef(0)

  /** 查询 gamerule 列表；解析失败（null/抛错）→ 清空当前值回默认值态 + warning */
  const load = useCallback(async () => {
    const seq = ++seqRef.current
    setLoading(true)
    setQueryFailed(false)
    try {
      const resp = await onSendCommand(GAMERULE_QUERY_COMMAND)
      if (seq !== seqRef.current) return
      const parsed = parseGameruleOutput(resp ?? '', defs)
      if (seq !== seqRef.current) return
      setValues(parsed ?? new Map())
      setQueryFailed(parsed === null)
    } catch {
      if (seq !== seqRef.current) return
      setValues(new Map())
      setQueryFailed(true)
    } finally {
      if (seq === seqRef.current) setLoading(false)
    }
  }, [onSendCommand, defs])

  // 挂载/实例或 RCON 连接状态变化时自动查询；不依赖 load（防父级回调重建导致反复查询）
  useEffect(() => {
    if (isRconConnected) {
      void load()
    } else {
      // RCON 未连接：不查询（避免调用方错误 toast），回到默认值态
      setLoading(false)
      setQueryFailed(false)
      setValues(new Map())
      setEdit(null)
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- 不依赖 load——onSendCommand 是父级 prop 回调，引用随父级重渲染变化，加入会导致反复 RCON 查询
  }, [instanceId, isRconConnected])

  /** 分类 chips：全部 + 当前规则集出现过的分类（GAMERULE_CATEGORY_LABELS 映射，按首现顺序） */
  const categories = useMemo(() => {
    const seen: string[] = []
    for (const d of defs) {
      if (!seen.includes(d.category)) seen.push(d.category)
    }
    return seen
  }, [defs])

  /** 搜索（name/desc）+ 分类过滤 */
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return defs.filter((d) => {
      if (category !== 'all' && d.category !== category) return false
      if (q.length === 0) return true
      return d.name.toLowerCase().includes(q) || d.desc.toLowerCase().includes(q)
    })
  }, [defs, category, search])

  /** 进入/更新行编辑态：点控件即编辑（Tasteful Friction） */
  const handleRowChange = (name: string, next: string) => {
    setEdit({ name, draft: next })
  }

  /** 确认保存：下发命令 → 成功更新本地值 + toast；失败回滚（退出编辑态） + 友好错误 toast */
  const commitSave = async () => {
    if (!edit) return
    const { name, draft } = edit
    setSavingName(name)
    try {
      await onSendCommand(buildGameruleSetCommand(name, draft))
      setValues((prev) => {
        const next = new Map(prev)
        next.set(name, draft)
        return next
      })
      setEdit(null)
      toast.success(`已更新规则 ${name} = ${draft}`)
    } catch (e) {
      setEdit(null)
      toast.error(`规则更新失败：${friendlyError(e)}`)
    } finally {
      setSavingName(null)
    }
  }

  const controlsDisabled = !isRconConnected || savingName !== null

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {/* ── 头部：标题 + 版本徽章 + 刷新 ── */}
      <div className="flex items-center gap-2">
        <span className="text-mcs-sm font-semibold text-mcs-text-default">游戏规则</span>
        <StatusPill tone={isNewSet ? 'accent' : 'muted'} className="text-mcs-2xs">
          {isNewSet ? '1.21.11+ 新规则' : '旧版规则'}
        </StatusPill>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={() => void load()}
          disabled={loading || !isRconConnected}
          aria-label="刷新规则"
        >
          <RefreshCw aria-hidden />
          刷新
        </Button>
      </div>

      {/* ── 状态提示条 ── */}
      {!isRconConnected && (
        <NoticeBanner variant="info" icon={Plug}>
          gamerule 修改需要 RCON 连接
        </NoticeBanner>
      )}
      {isRconConnected && queryFailed && (
        <NoticeBanner variant="warning" icon={AlertTriangle}>
          无法解析 gamerule 列表，请点击刷新重试
        </NoticeBanner>
      )}

      {/* ── 搜索 + 分类 FilterChip ── */}
      <div className="flex flex-wrap items-center gap-1.5">
        <SearchInput
          value={search}
          onValueChange={setSearch}
          placeholder="搜索规则…"
          aria-label="搜索规则"
          size="sm"
          className="w-56"
        />
        <Chip onClick={() => setCategory('all')} selected={category === 'all'}>
          全部
        </Chip>
        {categories.map((c) => (
          <Chip key={c} onClick={() => setCategory(c)} selected={category === c}>
            {GAMERULE_CATEGORY_LABELS[c] ?? c}
          </Chip>
        ))}
      </div>

      {/* ── 生效方式说明（与属性面板同一口径：一行说清「改了要不要重启」）──
             gamerule 经 RCON 命令作用于运行中的服务器，全部即时生效，无逐项例外 */}
      <p className="text-mcs-2xs text-mcs-text-muted">
        规则修改保存后即时生效，无需重启实例
      </p>

      {/* ── 规则列表 ── */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div data-testid="gamerule-skeletons" className="flex flex-col gap-1.5" aria-label="加载规则中">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <p className="py-8 text-center text-mcs-xs text-mcs-text-muted">无匹配规则</p>
        ) : (
          <div className="flex flex-col">
            {filtered.map((def) => (
              <RuleRow
                key={def.name}
                def={def}
                current={values.get(def.name)}
                isEditing={edit?.name === def.name}
                draft={edit?.name === def.name ? edit.draft : undefined}
                saving={savingName === def.name}
                disabled={controlsDisabled}
                onChange={(v) => handleRowChange(def.name, v)}
                onSave={() => void commitSave()}
                onCancel={() => setEdit(null)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** 单行：mono 规则名 + 描述 + 右对齐控件（bool→Switch；int→数字输入）+ 行级编辑保存/取消 */
function RuleRow({
  def,
  current,
  isEditing,
  draft,
  saving,
  disabled,
  onChange,
  onSave,
  onCancel,
}: {
  def: GameruleDef
  /** 当前值（查询未命中 → undefined → 显示默认值 + 「默认」标记） */
  current: string | undefined
  isEditing: boolean
  draft: string | undefined
  saving: boolean
  disabled: boolean
  onChange: (v: string) => void
  onSave: () => void
  onCancel: () => void
}) {
  const display = isEditing && draft !== undefined ? draft : (current ?? String(def.defaultValue))
  const isBool = def.type === 'bool'
  const boolOn = isBool && display === 'true'
  const intValid = !isBool && /^-?\d+$/.test(display)
  const isDefault = current === undefined

  return (
    <div className="flex items-center gap-3 border-b border-mcs-border-subtle px-2 py-1.5 last:border-b-0">
      <span className="w-56 shrink-0 truncate font-mono text-mcs-xs text-mcs-text-default" title={def.name}>
        {def.name}
      </span>
      <span className="min-w-0 flex-1 truncate text-mcs-2xs text-mcs-text-muted" title={def.desc}>
        {def.desc}
      </span>

      {isDefault && !isEditing && <span className="shrink-0 text-mcs-2xs text-mcs-text-muted">默认</span>}

      <div className="flex w-44 shrink-0 items-center justify-end">
        {isBool ? (
          <Switch
            checked={boolOn}
            disabled={disabled || saving}
            onCheckedChange={(checked) => onChange(checked ? 'true' : 'false')}
            aria-label={`${def.name} 开关`}
          />
        ) : (
          <Input
            type="text"
            inputMode="numeric"
            value={display}
            disabled={disabled || saving}
            onChange={(e) => onChange(e.target.value)}
            className="h-7 w-24 font-mono text-mcs-xs"
            aria-label={`${def.name} 值`}
          />
        )}
      </div>

      {/* 行尾保存/取消（编辑态出现；Tasteful Friction） */}
      {isEditing && (
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="sm" className="h-7 px-2 text-mcs-xs" onClick={onCancel} disabled={saving}>
            <X aria-hidden />
            取消
          </Button>
          <Button size="sm" className="h-7 px-2 text-mcs-xs" onClick={onSave} disabled={saving || (!isBool && !intValid)}>
            <Check aria-hidden />
            保存
          </Button>
        </div>
      )}
    </div>
  )
}
