/**
 * WebhookPage —— Webhook 外部通知管理
 * - 列表行仅保留启用开关（Switch 直切），点击名称行打开设置弹窗
 * - 设置弹窗：配置表单 + 投递操作区（测试投递 / 投递日志 / 删除）
 * - 投递日志每条可展开：发送内容（事件 payload）+ 响应体摘要（截断 200 字符）
 * - 删除确认（ConfirmDialog 危险样式）
 * - 加载骨架行 + 空态 + Toast 反馈
 */
import { useState } from 'react'
import {
  Plus,
  Send,
  Trash2,
  Webhook as WebhookIcon,
  Hourglass,
  RefreshCw,
  AlertTriangle,
} from 'lucide-react'
import { toast } from 'sonner'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useConnectionStore } from '@/stores/connection'
import { formatDateTime } from '@/lib/format'
import { useRadioGroup } from '@/hooks/use-radio-group'
import {
  apiGetWebhooks,
  apiGetWebhookEventTypes,
  apiCreateWebhook,
  apiUpdateWebhook,
  apiDeleteWebhook,
  apiTestWebhook,
  apiGetWebhookDeliveries,
} from '@/api/webhooks'
import { queryKeys } from '@/api/queries'
import { getFriendlyErrorText } from '@/api/errors'
import { queryPhase } from '@/lib/query-phase'
import type { Webhook, WebhookCreatePayload, WebhookDelivery } from '@/api/types'
import { Button } from '@/components/ui/button'
import { LoadingButton } from '@/components/mcs/loading-button'
import { Input } from '@/components/ui/input'
import { PasswordInput } from '@/components/ui/password-input'
import { Switch } from '@/components/ui/switch'
import { StatusPill } from '@/components/mcs/status-pill'
import { CountBadge } from '@/components/mcs/count-badge'
import { Card } from '@/components/mcs/card'
import { Skeleton } from '@/components/ui/skeleton'
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'
import { PageHeader } from '@/components/mcs/page-header'
import { EmptyState } from '@/components/mcs/empty-state'
import { StaleQueryNotice } from '@/components/mcs/data-states'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { TONE_SELECTED_CLASSES } from '@/components/mcs/tone'
import { NoticeBanner } from '@/components/mcs/notice-banner'

const EVENT_LABELS: Record<string, string> = {
  'player.join': '玩家加入',
  'player.leave': '玩家离开',
  'player.death': '玩家死亡',
  'player.respawn': '玩家重生',
  'player.chat': '玩家聊天',
  'player.sleep': '玩家睡觉',
  'player.achievement': '玩家成就',
  'instance.start': '实例启动',
  'instance.stop': '实例停止',
  'instance.crash': '实例崩溃',
  'instance.ready': '实例就绪',
  'instance.save': '实例保存',
  'instance.restart': '实例重启',
  'backup.create': '备份创建',
  'backup.restore': '备份恢复',
  'backup.delete': '备份删除',
  'server.start': '面板启动',
  'server.shutdown': '面板关闭',
  ping: 'Ping 测试',
}

/** 国内渠道预设：选中后 URL 提示与密钥字段语义随平台联动（投递格式由服务端按 platform 分发） */
const PLATFORM_PRESETS: Array<{
  key: WebhookCreatePayload['platform'] & string
  label: string
  urlPlaceholder: string
  secretLabel: string
  secretPlaceholder: string
}> = [
  {
    key: 'generic',
    label: '通用',
    urlPlaceholder: 'https://example.com/webhook',
    secretLabel: 'HMAC 密钥（留空不签名）',
    secretPlaceholder: '可选',
  },
  {
    key: 'feishu',
    label: '飞书',
    urlPlaceholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/…',
    secretLabel: '签名密钥（飞书机器人「签名校验」密钥，留空不签名）',
    secretPlaceholder: '可选',
  },
  {
    key: 'dingtalk',
    label: '钉钉',
    urlPlaceholder: 'https://oapi.dingtalk.com/robot/send?access_token=…',
    secretLabel: '加签密钥（钉钉机器人「加签」SEC 开头密钥，留空不加签）',
    secretPlaceholder: '可选',
  },
  {
    key: 'wecom',
    label: '企业微信',
    urlPlaceholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…',
    secretLabel: '企业微信机器人无需密钥',
    secretPlaceholder: '无需填写',
  },
  {
    key: 'serverchan',
    label: 'Server酱',
    urlPlaceholder: 'https://sctapi.ftqq.com/你的SendKey.send',
    secretLabel: 'Server酱无需密钥（SendKey 已含在 URL 中）',
    secretPlaceholder: '无需填写',
  },
  {
    key: 'pushplus',
    label: 'PushPlus',
    urlPlaceholder: 'https://www.pushplus.plus/send',
    secretLabel: 'PushPlus token（必填，发送凭证）',
    secretPlaceholder: '必填',
  },
] as const

function platformPreset(platform: string | undefined) {
  // generic 预设常驻清单首位；未命中（异常值）时兜底 generic 行
  return PLATFORM_PRESETS.find((p) => p.key === platform) ?? PLATFORM_PRESETS[0]!
}

/** 密钥需遮蔽的渠道（企业微信/Server酱无需密钥、PushPlus token 走明文便于核对） */
const MASKED_SECRET_PLATFORMS = ['generic', 'feishu', 'dingtalk']

function fmtEvt(t: string) {
  return EVENT_LABELS[t] || t
}

/** 响应体摘要截断（验收上限 200 字符）；null/纯空白视为无响应体 */
export function truncateResponseBody(body: string | null | undefined, max = 200): string | null {
  if (body == null || body.trim() === '') return null
  return body.length > max ? `${body.slice(0, max)}…` : body
}

export default function WebhookPage() {
  const config = useConnectionStore()
  const qc = useQueryClient()
  const [showDialog, setShowDialog] = useState(false)
  const [editTarget, setEditTarget] = useState<Webhook | null>(null)
  // 投递日志展开（设置弹窗内，按日志条目 id）
  const [expandedDeliveryId, setExpandedDeliveryId] = useState<number | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Webhook | null>(null)
  const [form, setForm] = useState({
    name: '',
    url: '',
    secret: '',
    platform: 'generic' as string,
    events: [] as string[],
    isEnabled: true,
  })
  const [initialForm, setInitialForm] = useState({
    name: '',
    url: '',
    secret: '',
    platform: 'generic' as string,
    events: [] as string[],
    isEnabled: true,
  })
  const [dialogDirtyConfirm, setDialogDirtyConfirm] = useState(false)
  // 渠道预设单选组接线（roving tabindex + 方向键移动即选中、焦点跟随）统一走
  // useRadioGroup，与 onboarding 部署方式、J55 批次的 17 组共用同一键盘模型。
  // 异常值兜底（platform 不在清单内）：停靠点落首项但不谎报选中——hook 内建该归一
  const { groupProps, itemProps } = useRadioGroup<string>({
    label: 'Webhook 渠道预设',
    value: form.platform,
    values: PLATFORM_PRESETS.map((p) => p.key),
    onChange: (key) => setForm((f) => ({ ...f, platform: key })),
  })
  const urlInvalid =
    form.url !== '' && !form.url.startsWith('http://') && !form.url.startsWith('https://')
  const formDirty =
    form.name !== initialForm.name ||
    form.url !== initialForm.url ||
    form.secret !== initialForm.secret ||
    form.platform !== initialForm.platform ||
    form.isEnabled !== initialForm.isEnabled ||
    JSON.stringify(form.events) !== JSON.stringify(initialForm.events)

  const webhooksQuery = useQuery({
    queryKey: queryKeys.webhooks(),
    queryFn: ({ signal }) => apiGetWebhooks(config, 1, 100, signal),
    enabled: config.status === 'ready',
  })
  const { data: webhooksData, isLoading, error, refetch } = webhooksQuery
  /** 列表相位：有旧值可留时不把一次轮询抖动呈现成整屏故障 */
  const webhooksPhase = queryPhase(webhooksQuery)
  const {
    data: eventTypes,
    isError: eventTypesError,
    refetch: refetchEventTypes,
  } = useQuery({
    queryKey: [...queryKeys.webhooks(), 'event-types'],
    queryFn: ({ signal }) => apiGetWebhookEventTypes(config, signal),
    enabled: config.status === 'ready',
    staleTime: Infinity,
  })
  // 投递日志随设置弹窗加载（编辑态才有目标 webhook）
  const {
    data: deliveriesData,
    isLoading: deliveriesLoading,
    isError: deliveriesError,
    refetch: refetchDeliveries,
  } = useQuery({
    queryKey: queryKeys.webhookDeliveries(editTarget?.id ?? -1),
    queryFn: ({ signal }) => apiGetWebhookDeliveries(config, editTarget!.id, 1, 10, signal),
    enabled: showDialog && editTarget != null && config.status === 'ready',
  })

  const createMut = useMutation({
    mutationFn: (d: Parameters<typeof apiCreateWebhook>[1]) => apiCreateWebhook(config, d),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.webhooks() })
      closeDialog()
      toast.success('Webhook 已创建')
    },
    onError: (e) => toast.error(`创建失败：${getFriendlyErrorText(e)}`),
  })
  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Parameters<typeof apiUpdateWebhook>[2] }) =>
      apiUpdateWebhook(config, id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.webhooks() })
      closeDialog()
      toast.success('Webhook 已更新')
    },
    onError: (e) => toast.error(`更新失败：${getFriendlyErrorText(e)}`),
  })
  // 列表行启用开关直切（与编辑保存分离：文案与 in-flight 状态互不干扰）
  const toggleMut = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      apiUpdateWebhook(config, id, { isEnabled: enabled }),
    // 与同页其余写操作（创建/更新/删除/测试投递）同级别：成功也给回执，不静默
    onSuccess: (_data, { enabled }) => {
      qc.invalidateQueries({ queryKey: queryKeys.webhooks() })
      toast.success(enabled ? 'Webhook 已启用' : 'Webhook 已停用')
    },
    onError: (e) => toast.error(`切换启用状态失败：${getFriendlyErrorText(e)}`),
  })
  const deleteMut = useMutation({
    mutationFn: (id: number) => apiDeleteWebhook(config, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.webhooks() })
      toast.success('Webhook 已删除')
      // 删除入口在设置弹窗内：成功即关闭弹窗回到列表
      closeDialog()
    },
    onError: (e) => toast.error(`删除失败：${getFriendlyErrorText(e)}`),
  })
  const testMut = useMutation({
    mutationFn: (id: number) => apiTestWebhook(config, id),
    onSuccess: (data) => toast.success(`测试投递成功 HTTP ${data.statusCode}`),
    onError: (e) => toast.error(`测试投递失败：${getFriendlyErrorText(e)}`),
    onSettled: (_data, _error, id) => {
      // 测试投递已落投递历史（服务端 event_type=ping 记录，成败均落库）：
      // 无论成败都失效对应缓存——面板已展开则即时刷新可见，未展开则下次展开取新数据
      if (id != null) qc.invalidateQueries({ queryKey: queryKeys.webhookDeliveries(id) })
    },
  })

  const openCreate = () => {
    setEditTarget(null)
    const f = {
      name: '',
      url: '',
      secret: '',
      platform: 'generic',
      events: [] as string[],
      isEnabled: true,
    }
    setForm(f)
    setInitialForm(f)
    setShowDialog(true)
  }
  const openEdit = (w: Webhook) => {
    setEditTarget(w)
    const f = {
      name: w.name,
      url: w.url,
      secret: '',
      platform: w.platform ?? 'generic',
      events: [...w.events],
      isEnabled: w.isEnabled,
    }
    setForm(f)
    setInitialForm(f)
    setExpandedDeliveryId(null)
    setShowDialog(true)
  }
  const closeDialog = () => {
    setShowDialog(false)
    setEditTarget(null)
    setForm({ name: '', url: '', secret: '', platform: 'generic', events: [], isEnabled: true })
    setInitialForm({
      name: '',
      url: '',
      secret: '',
      platform: 'generic',
      events: [],
      isEnabled: true,
    })
  }
  const tryCloseDialog = () => {
    if (formDirty) {
      setDialogDirtyConfirm(true)
    } else {
      closeDialog()
    }
  }
  const toggleEvent = (evt: string) =>
    setForm((f) => ({
      ...f,
      events: f.events.includes(evt) ? f.events.filter((e) => e !== evt) : [...f.events, evt],
    }))
  const selectAll = () => {
    if (eventTypes && form.events.length === eventTypes.length)
      setForm((f) => ({ ...f, events: [] }))
    else if (eventTypes) setForm((f) => ({ ...f, events: [...eventTypes] }))
  }
  const handleSubmit = () => {
    // PushPlus 的 token 是发送凭证（走 secret 字段），缺失时投递必被拒——创建/首次配置即拦截
    if (
      form.platform === 'pushplus' &&
      !form.secret &&
      !(editTarget && editTarget.platform === 'pushplus')
    ) {
      toast.error('PushPlus 需要填写 token（发送凭证）')
      return
    }
    const payload: WebhookCreatePayload = {
      name: form.name,
      url: form.url,
      platform: form.platform as WebhookCreatePayload['platform'],
      events: form.events,
      isEnabled: form.isEnabled,
    }
    if (form.secret) payload.secret = form.secret
    if (editTarget) updateMut.mutate({ id: editTarget.id, data: payload })
    else createMut.mutate(payload)
  }

  const handleDeleteConfirm = () => {
    if (!deleteTarget) return
    const id = deleteTarget.id
    setDeleteTarget(null)
    deleteMut.mutate(id)
  }

  const webhooks = webhooksData?.data ?? []
  const deliveries = deliveriesData?.data ?? []
  const testingId = testMut.isPending ? testMut.variables : null

  if (config.status !== 'ready') return null

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4">
      <PageHeader
        title="Webhook 外部通知"
        description="配置外部通知通道，接收服务器事件推送"
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void qc.invalidateQueries({ queryKey: queryKeys.webhooks() })}
              disabled={isLoading}
            >
              <RefreshCw className={isLoading ? 'animate-spin' : ''} aria-hidden />
              刷新
            </Button>
            <Button
              size="sm"
              onClick={openCreate}
              disabled={createMut.isPending || updateMut.isPending}
            >
              <Plus aria-hidden />
              新建 Webhook
            </Button>
          </div>
        }
      />

      {/* ── 错误提示 ── */}
      {error && (
        <NoticeBanner variant="error" icon={AlertTriangle} role="alert">
          {getFriendlyErrorText(error)}
        </NoticeBanner>
      )}

      {/* ── 列表容器 ── */}
      <Card as="div" className="min-h-0 flex-1 overflow-hidden">
        {webhooksPhase === 'stale' && (
          <StaleQueryNotice
            className="m-2"
            error={webhooksQuery.error}
            onRetry={() => void webhooksQuery.refetch()}
          />
        )}
        {isLoading ? (
          /* 骨架行 */
          <div
            data-testid="webhook-skeletons"
            className="space-y-1 p-4"
            aria-label="加载 Webhook 中"
          >
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="flex items-center gap-3 py-2">
                <Skeleton className="size-9 shrink-0" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-1/4" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
                <div className="flex gap-1">
                  <Skeleton className="size-8" />
                  <Skeleton className="size-8" />
                </div>
              </div>
            ))}
          </div>
        ) : webhooksPhase === 'failed' ? (
          /* 加载失败态（优先于空态：避免错误信息与「暂无 Webhook」混排误导） */
          <EmptyState
            icon={AlertTriangle}
            title="加载失败"
            hint={`无法获取 Webhook 列表：${getFriendlyErrorText(error)}`}
            action={{ label: '重试', onClick: () => void refetch() }}
          />
        ) : webhooks.length === 0 ? (
          /* 空态（EmptyState 统一组件；绿实底 CTA 为页面主行动） */
          <EmptyState
            icon={WebhookIcon}
            title="暂无 Webhook"
            hint="点击新建添加外部通知通道"
            action={{ label: '新建 Webhook', onClick: openCreate }}
            actionVariant="greenFilled"
          />
        ) : (
          <div className="divide-y divide-mcs-border-subtle">
            {webhooks.map((w: Webhook) => (
              <div key={w.id} className="flex items-center gap-3 px-4 py-3">
                {/* 行主体=设置入口（弹窗含测试/日志/删除）；行内独立控件仅剩启用开关 */}
                <button
                  type="button"
                  className="min-w-0 flex-1 cursor-pointer rounded-mcs-xs py-1 text-left hover:bg-mcs-state-hover focus-visible:bg-mcs-state-focus"
                  aria-haspopup="dialog"
                  aria-label={`设置 ${w.name}`}
                  onClick={() => openEdit(w)}
                >
                  <span
                    className="block truncate text-mcs-sm font-semibold text-mcs-text-default"
                    title={w.name}
                  >
                    {w.name}
                  </span>
                  <p className="mt-1 truncate text-mcs-xs text-mcs-text-muted" title={w.url}>
                    {w.url}
                  </p>
                  {w.events.length > 0 && (
                    <span className="mt-1.5 flex flex-wrap gap-1">
                      {w.events.map((e) => (
                        <StatusPill key={e} variant="outline" className="text-mcs-2xs">
                          {fmtEvt(e)}
                        </StatusPill>
                      ))}
                    </span>
                  )}
                  {w.events.length === 0 && (
                    <p className="mt-1 text-mcs-2xs text-mcs-text-muted">订阅全部事件</p>
                  )}
                </button>
                <Switch
                  checked={w.isEnabled}
                  disabled={toggleMut.isPending}
                  aria-label={`${w.isEnabled ? '禁用' : '启用'} ${w.name}`}
                  onCheckedChange={() => toggleMut.mutate({ id: w.id, enabled: !w.isEnabled })}
                />
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* ── 新建/编辑对话框 ── */}
      <Dialog
        open={showDialog}
        onOpenChange={(open) => {
          if (!open) tryCloseDialog()
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editTarget ? '编辑 Webhook' : '新建 Webhook'}</DialogTitle>
            <DialogDescription>
              {editTarget ? '修改 Webhook 配置' : '创建新的外部通知通道'}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="webhook-name" className="text-mcs-xs text-mcs-text-muted">
                名称 *
              </Label>
              <Input
                id="webhook-name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Discord 通知"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-mcs-xs text-mcs-text-muted">渠道预设</Label>
              <div {...groupProps} className="flex flex-wrap gap-1">
                {PLATFORM_PRESETS.map((p, index) => (
                  <button
                    key={p.key}
                    type="button"
                    {...itemProps(index)}
                    onClick={() => setForm((f) => ({ ...f, platform: p.key }))}
                    className={cn(
                      'rounded-mcs-xs border px-2 py-0.5 text-mcs-2xs transition-colors cursor-pointer',
                      form.platform === p.key
                        ? TONE_SELECTED_CLASSES
                        : 'border-mcs-border-default text-mcs-text-muted hover:border-mcs-border-default hover:text-mcs-text-default',
                    )}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <p className="text-mcs-xs text-mcs-text-muted">
                {form.platform === 'generic'
                  ? '通用格式：适配 Discord 等自定义接收端，事件数据原样推送'
                  : `选中后按 ${platformPreset(form.platform).label} 官方格式签名与投递`}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="webhook-url" className="text-mcs-xs text-mcs-text-muted">
                URL *
              </Label>
              <Input
                id="webhook-url"
                value={form.url}
                onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
                placeholder={platformPreset(form.platform).urlPlaceholder}
                aria-invalid={urlInvalid}
              />
              {urlInvalid && (
                <p className="text-mcs-xs text-mcs-error-fg">URL 需以 http:// 或 https:// 开头</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="webhook-secret" className="text-mcs-xs text-mcs-text-muted">
                {platformPreset(form.platform).secretLabel}
              </Label>
              {/* 遮蔽态才挂显隐切换（签名密钥粘贴后无法自查）；明文态保持 Input，type 分支语义不变。
                  showCapsLock=false：密钥是粘贴而非键入，大写锁定提醒在此无意义 */}
              {MASKED_SECRET_PLATFORMS.includes(form.platform) ? (
                <PasswordInput
                  id="webhook-secret"
                  value={form.secret}
                  onChange={(v) => setForm((f) => ({ ...f, secret: v }))}
                  placeholder={
                    editTarget
                      ? '留空保持原密钥不变'
                      : platformPreset(form.platform).secretPlaceholder
                  }
                  showCapsLock={false}
                  revealLabels={{ show: '显示密钥', hide: '隐藏密钥' }}
                />
              ) : (
                <Input
                  id="webhook-secret"
                  value={form.secret}
                  onChange={(e) => setForm((f) => ({ ...f, secret: e.target.value }))}
                  type="text"
                  placeholder={
                    editTarget
                      ? '留空保持原密钥不变'
                      : platformPreset(form.platform).secretPlaceholder
                  }
                  disabled={form.platform === 'wecom' || form.platform === 'serverchan'}
                />
              )}
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Label className="text-mcs-xs text-mcs-text-muted">事件过滤</Label>
                  {/* 选中计数（CountBadge 计数口径）；0 时语义由下方「未选择 = 订阅全部事件」提示承担 */}
                  {form.events.length > 0 && (
                    <CountBadge className="text-mcs-2xs">已选 {form.events.length}</CountBadge>
                  )}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 text-mcs-2xs"
                  onClick={selectAll}
                >
                  {eventTypes && form.events.length === eventTypes.length ? '取消全选' : '全选'}
                </Button>
              </div>
              {eventTypesError && (
                <NoticeBanner variant="warning" icon={AlertTriangle}>
                  <span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <span>事件类型加载失败，无法勾选事件</span>
                    <Button size="xs" variant="outline" onClick={() => void refetchEventTypes()}>
                      重试
                    </Button>
                  </span>
                </NoticeBanner>
              )}
              <div className="flex flex-wrap gap-1">
                {eventTypes?.map((evt) => (
                  <button
                    key={evt}
                    type="button"
                    onClick={() => toggleEvent(evt)}
                    aria-pressed={form.events.includes(evt)}
                    className={cn(
                      'rounded-mcs-xs border px-2 py-0.5 text-mcs-2xs transition-colors cursor-pointer',
                      form.events.includes(evt)
                        ? TONE_SELECTED_CLASSES
                        : 'border-mcs-border-muted text-mcs-text-muted hover:border-mcs-border-default',
                    )}
                  >
                    {fmtEvt(evt)}
                  </button>
                ))}
              </div>
              <p className="text-mcs-2xs text-mcs-text-muted">未选择 = 订阅全部事件</p>
            </div>
            {/* 启用状态由列表行 Switch 承载，弹窗不再重复开关 */}
            {/* ── 投递操作区（仅编辑已有 webhook：测试 / 日志 / 删除）── */}
            {editTarget && (
              <div className="flex flex-col gap-2 border-t border-mcs-border-muted pt-3">
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-mcs-xs text-mcs-text-muted">投递操作</Label>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={testMut.isPending}
                      onClick={() => testMut.mutate(editTarget.id)}
                    >
                      {testingId === editTarget.id ? (
                        <Hourglass className="size-3.5 animate-spin" aria-hidden />
                      ) : (
                        <Send className="size-3.5" aria-hidden />
                      )}
                      测试投递
                    </Button>
                    <Button
                      variant="destructive-outline"
                      size="sm"
                      onClick={() => setDeleteTarget(editTarget)}
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                      删除
                    </Button>
                  </div>
                </div>
                <p className="text-mcs-2xs text-mcs-text-muted">投递日志</p>
                {deliveriesLoading ? (
                  <div className="space-y-1" aria-label="加载投递日志中">
                    {Array.from({ length: 3 }, (_, i) => (
                      <Skeleton key={i} className="h-7 w-full" />
                    ))}
                  </div>
                ) : deliveriesError ? (
                  <div className="flex flex-col items-start gap-1.5 py-1">
                    <p className="text-mcs-xs text-mcs-error-fg">
                      投递日志加载失败：{getFriendlyErrorText(deliveriesError)}
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 text-mcs-2xs"
                      onClick={() => void refetchDeliveries()}
                    >
                      <RefreshCw className="size-3" aria-hidden />
                      重试
                    </Button>
                  </div>
                ) : deliveries.length === 0 ? (
                  <p className="text-mcs-xs text-mcs-text-muted">暂无投递记录</p>
                ) : (
                  <div className="flex max-h-60 flex-col gap-1 overflow-y-auto">
                    {deliveries.map((d: WebhookDelivery) => {
                      const summary = truncateResponseBody(d.responseBody)
                      const sentSummary = truncateResponseBody(
                        d.payload != null ? JSON.stringify(d.payload, null, 2) : null,
                        400,
                      )
                      const deliveryExpanded = expandedDeliveryId === d.id
                      return (
                        <div key={d.id}>
                          <button
                            type="button"
                            className="flex w-full cursor-pointer items-center justify-between rounded-mcs-xs bg-mcs-bg-default px-2 py-1.5 text-left text-mcs-xs hover:bg-mcs-state-hover"
                            aria-expanded={deliveryExpanded}
                            onClick={() => setExpandedDeliveryId(deliveryExpanded ? null : d.id)}
                          >
                            <div>
                              <span className="font-medium text-mcs-text-default">
                                {fmtEvt(d.eventType)}
                              </span>
                              <span className="ml-2 text-mcs-text-muted">
                                {d.responseStatus ? String(d.responseStatus) : d.status}
                                {d.durationMs != null ? ` ${String(d.durationMs)}ms` : ''}
                                {d.attempts > 1 ? ` ${d.attempts}次` : ''}
                              </span>
                            </div>
                            <span
                              className={cn(
                                d.status === 'success'
                                  ? 'text-mcs-success-fg'
                                  : d.status === 'failed'
                                    ? 'text-mcs-error-fg'
                                    : 'text-mcs-text-muted',
                              )}
                            >
                              {formatDateTime(d.createdAt)}
                            </span>
                          </button>
                          {deliveryExpanded && (
                            <div className="mt-1 flex flex-col gap-1">
                              <p className="text-mcs-2xs font-medium text-mcs-text-muted">
                                发送内容
                              </p>
                              {sentSummary ? (
                                <pre
                                  data-testid={`delivery-payload-${d.id}`}
                                  className="max-h-40 whitespace-pre-wrap break-all overflow-y-auto rounded-mcs-xs bg-mcs-bg-subtle px-2 py-1.5 font-mono text-mcs-2xs text-mcs-text-muted"
                                >
                                  {sentSummary}
                                </pre>
                              ) : (
                                <p
                                  data-testid={`delivery-payload-${d.id}`}
                                  className="px-2 py-1 text-mcs-2xs text-mcs-text-muted"
                                >
                                  无发送内容
                                </p>
                              )}
                              <p className="text-mcs-2xs font-medium text-mcs-text-muted">
                                响应内容
                              </p>
                              {summary ? (
                                <pre
                                  data-testid={`delivery-response-${d.id}`}
                                  className="whitespace-pre-wrap break-all rounded-mcs-xs bg-mcs-bg-subtle px-2 py-1.5 font-mono text-mcs-2xs text-mcs-text-muted"
                                >
                                  {summary}
                                </pre>
                              ) : (
                                <p
                                  data-testid={`delivery-response-${d.id}`}
                                  className="px-2 py-1 text-mcs-2xs text-mcs-text-muted"
                                >
                                  无响应体
                                </p>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={tryCloseDialog}>
              取消
            </Button>
            <LoadingButton
              loading={createMut.isPending || updateMut.isPending}
              loadingText="处理中…"
              onClick={handleSubmit}
              disabled={!form.name || !form.url || urlInvalid}
            >
              {editTarget ? '保存' : '创建'}
            </LoadingButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── 删除确认 ── */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={`删除 Webhook 「${deleteTarget?.name ?? ''}」？`}
        description={`确定要删除 Webhook 「${deleteTarget?.name ?? ''}」吗？删除后将停止该通道的所有事件推送。`}
        confirmText="删除"
        danger
        warning="此操作不可撤销"
        loading={deleteMut.isPending}
        onConfirm={() => void handleDeleteConfirm()}
      />

      {/* ── 脏状态关闭确认 ── */}
      <ConfirmDialog
        open={dialogDirtyConfirm}
        onOpenChange={(open) => !open && setDialogDirtyConfirm(false)}
        title="未保存的更改"
        description="当前有未保存的 Webhook 更改，关闭后这些修改将丢失。"
        confirmText="不保存"
        cancelText="继续编辑"
        onConfirm={() => {
          setDialogDirtyConfirm(false)
          closeDialog()
        }}
      />
    </div>
  )
}
