/**
 * WebhookPage —— Webhook 外部通知管理
 * - 列表展示（卡片行：名称/状态/URL/事件标签/操作按钮）
 * - 新建/编辑对话框（shadcn Dialog）
 * - 删除确认（ConfirmDialog 危险样式）
 * - 投递日志展开行（行内点击查看响应体摘要，截断 200 字符）
 * - 加载骨架行 + 空态 + Toast 反馈
 */
import { useState } from 'react'
import { Plus, Send, Pencil, Trash2, ChevronDown, Webhook as WebhookIcon, Hourglass, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useConnectionStore } from '@/stores/connection'
import {
  apiGetWebhooks, apiGetWebhookEventTypes, apiCreateWebhook,
  apiUpdateWebhook, apiDeleteWebhook, apiTestWebhook, apiGetWebhookDeliveries,
} from '@/api/webhooks'
import { queryKeys } from '@/api/queries'
import { getFriendlyErrorText } from '@/api/errors'
import type { Webhook, WebhookCreatePayload, WebhookDelivery } from '@/api/types'
import { Button } from '@/components/ui/button'
import { LoadingButton } from '@/components/mcs/loading-button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { StatusPill } from '@/components/mcs/status-pill'
import { Skeleton } from '@/components/ui/skeleton'
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'
import { PageHeader } from '@/components/mcs/page-header'
import { EmptyState } from '@/components/mcs/empty-state'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

const EVENT_LABELS: Record<string, string> = {
  'player.join': '玩家加入', 'player.leave': '玩家离开', 'player.death': '玩家死亡',
  'player.respawn': '玩家重生', 'player.chat': '玩家聊天', 'player.sleep': '玩家睡觉',
  'player.achievement': '玩家成就', 'instance.start': '实例启动', 'instance.stop': '实例停止',
  'instance.crash': '实例崩溃', 'instance.ready': '实例就绪', 'instance.save': '实例保存',
  'instance.restart': '实例重启', 'backup.create': '备份创建', 'backup.restore': '备份恢复',
  'backup.delete': '备份删除', 'server.start': '面板启动', 'server.shutdown': '面板关闭', 'ping': 'Ping 测试',
}

function fmtEvt(t: string) { return EVENT_LABELS[t] || t }
function fmtTime(iso: string) { return new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) }

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
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [expandedDeliveryId, setExpandedDeliveryId] = useState<number | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Webhook | null>(null)
  const [form, setForm] = useState({ name: '', url: '', secret: '', events: [] as string[], isEnabled: true })
  const [initialForm, setInitialForm] = useState({ name: '', url: '', secret: '', events: [] as string[], isEnabled: true })
  const [dialogDirtyConfirm, setDialogDirtyConfirm] = useState(false)
  const urlInvalid = form.url !== '' && !form.url.startsWith('http://') && !form.url.startsWith('https://')
  const formDirty = form.name !== initialForm.name || form.url !== initialForm.url || form.secret !== initialForm.secret
    || form.isEnabled !== initialForm.isEnabled || JSON.stringify(form.events) !== JSON.stringify(initialForm.events)

  const { data: webhooksData, isLoading, error } = useQuery({
    queryKey: queryKeys.webhooks(),
    queryFn: ({ signal }) => apiGetWebhooks(config, 1, 100, signal),
    enabled: config.status === 'ready',
  })
  const { data: eventTypes } = useQuery({
    queryKey: [...queryKeys.webhooks(), 'event-types'],
    queryFn: ({ signal }) => apiGetWebhookEventTypes(config, signal),
    enabled: config.status === 'ready', staleTime: Infinity,
  })
  const { data: deliveriesData, isLoading: deliveriesLoading } = useQuery({
    queryKey: queryKeys.webhookDeliveries(expandedId ?? -1),
    queryFn: ({ signal }) => apiGetWebhookDeliveries(config, expandedId!, 1, 10, signal),
    enabled: expandedId != null && config.status === 'ready',
  })

  const createMut = useMutation({
    mutationFn: (d: Parameters<typeof apiCreateWebhook>[1]) => apiCreateWebhook(config, d),
    onSuccess: () => { qc.invalidateQueries({ queryKey: queryKeys.webhooks() }); closeDialog(); toast.success('Webhook 已创建') },
    onError: (e) => toast.error(`创建失败：${getFriendlyErrorText(e)}`),
  })
  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Parameters<typeof apiUpdateWebhook>[2] }) => apiUpdateWebhook(config, id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: queryKeys.webhooks() }); closeDialog(); toast.success('Webhook 已更新') },
    onError: (e) => toast.error(`更新失败：${getFriendlyErrorText(e)}`),
  })
  const deleteMut = useMutation({
    mutationFn: (id: number) => apiDeleteWebhook(config, id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: queryKeys.webhooks() }); toast.success('Webhook 已删除') },
    onError: (e) => toast.error(`删除失败：${getFriendlyErrorText(e)}`),
  })
  const testMut = useMutation({
    mutationFn: (id: number) => apiTestWebhook(config, id),
    onSuccess: (data) => toast.success(`测试投递成功 HTTP ${data.statusCode}`),
    onError: (e) => toast.error(`测试投递失败：${getFriendlyErrorText(e)}`),
  })

  const openCreate = () => { setEditTarget(null); const f = { name: '', url: '', secret: '', events: [] as string[], isEnabled: true }; setForm(f); setInitialForm(f); setShowDialog(true) }
  const openEdit = (w: Webhook) => { setEditTarget(w); const f = { name: w.name, url: w.url, secret: '', events: [...w.events], isEnabled: w.isEnabled }; setForm(f); setInitialForm(f); setShowDialog(true) }
  const closeDialog = () => { setShowDialog(false); setEditTarget(null); setForm({ name: '', url: '', secret: '', events: [], isEnabled: true }); setInitialForm({ name: '', url: '', secret: '', events: [], isEnabled: true }) }
  const tryCloseDialog = () => { if (formDirty) { setDialogDirtyConfirm(true) } else { closeDialog() } }
  const toggleEvent = (evt: string) => setForm(f => ({ ...f, events: f.events.includes(evt) ? f.events.filter(e => e !== evt) : [...f.events, evt] }))
  const selectAll = () => { if (eventTypes && form.events.length === eventTypes.length) setForm(f => ({ ...f, events: [] })); else if (eventTypes) setForm(f => ({ ...f, events: [...eventTypes] })) }
  const handleSubmit = () => {
    const payload: WebhookCreatePayload = { name: form.name, url: form.url, events: form.events, isEnabled: form.isEnabled }
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
            <Button variant="outline" size="sm" onClick={() => void qc.invalidateQueries({ queryKey: queryKeys.webhooks() })} disabled={isLoading}>
              <RefreshCw className={isLoading ? 'animate-spin' : ''} aria-hidden />
              刷新
            </Button>
            <Button size="sm" onClick={openCreate} disabled={createMut.isPending || updateMut.isPending}>
              <Plus aria-hidden />
              新建 Webhook
            </Button>
          </div>
        }
      />

      {/* ── 错误提示 ── */}
      {error && (
        <div className="rounded-mcs-sm border border-mcs-error-border bg-mcs-error-bg-subtle px-3 py-2 text-mcs-sm text-mcs-error-fg">
          {getFriendlyErrorText(error)}
        </div>
      )}

      {/* ── 列表容器 ── */}
      <div className="min-h-0 flex-1 overflow-hidden rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-muted">
        {isLoading ? (
          /* 骨架行 */
          <div data-testid="webhook-skeletons" className="space-y-1 p-4" aria-label="加载 Webhook 中">
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
              <div key={w.id} className="px-4 py-3">
                <div className="flex items-center gap-3">
                  {/* 名称 + 状态 + URL + 事件 */}
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-mcs-sm font-semibold text-mcs-text-default" title={w.name}>{w.name}</span>
                      <StatusPill
                        tone={w.isEnabled ? 'success' : 'muted'}
                        className="text-mcs-xs"
                      >
                        {w.isEnabled ? '启用' : '禁用'}
                      </StatusPill>
                    </div>
                    <p className="mt-1 truncate text-mcs-xs text-mcs-text-muted" title={w.url}>{w.url}</p>
                    {w.events.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {w.events.map(e => (
                          <StatusPill key={e} variant="outline" className="text-mcs-2xs">
                            {fmtEvt(e)}
                          </StatusPill>
                        ))}
                      </div>
                    )}
                    {w.events.length === 0 && (
                      <p className="mt-1 text-mcs-2xs text-mcs-text-subtle">订阅全部事件</p>
                    )}
                  </div>

                  {/* 操作按钮 */}
                  <div className="flex shrink-0 items-center gap-0.5">
                    <Button
                      variant="ghost" size="icon-sm"
                      disabled={testMut.isPending}
                      aria-label={`测试 ${w.name}`}
                      className="text-mcs-accent-fg"
                      onClick={() => testMut.mutate(w.id)}
                    >
                      {testingId === w.id ? <Hourglass className="size-3.5 animate-spin" aria-hidden /> : <Send className="size-3.5" aria-hidden />}
                    </Button>
                    <Button
                      variant="ghost" size="icon-sm"
                      aria-label={`${w.name} 投递日志`}
                      className="text-mcs-text-muted hover:text-mcs-text-default"
                      onClick={() => { setExpandedId(expandedId === w.id ? null : w.id); setExpandedDeliveryId(null) }}
                    >
                      <ChevronDown className={cn("size-3.5 transition-transform", expandedId === w.id && "rotate-180")} aria-hidden />
                    </Button>
                    <Button
                      variant="ghost" size="icon-sm"
                      aria-label={`编辑 ${w.name}`}
                      className="text-mcs-text-muted hover:text-mcs-text-default"
                      onClick={() => openEdit(w)}
                    >
                      <Pencil className="size-3.5" aria-hidden />
                    </Button>
                    <Button
                      variant="ghost" size="icon-sm"
                      aria-label={`删除 ${w.name}`}
                      className="text-mcs-error-fg hover:bg-mcs-error-bg-subtle hover:text-mcs-error-fg"
                      onClick={() => setDeleteTarget(w)}
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                    </Button>
                  </div>
                </div>

                {/* 投递日志展开 */}
                {expandedId === w.id && (
                  <div className="mt-3 border-t border-mcs-border-subtle pt-3">
                    <p className="mb-2 text-mcs-xs font-semibold text-mcs-text-default">投递日志</p>
                    {deliveriesLoading ? (
                      <div className="space-y-1" aria-label="加载投递日志中">
                        {Array.from({ length: 3 }, (_, i) => (
                          <Skeleton key={i} className="h-7 w-full" />
                        ))}
                      </div>
                    ) : deliveries.length === 0 ? (
                      <p className="text-mcs-xs text-mcs-text-subtle">暂无投递记录</p>
                    ) : (
                      <div className="flex max-h-60 flex-col gap-1 overflow-y-auto">
                        {deliveries.map((d: WebhookDelivery) => {
                          const summary = truncateResponseBody(d.responseBody)
                          const deliveryExpanded = expandedDeliveryId === d.id
                          return (
                            <div key={d.id}>
                              <button
                                type="button"
                                className="flex w-full cursor-pointer items-center justify-between rounded-mcs-xs bg-mcs-bg-default px-2 py-1.5 text-left text-mcs-xs hover:bg-mcs-bg-hover"
                                aria-expanded={deliveryExpanded}
                                onClick={() => setExpandedDeliveryId(deliveryExpanded ? null : d.id)}
                              >
                                <div>
                                  <span className="font-medium text-mcs-text-default">{fmtEvt(d.eventType)}</span>
                                  <span className="ml-2 text-mcs-text-subtle">
                                    {d.responseStatus ? String(d.responseStatus) : d.status}
                                    {d.durationMs != null ? ` ${String(d.durationMs)}ms` : ''}
                                    {d.attempts > 1 ? ` ${d.attempts}次` : ''}
                                  </span>
                                </div>
                                <span className={cn(
                                  d.status === 'success' ? 'text-mcs-success-fg' : d.status === 'failed' ? 'text-mcs-error-fg' : 'text-mcs-text-muted',
                                )}>
                                  {fmtTime(d.createdAt)}
                                </span>
                              </button>
                              {deliveryExpanded && (
                                summary ? (
                                  <pre data-testid={`delivery-response-${d.id}`} className="mt-1 whitespace-pre-wrap break-all rounded-mcs-xs bg-mcs-bg-subtle px-2 py-1.5 font-mono text-mcs-2xs text-mcs-text-muted">{summary}</pre>
                                ) : (
                                  <p data-testid={`delivery-response-${d.id}`} className="mt-1 px-2 py-1 text-mcs-2xs text-mcs-text-subtle">无响应体</p>
                                )
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── 新建/编辑对话框 ── */}
      <Dialog open={showDialog} onOpenChange={(open) => { if (!open) tryCloseDialog() }}>
        <DialogContent className="bg-mcs-bg-default sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editTarget ? '编辑 Webhook' : '新建 Webhook'}</DialogTitle>
            <DialogDescription>{editTarget ? '修改 Webhook 配置' : '创建新的外部通知通道'}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="webhook-name" className="text-mcs-xs text-mcs-text-muted">名称 *</Label>
              <Input
                id="webhook-name"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="Discord 通知"
                className="text-mcs-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="webhook-url" className="text-mcs-xs text-mcs-text-muted">URL *</Label>
              <Input
                id="webhook-url"
                value={form.url}
                onChange={e => setForm(f => ({ ...f, url: e.target.value }))}
                placeholder="https://example.com/webhook"
                className="text-mcs-sm"
                aria-invalid={urlInvalid}
              />
              {urlInvalid && (
                <p className="text-mcs-2xs text-mcs-error-fg">URL 需以 http:// 或 https:// 开头</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="webhook-secret" className="text-mcs-xs text-mcs-text-muted">HMAC 密钥（留空不签名）</Label>
              <Input
                id="webhook-secret"
                value={form.secret}
                onChange={e => setForm(f => ({ ...f, secret: e.target.value }))}
                type="password"
                placeholder={editTarget ? '留空保持原密钥不变' : '可选'}
                className="text-mcs-sm"
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-mcs-xs text-mcs-text-muted">事件过滤</Label>
                <Button variant="outline" size="sm" className="h-6 text-mcs-2xs" onClick={selectAll}>
                  {eventTypes && form.events.length === eventTypes.length ? '取消全选' : '全选'}
                </Button>
              </div>
              <div className="flex flex-wrap gap-1">
                {eventTypes?.map(evt => (
                  <button
                    key={evt}
                    type="button"
                    onClick={() => toggleEvent(evt)}
                    aria-pressed={form.events.includes(evt)}
                    className={cn(
                      'rounded-mcs-xs border px-2 py-0.5 text-mcs-2xs transition-colors cursor-pointer',
                      form.events.includes(evt)
                        ? 'border-mcs-accent-border bg-mcs-accent-bg-subtle text-mcs-accent-fg'
                        : 'border-mcs-border-muted text-mcs-text-subtle hover:border-mcs-border-default',
                    )}
                  >
                    {fmtEvt(evt)}
                  </button>
                ))}
              </div>
              <p className="text-mcs-2xs text-mcs-text-subtle">未选择 = 订阅全部事件</p>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                checked={form.isEnabled}
                onCheckedChange={checked => setForm(f => ({ ...f, isEnabled: checked }))}
              />
              <Label className="text-mcs-sm text-mcs-text-default cursor-pointer" onClick={() => setForm(f => ({ ...f, isEnabled: !f.isEnabled }))}>启用</Label>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={tryCloseDialog}>取消</Button>
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
        onConfirm={() => { setDialogDirtyConfirm(false); closeDialog() }}
      />
    </div>
  )
}
