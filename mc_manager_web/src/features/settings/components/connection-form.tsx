/**
 * ConnectionForm —— 连接配置表单
 * - 设置页（settings）：顶部状态行（已连接=store ready → success 色调）+ 实底卡片表单
 * - onboarding：大标题布局（标题+副标题）复用同一表单，保存后由 onSaved 回调跳转
 * - 单输入语义：面板地址为含协议端口的完整 URL
 * - 公网 http 明文传输警告（needsHttpPlaintextWarning → ConfirmDialog danger，
 *   用户确认后仍可继续；局域网/本机地址不打扰）
 * - 测试连接：用表单值临时构造 config 调 GET /api/v1/overview，不写 store；
 *   保存才 setConfig（normalizeBaseUrl 默认 https + 去尾斜杠）
 * - 设计纪律：实底卡片（bg-mcs-bg-muted）+ --mcs-* token；禁硬编码色值/间距/圆角
 */
import { useState } from 'react'
import { flushSync } from 'react-dom'
import { Eye, EyeOff, Loader2, RefreshCw, Save, Wifi } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'
import { cn } from '@/lib/utils'
import { ApiError, apiGet, apiPost } from '@/api/client'
import type { OverviewData } from '@/api/types'
import { getFriendlyErrorText } from '@/api/errors'
import { normalizeBaseUrl, needsHttpPlaintextWarning } from '@/lib/mc-connection'
import { useUnsavedGuard } from '@/hooks/use-unsaved-guard'
import { useConnectionStore } from '@/stores/connection'
import type { ConnectionFormProps } from './contracts'

/** 明文警告确认后待执行的挂起动作（null = 无弹窗） */
type PendingAction = 'save' | 'test' | null

export function ConnectionForm({ variant = 'settings', onSaved }: ConnectionFormProps) {
  const storedBaseUrl = useConnectionStore((s) => s.baseUrl)
  const storedApiKey = useConnectionStore((s) => s.apiKey)
  const status = useConnectionStore((s) => s.status)

  const [url, setUrl] = useState(storedBaseUrl)
  const [apiKey, setApiKey] = useState(storedApiKey)
  const [showApiKey, setShowApiKey] = useState(false)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [rotating, setRotating] = useState(false)
  const [testedOk, setTestedOk] = useState(false)
  const [latencyMs, setLatencyMs] = useState<number | null>(null)
  const [pendingAction, setPendingAction] = useState<PendingAction>(null)

  /** 未保存修改（与 store 对比） */
  const dirty = url !== storedBaseUrl || apiKey !== storedApiKey
  // 未保存守卫：切子页/切页面时弹确认，避免静默丢失
  const guard = useUnsavedGuard(dirty)

  // 状态行即时反馈：保存过（ready）或测试连接成功 → 已连接
  const isConnected = status === 'ready' || testedOk

  /** 空值校验（测试/保存前置） */
  function ensureFilled(): boolean {
    if (url.trim() !== '' && apiKey.trim() !== '') return true
    toast.warning('请先填写服务器地址和 API Key')
    return false
  }

  /**
   * 测试连接：表单值临时构造 config，成功后不写 store（保存才持久化）。
   * 返回是否成功；silentFailure=true 时不弹失败细节 toast（保存路径由调用方统一提示）
   */
  async function runTest(base: string, opts?: { silentFailure?: boolean }): Promise<boolean> {
    setTesting(true)
    try {
      const t0 = performance.now()
      await apiGet<OverviewData>('/api/v1/overview', { baseUrl: base, apiKey })
      setLatencyMs(Math.round(performance.now() - t0))
      setTestedOk(true)
      return true
    } catch (e) {
      setTestedOk(false)
      if (!opts?.silentFailure) {
        // 服务端返回错误信封（如 API Key 无效）→ 友好文案；网络/超时 → 通用失败提示
        if (e instanceof ApiError) toast.error(getFriendlyErrorText(e))
        else toast.error('连接失败，请检查配置')
      }
      return false
    } finally {
      setTesting(false)
    }
  }

  /**
   * 保存：先强制测试连接（杜绝「告知失败但已生效」）——
   * 成功才写 store + 提示已保存 + onSaved；失败提示「保存失败：连接测试未通过」且不写入
   */
  async function doSave(base: string) {
    setSaving(true)
    const ok = await runTest(base, { silentFailure: true })
    setSaving(false)
    if (!ok) {
      toast.error('保存失败：连接测试未通过')
      return
    }
    useConnectionStore.getState().setConfig({ baseUrl: base, apiKey })
    // flushSync 同步本地态：onSaved 的立即导航（如 onboarding 跳 /dashboard）在同一 tick 发生，
    // 不先解除 dirty 会被 useUnsavedGuard 以「未保存」拦截（时序 bug，E2E 捕获）
    flushSync(() => {
      setUrl(base)
      setApiKey(apiKey)
    })
    toast.success('连接配置已保存')
    onSaved?.()
  }

  function handleTest() {
    if (!ensureFilled()) return
    const base = normalizeBaseUrl(url)
    if (needsHttpPlaintextWarning(base)) {
      setPendingAction('test')
      return
    }
    void runTest(base).then((ok) => {
      if (ok) toast.success('连接成功')
    })
  }

  function handleSave() {
    if (!ensureFilled()) return
    const base = normalizeBaseUrl(url)
    if (needsHttpPlaintextWarning(base)) {
      setPendingAction('save')
      return
    }
    void doSave(base)
  }

  /**
   * 重新生成 API Key：服务端轮换后旧 Key 立即失效，必须同步写入 store，
   * 否则后续请求全部 401（新 Key 由服务端刚生成，无需再走测试连接）
   */
  async function handleRotate() {
    if (!ensureFilled()) return
    setRotating(true)
    try {
      const base = normalizeBaseUrl(url)
      const res = await apiPost<{ apiKey: string }>('/api/v1/rotate-key', { baseUrl: base, apiKey }, {})
      const newKey = res.apiKey
      setApiKey(newKey)
      setTestedOk(true)
      flushSync(() => {
        useConnectionStore.getState().setConfig({ baseUrl: base, apiKey: newKey })
        setUrl(base)
      })
      toast.success('新 API Key 已生成并启用，旧 Key 已失效')
    } catch (e) {
      if (e instanceof ApiError) toast.error(getFriendlyErrorText(e))
      else toast.error('重新生成失败，请检查连接配置')
    } finally {
      setRotating(false)
    }
  }

  /** 明文警告确认后继续挂起动作（取消走 onOpenChange(false) 直接中止）；警告已确认，直接执行不再复检 */
  function confirmContinue() {
    const action = pendingAction
    setPendingAction(null)
    const base = normalizeBaseUrl(url)
    if (action === 'test') {
      void runTest(base).then((ok) => {
        if (ok) toast.success('连接成功')
      })
    } else if (action === 'save') {
      void doSave(base)
    }
  }

  const formFields = (
    <>
      <div className="flex flex-col gap-2">
        <Label htmlFor="connection-url">面板地址</Label>
        <Input
          id="connection-url"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value)
            setTestedOk(false)
          }}
          placeholder="https://192.168.1.100:25566"
          autoComplete="off"
          spellCheck={false}
        />
        <p className="text-mcs-xs text-mcs-text-subtle">
          支持 http/https 协议；局域网自建服务器推荐内网地址
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="connection-api-key">API Key</Label>
          <button
            type="button"
            onClick={() => void handleRotate()}
            disabled={rotating || testing || saving}
            className="inline-flex items-center gap-1 rounded-mcs-sm text-mcs-2xs font-medium text-mcs-text-subtle transition-colors hover:text-mcs-text-default disabled:opacity-50"
          >
            <RefreshCw className={cn('size-3', rotating && 'animate-spin')} aria-hidden />
            {rotating ? '生成中...' : '重新生成'}
          </button>
        </div>
        <div className="relative">
          <Input
            id="connection-api-key"
            type={showApiKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value)
              setTestedOk(false)
            }}
            placeholder="输入 API Key"
            autoComplete="off"
            spellCheck={false}
            className="pr-10"
          />
          <button
            type="button"
            onClick={() => setShowApiKey((v) => !v)}
            aria-label={showApiKey ? '隐藏 API Key' : '显示 API Key'}
            className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-mcs-text-subtle transition-colors hover:text-mcs-text-default"
          >
            {showApiKey ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
          </button>
        </div>
      </div>

      <div className="flex gap-3">
        <Button type="button" variant="outline" className="flex-1" onClick={handleTest} disabled={testing || saving}>
          {testing && !saving ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Wifi className="size-4" aria-hidden />}
          {testing && !saving ? '测试中...' : '测试连接'}
        </Button>
        <Button type="button" className="flex-1" onClick={() => void handleSave()} disabled={testing || saving}>
          {saving ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Save className="size-4" aria-hidden />}
          {saving ? '保存中...' : '保存连接'}
        </Button>
      </div>
    </>
  )

  return (
    <div className={variant === 'onboarding' ? 'mx-auto w-full max-w-md' : 'w-full'}>
      {variant === 'onboarding' ? (
        <header className="mb-8 text-center">
          <h1 className="text-mcs-2xl font-semibold text-mcs-text-default">连接你的服务器</h1>
          <p className="mt-2 text-mcs-sm text-mcs-text-muted">
            输入 MC Commander 面板地址与 API Key，测试并保存连接配置后即可开始使用。
          </p>
        </header>
      ) : (
        <div
          className={cn(
            'flex items-center gap-2 rounded-mcs-md border px-4 py-3',
            isConnected
              ? 'border-mcs-success-border bg-mcs-success-bg-subtle text-mcs-success-fg'
              : 'border-mcs-border-muted bg-mcs-bg-muted text-mcs-text-muted',
          )}
        >
          <span
            className={cn('size-2 rounded-full', isConnected ? 'bg-mcs-success-fg' : 'bg-mcs-text-subtle')}
            aria-hidden
          />
          <span className="text-mcs-sm font-medium">{isConnected ? '已连接' : '未连接'}</span>
          {isConnected && latencyMs != null && (
            <span className="text-mcs-2xs text-mcs-text-subtle">WebSocket 实时 · 延迟 {latencyMs}ms</span>
          )}
        </div>
      )}

      <div
        className={cn(
          'flex flex-col gap-5 rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-muted p-6',
          variant === 'settings' && 'mt-4',
        )}
      >
        {formFields}
      </div>

      <ConfirmDialog
        open={pendingAction !== null}
        onOpenChange={(open) => {
          if (!open) setPendingAction(null)
        }}
        title="明文传输警告"
        description="您正在通过 HTTP（非加密）连接公网服务器，API Key 与数据将以明文传输，存在被窃听的风险。建议改用 HTTPS 或确保目标地址可信。确定要继续吗？"
        confirmText="仍然继续"
        cancelText="取消"
        danger
        onConfirm={confirmContinue}
      />

      {/* 未保存修改守卫：切子页/切页面弹确认 */}
      <ConfirmDialog
        open={guard.isBlocked}
        onOpenChange={(open) => !open && guard.cancel()}
        title="连接配置尚未保存"
        description="离开页面将丢失未保存的连接配置修改，确定离开吗？"
        confirmText="放弃修改并离开"
        cancelText="留下"
        danger
        onConfirm={guard.proceed}
      />
    </div>
  )
}
