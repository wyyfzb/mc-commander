import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useConnectionStore } from '@/stores/connection'
import { apiGetWebhooks, apiGetWebhookEventTypes, apiCreateWebhook, apiUpdateWebhook, apiDeleteWebhook, apiTestWebhook, apiGetWebhookDeliveries } from '@/api/webhooks'
import { queryKeys } from '@/api/queries'
import { getFriendlyErrorText } from '@/api/errors'
import type { Webhook, WebhookDelivery } from '@/api/types'

const EVENT_LABELS: Record<string, string> = {
  'player.join': '玩家加入', 'player.leave': '玩家离开', 'player.death': '玩家死亡',
  'player.respawn': '玩家重生', 'player.chat': '玩家聊天', 'player.sleep': '玩家睡觉',
  'player.achievement': '玩家成就', 'instance.start': '实例启动', 'instance.stop': '实例停止',
  'instance.crash': '实例崩溃', 'instance.ready': '实例就绪', 'instance.save': '实例保存',
  'instance.restart': '实例重启', 'backup.create': '备份创建', 'backup.restore': '备份恢复',
  'backup.delete': '备份删除', 'server.start': '面板启动', 'server.shutdown': '面板关闭', 'ping': 'Ping 测试',
}

const mcsText = 'var(--mcs-text-primary, #e2e8f0)'
const mcsTextSec = 'var(--mcs-text-secondary, #94a3b8)'
const mcsTextTer = 'var(--mcs-text-tertiary, #64748b)'
const mcsBgCard = 'var(--mcs-bg-card, #1e293b)'
const mcsBgMuted = 'var(--mcs-bg-muted, #0f172a)'
const mcsBgInput = 'var(--mcs-bg-input, #0f172a)'
const mcsBorder = 'var(--mcs-border, #334155)'
const mcsAccent = 'var(--mcs-accent, #3b82f6)'
const mcsRadius = 'var(--mcs-radius-sm, 6px)'
const mcsTextSuccess = 'var(--mcs-text-success, #4ade80)'
const mcsBgSuccess = 'var(--mcs-bg-success, #166534)'
const mcsTextError = 'var(--mcs-text-error, #f87171)'
const mcsBgError = 'var(--mcs-bg-error, #7f1d1d)'
const mcsTextInverse = 'var(--mcs-text-inverse, inherit)'

function fmtEvt(t: string) { return EVENT_LABELS[t] || t }
function fmtTime(iso: string) { return new Date(iso).toLocaleString('zh-CN') }

export default function WebhookPage() {
  const config = useConnectionStore()
  const qc = useQueryClient()
  const [showDialog, setShowDialog] = useState(false)
  const [editTarget, setEditTarget] = useState<Webhook | null>(null)
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [form, setForm] = useState({ name: '', url: '', secret: '', events: [] as string[], isEnabled: true })

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
  const { data: deliveriesData } = useQuery({
    queryKey: queryKeys.webhookDeliveries(expandedId ?? -1),
    queryFn: ({ signal }) => apiGetWebhookDeliveries(config, expandedId!, 1, 10, signal),
    enabled: expandedId != null && config.status === 'ready',
  })

  const createMut = useMutation({
    mutationFn: (d: Parameters<typeof apiCreateWebhook>[1]) => apiCreateWebhook(config, d),
    onSuccess: () => { qc.invalidateQueries({ queryKey: queryKeys.webhooks() }); closeDialog() },
  })
  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Parameters<typeof apiUpdateWebhook>[2] }) => apiUpdateWebhook(config, id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: queryKeys.webhooks() }); closeDialog() },
  })
  const deleteMut = useMutation({
    mutationFn: (id: number) => apiDeleteWebhook(config, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.webhooks() }),
  })
  const testMut = useMutation({
    mutationFn: (id: number) => apiTestWebhook(config, id),
  })

  const openCreate = () => { setEditTarget(null); setForm({ name: '', url: '', secret: '', events: [], isEnabled: true }); setShowDialog(true) }
  const openEdit = (w: Webhook) => { setEditTarget(w); setForm({ name: w.name, url: w.url, secret: '', events: [...w.events], isEnabled: w.isEnabled }); setShowDialog(true) }
  const closeDialog = () => { setShowDialog(false); setEditTarget(null); setForm({ name: '', url: '', secret: '', events: [], isEnabled: true }) }
  const toggleEvent = (evt: string) => setForm(f => ({ ...f, events: f.events.includes(evt) ? f.events.filter(e => e !== evt) : [...f.events, evt] }))
  const selectAll = () => { if (eventTypes && form.events.length === eventTypes.length) setForm(f => ({ ...f, events: [] })); else if (eventTypes) setForm(f => ({ ...f, events: [...eventTypes] })) }
  const handleSubmit = () => {
    const payload: Record<string, unknown> = { name: form.name, url: form.url, events: form.events, isEnabled: form.isEnabled }
    if (form.secret) payload.secret = form.secret
    if (editTarget) updateMut.mutate({ id: editTarget.id, data: payload as unknown as Parameters<typeof apiUpdateWebhook>[2] })
    else createMut.mutate(payload as unknown as Parameters<typeof apiCreateWebhook>[1])
  }

  const webhooks = webhooksData?.data ?? []
  const deliveries = deliveriesData?.data ?? []
  if (config.status !== 'ready') return null

  const btnBase: React.CSSProperties = { padding: '4px 10px', borderRadius: mcsRadius, fontSize: 12, border: `1px solid ${mcsBorder}`, background: 'transparent', color: mcsTextSec, cursor: 'pointer' }

  return (
    <div style={{ maxWidth: 960, margin: '0 auto', padding: '24px 16px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, color: mcsText }}>Webhook 外部通知</h2>
        <button onClick={openCreate} disabled={createMut.isPending || updateMut.isPending}
          style={{ padding: '6px 14px', borderRadius: mcsRadius, background: mcsAccent, color: mcsTextInverse, border: 'none', cursor: 'pointer', fontSize: 13 }}>
          + 新建 Webhook
        </button>
      </div>
      {error && <div style={{ padding: 12, marginBottom: 16, borderRadius: mcsRadius, background: 'var(--mcs-bg-error, #fecaca)', color: 'var(--mcs-text-error, #991b1b)' }}>{getFriendlyErrorText(error)}</div>}
      {isLoading ? <div style={{ textAlign: 'center', padding: 40, color: mcsTextSec }}>加载中...</div>
        : webhooks.length === 0 ? <div style={{ textAlign: 'center', padding: 40, color: mcsTextSec }}>暂无 Webhook，点击新建添加外部通知通道</div>
        : <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {webhooks.map((w: Webhook) => {
              const testResult = testMut.variables === w.id ? testMut : null
              return (
                <div key={w.id} style={{ padding: 14, borderRadius: mcsRadius, border: `1px solid ${mcsBorder}`, background: mcsBgCard }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontWeight: 600, color: mcsText, fontSize: 14 }}>{w.name}</span>
                        <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 4, background: w.isEnabled ? 'var(--mcs-bg-success, #166534)' : mcsBgMuted, color: w.isEnabled ? mcsTextSuccess : mcsTextSec }}>
                          {w.isEnabled ? '启用' : '禁用'}
                        </span>
                      </div>
                      <div style={{ fontSize: 12, color: mcsTextSec, marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.url}</div>
                      {w.events.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                          {w.events.map(e => <span key={e} style={{ fontSize: 11, padding: '1px 6px', borderRadius: 4, background: mcsBgMuted, color: mcsTextSec }}>{fmtEvt(e)}</span>)}
                        </div>
                      )}
                      {w.events.length === 0 && <div style={{ fontSize: 11, color: mcsTextTer, marginTop: 4 }}>订阅全部事件</div>}
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                      <button onClick={() => testMut.mutate(w.id)} disabled={testMut.isPending} style={btnBase}>{testMut.isPending && testMut.variables === w.id ? '投递中...' : '测试'}</button>
                      <button onClick={() => setExpandedId(expandedId === w.id ? null : w.id)} style={btnBase}>投递日志</button>
                      <button onClick={() => openEdit(w)} style={btnBase}>编辑</button>
                      <button onClick={() => { if (confirm('确定删除此 Webhook？')) deleteMut.mutate(w.id) }} disabled={deleteMut.isPending} style={{ ...btnBase, color: mcsTextError }}>删除</button>
                    </div>
                  </div>
                  {expandedId === w.id && (
                    <div style={{ marginTop: 12, borderTop: `1px solid ${mcsBorder}`, paddingTop: 10 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: mcsText, marginBottom: 8 }}>投递日志</div>
                      {deliveries.length === 0 ? <div style={{ fontSize: 12, color: mcsTextTer }}>暂无投递记录</div>
                        : <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 240, overflowY: 'auto' }}>
                            {deliveries.map((d: WebhookDelivery) => (
                              <div key={d.id} style={{ padding: '6px 8px', borderRadius: 4, fontSize: 12, background: mcsBgMuted, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <div>
                                  <span style={{ fontWeight: 500, color: mcsText }}>{fmtEvt(d.eventType)}</span>
                                  <span style={{ color: mcsTextTer, marginLeft: 8 }}>{d.responseStatus ? String(d.responseStatus) : d.status}{d.durationMs != null ? ` ${String(d.durationMs)}ms` : ''}{d.attempts > 1 ? ` ${d.attempts}次` : ''}</span>
                                </div>
                                <span style={{ color: d.status === 'success' ? mcsTextSuccess : d.status === 'failed' ? mcsTextError : mcsTextSec }}>{fmtTime(d.createdAt)}</span>
                              </div>
                            ))}
                          </div>}
                    </div>
                  )}
                  {testResult?.isSuccess && (
                    <div style={{ marginTop: 8, padding: '6px 10px', borderRadius: 4, fontSize: 12, background: mcsBgSuccess, color: mcsTextSuccess }}>
                      {'测试投递成功 HTTP ' + String(testResult.data?.statusCode ?? '')}
                    </div>
                  )}
                  {testResult?.isError && (
                    <div style={{ marginTop: 8, padding: '6px 10px', borderRadius: 4, fontSize: 12, background: mcsBgError, color: 'var(--mcs-text-error, #fca5a5)' }}>
                      {'测试投递失败：' + getFriendlyErrorText(testResult.error)}
                    </div>
                  )}
                </div>
              )
            })}
          </div>}
      {showDialog && (
        <div style={{ position: 'fixed', inset: 0, background: 'var(--mcs-bg-overlay, #00000066)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}
          onClick={(e) => { if (e.target === e.currentTarget) closeDialog() }}>
          <div style={{ background: mcsBgCard, borderRadius: 'var(--mcs-radius-md, 8px)', padding: 20, width: 480, maxHeight: '80vh', overflowY: 'auto', border: `1px solid ${mcsBorder}` }}>
            <h3 style={{ fontSize: 16, fontWeight: 600, color: mcsText, marginBottom: 16 }}>{editTarget ? '编辑 Webhook' : '新建 Webhook'}</h3>
            <label style={{ display: 'block', marginBottom: 12 }}>
              <span style={{ fontSize: 13, color: mcsTextSec, marginBottom: 4, display: 'block' }}>名称 *</span>
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                style={{ width: '100%', padding: '6px 10px', borderRadius: mcsRadius, border: `1px solid ${mcsBorder}`, background: mcsBgInput, color: mcsText, fontSize: 13, boxSizing: 'border-box' }} />
            </label>
            <label style={{ display: 'block', marginBottom: 12 }}>
              <span style={{ fontSize: 13, color: mcsTextSec, marginBottom: 4, display: 'block' }}>URL *</span>
              <input value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))} placeholder='https://example.com/webhook'
                style={{ width: '100%', padding: '6px 10px', borderRadius: mcsRadius, border: `1px solid ${mcsBorder}`, background: mcsBgInput, color: mcsText, fontSize: 13, boxSizing: 'border-box' }} />
            </label>
            <label style={{ display: 'block', marginBottom: 12 }}>
              <span style={{ fontSize: 13, color: mcsTextSec, marginBottom: 4, display: 'block' }}>HMAC 密钥（留空不签名）</span>
              <input value={form.secret} onChange={e => setForm(f => ({ ...f, secret: e.target.value }))} type='password' placeholder={editTarget ? '留空保持原密钥不变' : '可选'}
                style={{ width: '100%', padding: '6px 10px', borderRadius: mcsRadius, border: `1px solid ${mcsBorder}`, background: mcsBgInput, color: mcsText, fontSize: 13, boxSizing: 'border-box' }} />
            </label>
            <div style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <span style={{ fontSize: 13, color: mcsTextSec }}>事件过滤</span>
                <button onClick={selectAll} style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, cursor: 'pointer', border: `1px solid ${mcsBorder}`, background: 'transparent', color: mcsTextSec }}>
                  {eventTypes && form.events.length === eventTypes.length ? '取消全选' : '全选'}
                </button>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {eventTypes?.map(evt => (
                  <button key={evt} onClick={() => toggleEvent(evt)}
                    style={{ fontSize: 11, padding: '3px 8px', borderRadius: 4, cursor: 'pointer', border: form.events.includes(evt) ? `1px solid ${mcsAccent}` : `1px solid ${mcsBorder}`, background: form.events.includes(evt) ? mcsAccent : 'transparent', color: form.events.includes(evt) ? mcsTextInverse : mcsTextSec }}>
                    {fmtEvt(evt)}
                  </button>
                ))}
              </div>
              <div style={{ fontSize: 11, color: mcsTextTer, marginTop: 4 }}>未选择 = 订阅全部事件</div>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, cursor: 'pointer' }}>
              <input type='checkbox' checked={form.isEnabled} onChange={e => setForm(f => ({ ...f, isEnabled: e.target.checked }))} />
              <span style={{ fontSize: 13, color: mcsText }}>启用</span>
            </label>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={closeDialog} style={{ ...btnBase }}>取消</button>
              <button onClick={handleSubmit} disabled={!form.name || !form.url || createMut.isPending || updateMut.isPending}
                style={{ padding: '6px 16px', borderRadius: mcsRadius, fontSize: 13, border: 'none', background: mcsAccent, color: mcsTextInverse, cursor: 'pointer', opacity: (!form.name || !form.url) ? 0.5 : 1 }}>
                {editTarget ? '保存' : '创建'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
