/**
 * GamerulePanel —— 游戏规则面板（世界页「游戏规则」Tab）
 *
 * 名单与当前值都来自服务端聚合端点 `GET /instances/:id/gamerules`：一台服务器有哪些规则
 * 只能由服务器自述（MSMP 的 minecraft:gamerules 或 `help gamerule`），面板不按版本猜名单。
 *
 * 三态各说各的事实：
 * - `current`：有值 ⇒ 该行可编辑
 * - `missing`：该版本没有这条规则 ⇒ 灰标「未读取」
 * - `unreadable`：读取失败 ⇒ 同上，但原因文案不同（可重试）
 *
 * 未读取的两态**不渲染值控件**：开关总会渲染成「关」、输入框总会渲染成某个数字，那正是
 * 「没读到」被读成「关 / 默认值」的来源——少一个控件，好过给一个看起来像事实的值。
 *
 * 静态表只做可选装饰（中文名/描述/分类）：查得到就显示，查不到显示服务器自述的原始名，
 * 不影响该行是否出现、是否可编辑。
 */
import { useCallback, useMemo, useState } from 'react'
import { AlertTriangle, Check, Plug, RefreshCw, X } from 'lucide-react'
import type { GameruleEntry } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { NoticeBanner, NoticeBannerAction } from '@/components/mcs/notice-banner'
import { Chip } from '@/components/mcs/chip'
import { InfoHint } from '@/components/mcs/info-hint'
import { SearchInput } from '@/components/mcs/search-input'
import { StatusPill } from '@/components/mcs/status-pill'
import { toast } from 'sonner'
import { ApiError } from '@/api/client'
import { getFriendlyErrorMessage } from '@/api/errors'
import { useGamerules } from '../queries'
import {
  GAMERULE_CATEGORY_LABELS,
  buildGameruleSetCommand,
  gameruleValueError,
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
  // 第三参 err.details 带字段级校验错误（path + message），丢掉只剩笼统文案
  if (err instanceof ApiError) return getFriendlyErrorMessage(err.code, err.message, err.details)
  return '网络错误'
}

/**
 * 两态未读取的原因：`missing` 是「这个版本就没有」，`unreadable` 是「这次没读到」。
 * 压成一句话会让用户去重试一条永远读不到的规则。
 */
const UNREAD_REASON: Record<'missing' | 'unreadable', string> = {
  missing: '当前服务器版本没有这条规则，无法读取或修改',
  unreadable: '读取当前值失败，可点「刷新」重试',
}

/** 端点类型 → 取值校验用的类型码（`null` = 类型未知，只按区间表拦，不猜布尔） */
function ruleType(type: GameruleEntry['type']): 'bool' | 'int' | null {
  if (type === 'boolean') return 'bool'
  if (type === 'integer') return 'int'
  return null
}

/** 行级编辑态（同一时间仅一行在编辑） */
interface RowEdit {
  name: string
  draft: string
}

export function GamerulePanel({
  instanceId,
  mcVersion,
  isRconConnected,
  onSendCommand,
}: GamerulePanelProps) {
  /** 文案表：按版本选一册、按小写名字索引（只给中文名/描述/分类，不参与名单） */
  const copy = useMemo(() => {
    const byName = new Map<string, GameruleDef>()
    for (const def of pickGameruleSet(mcVersion)) byName.set(def.name.toLowerCase(), def)
    return byName
  }, [mcVersion])

  const { data, isPending, isFetching, isError, error, refetch } = useGamerules(
    instanceId,
    isRconConnected,
  )

  /** 保存成功后的乐观值：端点刷新落定前先显示刚提交的值（Map<名字, 值>） */
  const [optimistic, setOptimistic] = useState<Map<string, string>>(new Map())
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('all')
  const [edit, setEdit] = useState<RowEdit | null>(null)
  const [savingName, setSavingName] = useState<string | null>(null)

  const rules = useMemo(() => data?.rules ?? [], [data])
  const sourceNone = data?.source === 'none'
  /** 通道通、但名单这一问没答上来（rules 为空）——与「通道都不可用」是两件事 */
  const rosterFailed = data?.rosterFailed === true
  const loading = isRconConnected && isPending

  /**
   * 刷新：重取快照。
   *
   * 乐观值在**这一轮重取结束时无条件清掉**，不看成败：它没有 TTL，只活在「提交成功 →
   * 服务端值回来」这段窗口里；重取失败时若把它留着，下一次能渲染出列表的时候（缓存里的
   * 旧数据、或别处触发的重取）它就会顶替服务端值，成为一条没人验证过的事实。
   */
  const reload = useCallback(async () => {
    try {
      await refetch()
    } finally {
      setOptimistic(new Map())
    }
  }, [refetch])

  /** 行数据 + 文案：文案表里没有的规则显示原始名，分类落「其他」 */
  const rows = useMemo(
    () =>
      rules.map((rule) => {
        const def = copy.get(rule.name.toLowerCase())
        return { rule, def, category: def?.category ?? '' }
      }),
    [rules, copy],
  )

  /** 分类 chips：全部 + 当前名单里出现过的分类（按首现顺序） */
  const categories = useMemo(() => {
    const seen: string[] = []
    for (const row of rows) {
      if (!seen.includes(row.category)) seen.push(row.category)
    }
    return seen
  }, [rows])

  /** 搜索（原始名 + 描述）+ 分类过滤：无文案的规则仍按名字命中，不因此被藏掉 */
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter((row) => {
      if (category !== 'all' && row.category !== category) return false
      if (q.length === 0) return true
      return (
        row.rule.name.toLowerCase().includes(q) ||
        (row.def?.desc.toLowerCase().includes(q) ?? false)
      )
    })
  }, [rows, category, search])

  /** 进入/更新行编辑态：点控件即编辑（Tasteful Friction） */
  const handleRowChange = (name: string, next: string) => {
    setEdit({ name, draft: next })
  }

  /** 确认保存：下发命令 → 乐观写值 + toast → 重取一次当前值；失败回滚并给友好错误 */
  const commitSave = async () => {
    if (!edit) return
    const { name, draft } = edit
    setSavingName(name)
    try {
      await onSendCommand(buildGameruleSetCommand(name, draft))
      setOptimistic((prev) => new Map(prev).set(name, draft))
      setEdit(null)
      toast.success(`已更新规则 ${name} = ${draft}`)
      await reload()
    } catch (e) {
      setEdit(null)
      toast.error(`规则更新失败：${friendlyError(e)}`)
    } finally {
      setSavingName(null)
    }
  }

  const controlsDisabled = !isRconConnected || savingName !== null
  // 通道断开时丢弃编辑态（推导而非在 effect 里 setState）：留着草稿等于让用户对着一条改不动的行输入
  const activeEdit = isRconConnected ? edit : null
  const sourceLabel = data?.source === 'msmp' ? 'MSMP' : data?.source === 'rcon' ? 'RCON' : null

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {/* ── 头部：标题 + 取值通道 + 刷新 ── */}
      <div className="flex items-center gap-2">
        <span className="text-mcs-sm font-semibold text-mcs-text-default">游戏规则</span>
        {/* 徽章说的是取值通道（MSMP / RCON）而非版本：名单由服务器自述，版本不决定显示
            哪些行；通道决定的是「读不到时该重试还是该换个通道」，对排障才有用 */}
        {sourceLabel !== null && (
          <StatusPill tone={data?.source === 'msmp' ? 'accent' : 'muted'} className="text-mcs-2xs">
            {sourceLabel}
          </StatusPill>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={() => void reload()}
          disabled={loading || isFetching || !isRconConnected}
          aria-label="刷新规则"
        >
          <RefreshCw aria-hidden />
          刷新
        </Button>
      </div>

      {/* ── 通道不可用：不发请求，也不显示任何默认值 ── */}
      {!isRconConnected && (
        <NoticeBanner variant="info" icon={Plug}>
          gamerule 修改需要 RCON 连接
        </NoticeBanner>
      )}

      {/* ── 读不到：三种成因分开说，都不回退默认值 ──
           请求失败＝这次取数没成；source='none'＝两条通道都不可用；rosterFailed＝通道通、
           但名单这一问没答上来。三者都空 rules，处置却不同（查连接 vs 重试），压成一句就是
           把「名单超时」报成「连不上」——那是假结论 */}
      {isRconConnected && (isError || sourceNone || rosterFailed) && (
        <NoticeBanner variant="warning" icon={AlertTriangle}>
          <span className="flex items-center justify-between gap-3">
            <span className="min-w-0">
              {rosterFailed && !isError && !sourceNone
                ? '未能读取规则名单，可点重试'
                : isError
                  ? `未能读取当前值：${friendlyError(error)}`
                  : '未能读取当前值：命令通道与推送通道都不可用'}
            </span>
            <NoticeBannerAction onClick={() => void reload()} disabled={isFetching}>
              <RefreshCw className="size-3" aria-hidden />
              重试
            </NoticeBannerAction>
          </span>
        </NoticeBanner>
      )}

      {/* ── 搜索 + 分类 FilterChip ── */}
      {isRconConnected && !sourceNone && !rosterFailed && !isError && (
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
      )}

      {/* ── 生效方式说明（与属性面板同一口径：一行说清「改了要不要重启」）──
             gamerule 经 RCON 命令作用于运行中的服务器，全部即时生效，无逐项例外 */}
      <p className="text-mcs-xs text-mcs-text-muted">规则修改保存后即时生效，无需重启实例</p>

      {/* ── 规则列表 ── */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div
            data-testid="gamerule-skeletons"
            className="flex flex-col gap-1.5"
            aria-label="加载规则中"
          >
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : !isRconConnected || isError || sourceNone || rosterFailed ? null : filtered.length ===
          0 ? (
          <p className="py-8 text-center text-mcs-xs text-mcs-text-muted">
            {rows.length === 0 ? '未读取到任何规则' : '无匹配规则'}
          </p>
        ) : (
          <div className="flex flex-col">
            {filtered.map(({ rule, def }) => (
              <RuleRow
                key={rule.name}
                rule={rule}
                def={def}
                current={optimistic.get(rule.name) ?? rule.value}
                isEditing={activeEdit?.name === rule.name}
                draft={activeEdit?.name === rule.name ? activeEdit.draft : undefined}
                saving={savingName === rule.name}
                disabled={controlsDisabled}
                onChange={(v) => handleRowChange(rule.name, v)}
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
  rule,
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
  rule: GameruleEntry
  /** 文案（可选装饰）：查不到就是 undefined，此时只显示原始名 */
  def: GameruleDef | undefined
  /** 端点值；`missing` / `unreadable` 两态恒为 null */
  current: string | null
  isEditing: boolean
  draft: string | undefined
  saving: boolean
  disabled: boolean
  onChange: (v: string) => void
  onSave: () => void
  onCancel: () => void
}) {
  const isCurrent = rule.status === 'current' && current !== null
  const display = isEditing && draft !== undefined ? draft : (current ?? '')
  const type = ruleType(rule.type)
  // 取值越界在服务端是**静默成功**（越界回包不在失败短语表里）⇒ 必须在这里拦，
  // 否则界面报成功而服务器没改
  const valueError = isCurrent ? gameruleValueError({ name: rule.name, type }, display) : null

  return (
    <div
      data-testid={`gamerule-row-${rule.name}`}
      data-rule-status={rule.status}
      className="flex items-center gap-3 border-b border-mcs-border-subtle px-2 py-1.5 last:border-b-0"
    >
      <span
        className="w-56 shrink-0 truncate font-mono text-mcs-xs text-mcs-text-default"
        title={rule.name}
      >
        {rule.name}
      </span>
      {/* 描述来自文案表（多为整句，最长 130+ 字），按「句子最低 xs」取 12px；
          无文案的规则由原始名承担辨识，这一列留空而不是填一个猜的说明 */}
      {valueError !== null ? (
        // 顶替描述行而不是另起一行：行高与列结构不变，且这条原因比描述此刻更要紧（描述仍在 title 里）
        <span
          role="alert"
          className="min-w-0 flex-1 truncate text-mcs-xs text-mcs-error-fg"
          title={valueError}
        >
          {valueError}
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate text-mcs-xs text-mcs-text-muted" title={def?.desc}>
          {def?.desc ?? ''}
        </span>
      )}

      <div className="flex w-44 shrink-0 items-center justify-end">
        {isCurrent ? (
          type === 'bool' ? (
            <Switch
              checked={display === 'true'}
              disabled={disabled || saving}
              onCheckedChange={(checked) => onChange(checked ? 'true' : 'false')}
              aria-label={`${rule.name} 开关`}
            />
          ) : (
            <Input
              type="text"
              inputMode="numeric"
              value={display}
              disabled={disabled || saving}
              onChange={(e) => onChange(e.target.value)}
              className="h-7 w-24 font-mono"
              aria-label={`${rule.name} 值`}
              aria-invalid={valueError !== null}
            />
          )
        ) : (
          /* 未读取：不渲染值控件（开关的「关」与输入框里的数字都会被读成事实）。
             解释挂在 InfoHint inline 上而不是裸 title：title 对触屏不响应、键盘也聚焦不到，
             而「为什么读不到」正是用户下一步动作（重试 / 换版本 / 等连接）的唯一依据 */
          <InfoHint
            variant="inline"
            label={`${rule.name} 未读取原因`}
            term={
              <StatusPill tone="muted" className="text-mcs-2xs">
                未读取
              </StatusPill>
            }
          >
            {UNREAD_REASON[rule.status === 'missing' ? 'missing' : 'unreadable']}
          </InfoHint>
        )}
      </div>

      {/* 行尾保存/取消（编辑态出现；Tasteful Friction） */}
      {isEditing && (
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="sm" className="px-2" onClick={onCancel} disabled={saving}>
            <X aria-hidden />
            取消
          </Button>
          <Button
            size="sm"
            className="px-2"
            onClick={onSave}
            disabled={saving || valueError !== null}
          >
            <Check aria-hidden />
            保存
          </Button>
        </div>
      )}
    </div>
  )
}
