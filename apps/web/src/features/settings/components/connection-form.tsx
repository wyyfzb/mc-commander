/**
 * ConnectionForm —— 连接配置表单
 * - 设置页（settings）：顶部状态行（已连接=store ready → success 色调）+ 实底卡片表单
 * - onboarding：大标题布局（标题+副标题）复用同一表单，保存后由 onSaved 回调跳转
 * - 单输入语义：面板地址为含协议端口的完整 URL
 * - 公网 http 明文传输警告（needsHttpPlaintextWarning → ConfirmDialog danger，
 *   用户确认后仍可继续；局域网/本机地址不打扰）
 * - 测试连接：用表单值临时构造 config 调 GET /api/v1/overview，不写 store；
 *   保存才 setConfig（normalizeBaseUrl 默认 https + 去尾斜杠）
 * - API Key 轮换入口的可见性由服务端能力探测（GET /auth/capabilities 的 apiKeyEnabled）决定：
 *   开关关闭时隐藏入口，未知态（加载中/探测失败）保持可见
 * - 设计纪律：实底卡片（bg-mcs-bg-muted）+ --mcs-* token；禁硬编码色值/间距/圆角
 */
import { useState } from 'react'
import { flushSync } from 'react-dom'
import {
  ClipboardPaste,
  Copy,
  Eye,
  EyeOff,
  Info,
  Loader2,
  RefreshCw,
  Save,
  Wifi,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'
import { NoticeBanner } from '@/components/mcs/notice-banner'
import { Card } from '@/components/mcs/card'
import { InfoHint } from '@/components/mcs/info-hint'
import { cn } from '@/lib/utils'
import { ApiError, apiPost, apiRequest } from '@/api/client'
import type { OverviewData } from '@/api/types'
import { ErrorCode, getFriendlyErrorText } from '@/api/errors'
import { useApiKeyCapabilities } from '@/api/queries'
import {
  normalizeBaseUrl,
  needsHttpPlaintextWarning,
  parseConnectionConfig,
  serializeConnectionConfig,
  sessionAppliesToPanel,
} from '@/lib/mc-connection'
import { copyText } from '@/lib/clipboard'
import { useUnsavedGuard } from '@/hooks/use-unsaved-guard'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { useAuthStore } from '@/stores/auth'
import { useServerStore } from '@/stores/server'
import { useConnectionStore } from '@/stores/connection'
import type { ConnectionFormProps } from './contracts'
import { toneClasses } from '@/components/mcs/tone'

/** 明文警告确认后待执行的挂起动作（null = 无弹窗） */
type PendingAction = 'save' | 'test' | null

/** 地址停止输入后多久视为落定（能力探测的取值点；见 formFields 上方注释） */
const ADDRESS_SETTLE_DELAY_MS = 300

/**
 * API Key 的凭据定位（浮层正文，逐条对应代码行为：单例全局 / 无过期 / 权限等同管理员 /
 * 可整体关闭）。常驻会与地址行、会话提示挤在同一栏，故降级为输入框旁的信息入口。
 */
const API_KEY_MODEL_HINT =
  'API Key 是没有登录会话的客户端（自动化脚本、外部集成）用的机器凭据：单例全局、无过期、权限等同于管理员（可访问全部接口），轮换后旧 Key 立即失效；在服务端 .env 设 API_KEY_ENABLED=false 可整体关闭该通道。'

export function ConnectionForm({
  variant = 'settings',
  headingAs = 'h1',
  onSaved,
}: ConnectionFormProps) {
  /** 标题标签由调用点决定：同屏是否已有别的 h1 只有页面知道，组件内不能写死 */
  const HeadingTag = headingAs
  const storedBaseUrl = useConnectionStore((s) => s.baseUrl)
  const storedApiKey = useConnectionStore((s) => s.apiKey)
  const status = useConnectionStore((s) => s.status)
  /** 浏览器登录会话（与 API Key 并列的第二条凭据；**属于本地址时**才具备连接能力） */
  const session = useAuthStore((s) => s.session)

  const [url, setUrl] = useState(storedBaseUrl)
  /**
   * 能力探测专用的稳定地址：逐击键的中间态（`h`、`192.168.1.100:` …）各自都是一个新
   * query key，逐击键取值最坏发「按键数」发（27 字符地址：门槛挡掉 scheme 前 8 个中间态后实发 19 发）。
   * 停止输入 ADDRESS_SETTLE_DELAY_MS 后落定。
   */
  const settledUrl = useDebouncedValue(url, ADDRESS_SETTLE_DELAY_MS)
  const [apiKey, setApiKey] = useState(storedApiKey)
  const [showApiKey, setShowApiKey] = useState(false)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [rotating, setRotating] = useState(false)
  const [testedOk, setTestedOk] = useState(false)
  const [latencyMs, setLatencyMs] = useState<number | null>(null)
  const [pendingAction, setPendingAction] = useState<PendingAction>(null)
  const [urlError, setUrlError] = useState('')
  const [keyError, setKeyError] = useState('')
  /** 粘贴导入区是否展开（默认收起：它是「换设备/帮别人配」的旁路，不是每次配置都要走） */
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [importError, setImportError] = useState('')

  /** 未保存修改（与 store 对比） */
  const dirty = url !== storedBaseUrl || apiKey !== storedApiKey
  // 未保存守卫：切子页/切页面时弹确认，避免静默丢失
  const guard = useUnsavedGuard(dirty)

  /**
   * 会话对本表单地址是否有效（令牌只对签发它的面板发；换地址即改用 API Key 通道）。
   * 用表单地址而非已存地址：用户改到别的面板时，提示与校验都要跟着走。
   */
  const sessionApplies = sessionAppliesToPanel(session, url)
  const foreignSession = Boolean(session?.token) && !sessionApplies

  /**
   * API Key 通道是否开放（服务端部署开关 API_KEY_ENABLED）。按**表单草稿**取面板身份与
   * 凭据：用已存值会让「填完 Key 才拿到真实答案」的路径失效。
   *
   * 地址取**停止输入后落定**的值（防抖；见 ADDRESS_SETTLE_DELAY_MS）：逐击键取值会打出「按键数」
   * 发请求（门槛再挡掉 scheme 前的中间态），落定点的语义也正是「用户已经指明了面板」。
   *
   * 轮换入口的隐藏条件有两个：① 已知态下 `data?.apiKeyEnabled === false`（通道关闭）；
   * ② onboarding 语境（那是「粘贴部署输出的一次性 Key 后进面板」的流程，轮换紧贴输入框，
   * 误触即让刚粘贴的 Key 立刻作废）——轮换属凭据管理，归设置页；此处不提供不等于无处可做，
   * 连上后面板设置页即在同一位置提供该入口。
   * 加载中、请求失败、响应不可判读（未知态）一律保持可见——隐藏是不可自证的，误隐藏会让用户
   * 以为没有该能力且无从恢复；误显示的最坏结果只是点到一次 fail-closed 的 403（已有通道关闭文案）。
   * 通道关闭时凭据本身仍可能有效（Key 照常可粘贴，只是无 API Key 鉴权通道），故输入框不隐藏。
   */
  const capabilities = useApiKeyCapabilities(settledUrl, apiKey)
  const apiKeyChannelDisabled = capabilities.data?.apiKeyEnabled === false

  /** 实时通道在线状态——与顶栏状态点同源（见 layouts/app-topbar.tsx 的 indicator） */
  const socketConnected = useServerStore((s) => s.socketConnected)

  /**
   * 状态行三档。connection store 的 `ready` 只表示**凭据存在**（见
   * stores/connection.ts 的 hasCredentials），服务端整体不可达时它同样为 ready，
   * 撑不起「已连接」这个词——此前设置页与顶栏用同一个词说两件不同的事。
   * 「已连接」只由真实连通证据给出：实时通道在线，或本次测试连接拿到结果。
   */
  const isConnected = socketConnected || testedOk || latencyMs != null
  const statusLabel = isConnected ? '已连接' : status === 'ready' ? '凭据已配置' : '未连接'

  /**
   * 空值校验（测试/保存前置）——行内提示，对齐 deploy-dialog 范式。
   * API Key 只在该地址没有可用登录会话时必填：有会话时客户端走 Bearer（双通道互斥，Key 不参与请求），
   * 仍强制填写会把密码登录用户挡在门外——他们手上没有服务端 .env 里的 Key，连地址都改不了
   */
  function ensureFilled(): boolean {
    let valid = true
    if (url.trim() === '') {
      setUrlError('请填写服务器地址')
      valid = false
    } else {
      setUrlError('')
    }
    if (!sessionApplies && apiKey.trim() === '') {
      setKeyError('请填写 API Key')
      valid = false
    } else {
      setKeyError('')
    }
    return valid
  }

  /**
   * 测试连接：表单值临时构造 config，成功后不写 store（保存才持久化）。
   * 返回结果对象；silentFailure=true 时不弹失败细节 toast（保存路径由调用方统一提示）
   */
  async function runTest(
    base: string,
    opts?: { silentFailure?: boolean },
  ): Promise<{ ok: boolean; error?: string }> {
    setTesting(true)
    try {
      const t0 = performance.now()
      // 探测语义：目标可能是别的面板，不因它返回 40103 就拆掉当前会话（见 client.ignoreSessionExpiry）
      await apiRequest<OverviewData>(
        '/api/v1/overview',
        { baseUrl: base, apiKey },
        { method: 'GET', ignoreSessionExpiry: true },
      )
      setLatencyMs(Math.round(performance.now() - t0))
      setTestedOk(true)
      return { ok: true }
    } catch (e) {
      setTestedOk(false)
      // 服务端返回错误信封（如 API Key 无效）→ 友好文案；网络/超时 → 通用失败提示。
      // 40103 只可能出现在「会话属于本地址」时（异地址不发 Bearer，见 api/client.ts），
      // 即这条会话真的过期了；此时填 Key 也没用（有可用会话时只发 Bearer），
      // 故只给可兑现的下一步：退出登录后重新登录
      const reason =
        e instanceof ApiError
          ? e.code === ErrorCode.AUTH_SESSION_EXPIRED && sessionApplies
            ? '当前地址的登录会话已过期：退出登录后重新登录该面板即可继续'
            : getFriendlyErrorText(e)
          : '连接失败，请检查配置'
      if (!opts?.silentFailure) {
        toast.error(`连接测试失败：${reason}`)
      }
      return { ok: false, error: reason }
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
    const result = await runTest(base, { silentFailure: true })
    setSaving(false)
    if (!result.ok) {
      toast.error(`保存失败：${result.error ?? '连接测试未通过'}`)
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
    void runTest(base).then((r) => {
      if (r.ok) toast.success('连接成功')
    })
  }

  /**
   * 复制当前连接配置（条目 23）。**只复制表单里的值，不读 store**：
   * 用户此刻看到的地址/Key 就是他想给出去的那份，读 store 会在「改完未保存」时
   * 复制出与他眼前所见不符的旧配置。
   */
  async function handleCopyConfig() {
    if (!ensureFilled()) return
    // copyText 内部降级 execCommand，且绝不抛异常（HTTP 非安全上下文也可用）
    const ok = await copyText(serializeConnectionConfig({ baseUrl: normalizeBaseUrl(url), apiKey }))
    if (ok) {
      toast.success('连接配置已复制', {
        description: '粘贴到另一台设备的「粘贴导入」即可，注意它含 API Key 明文',
        duration: 4000,
      })
    } else {
      toast.error('复制失败，请手动选中复制')
    }
  }

  /** 粘贴导入：填入表单但**不自动保存**——走既有的「测试连接 → 保存」链路，用户仍有确认机会 */
  function handleImport() {
    const parsed = parseConnectionConfig(importText)
    if (!parsed) {
      setImportError('没找到面板地址：粘贴的内容里要有一行「面板地址: https://…」')
      return
    }
    setUrl(parsed.baseUrl)
    setApiKey(parsed.apiKey)
    setTestedOk(false)
    setUrlError('')
    setKeyError('')
    setImportError('')
    setImportText('')
    setImportOpen(false)

    /* 导入的 Key 可能是**已被管理员关闭的通道**（服务端 .env API_KEY_ENABLED=false）：
       那时它填了也连不上，而失败会以「凭据无效」的形式出现——与「Key 打错了」不可区分。
       能力探测（POST /instances 之前的 GET /auth/capabilities）能提前告诉我们这一点，
       故这里据实说明，而不是让用户去猜是不是自己抄错了。
       注意地址是刚填进去的，探测结果对应的是**旧地址**——故只在地址未变时才据此提示。 */
    if (parsed.apiKey !== '' && apiKeyChannelDisabled && parsed.baseUrl === storedBaseUrl) {
      toast.warning('已填入，但当前面板已关闭 API Key 通道', {
        description:
          '该 Key 会被服务端拒绝（与「Key 无效」表现相同）。若你还有登录会话可用，清空 Key 也能连。',
        duration: 6000,
      })
      return
    }

    toast.success(
      parsed.apiKey === '' ? '已填入面板地址（未含 API Key）' : '已填入面板地址与 API Key',
      { description: '请先「测试连接」，确认可用后再保存', duration: 4000 },
    )
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
      const res = await apiPost<{ apiKey: string }>(
        '/api/v1/rotate-key',
        { baseUrl: base, apiKey },
        {},
      )
      const newKey = res.apiKey
      setApiKey(newKey)
      setTestedOk(true)
      flushSync(() => {
        useConnectionStore.getState().setConfig({ baseUrl: base, apiKey: newKey })
        setUrl(base)
      })
      toast.success('新 API Key 已生成并启用，旧 Key 已失效')
    } catch (e) {
      if (e instanceof ApiError) toast.error(`生成失败：${getFriendlyErrorText(e)}`)
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
      void runTest(base).then((r) => {
        if (r.ok) toast.success('连接成功')
      })
    } else if (action === 'save') {
      void doSave(base)
    }
  }

  // onboarding 语境下保存即跨入面板，按钮文案对齐行为；settings 语境存完留在原地
  const saveLabels =
    variant === 'onboarding'
      ? { idle: '连接并进入面板', busy: '连接中...' }
      : { idle: '保存连接', busy: '保存中...' }

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
            setUrlError('')
          }}
          placeholder="https://192.168.1.100:25566"
          autoComplete="off"
          spellCheck={false}
        />
        {urlError !== '' && <p className="text-mcs-xs text-mcs-error-fg">{urlError}</p>}
        <p className="text-mcs-xs text-mcs-text-muted">
          支持 http/https 协议；局域网自建服务器推荐内网地址
        </p>
        {foreignSession && (
          <NoticeBanner variant="info" icon={Info}>
            当前登录会话属于 <span className="font-mono break-all">{session?.issuedFor}</span>
            ，本地址将改用 API Key 鉴权（不会因此退出登录）。如需以登录会话管理该面板，
            请先退出登录，再用该地址登录。
          </NoticeBanner>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            <Label htmlFor="connection-api-key">API Key</Label>
            {!apiKeyChannelDisabled && (
              <InfoHint label="API Key 说明">
                {sessionApplies
                  ? '已登录：浏览器用登录会话鉴权，此处可留空。'
                  : '当前地址没有可用的登录会话：必须填写 API Key 才能连接。'}
                {API_KEY_MODEL_HINT}
              </InfoHint>
            )}
          </div>
          {!apiKeyChannelDisabled && variant !== 'onboarding' && (
            <button
              type="button"
              onClick={() => void handleRotate()}
              disabled={rotating || testing || saving}
              className="inline-flex items-center gap-1 rounded-mcs-sm text-mcs-2xs font-medium text-mcs-text-muted transition-colors hover:text-mcs-text-default disabled:opacity-50"
            >
              <RefreshCw className={cn('size-3', rotating && 'animate-spin')} aria-hidden />
              {rotating ? '生成中...' : '重新生成'}
            </button>
          )}
        </div>
        <div className="relative">
          <Input
            id="connection-api-key"
            type={showApiKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value)
              setTestedOk(false)
              setKeyError('')
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
            className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-mcs-text-muted transition-colors hover:text-mcs-text-default"
          >
            {showApiKey ? (
              <EyeOff className="size-4" aria-hidden />
            ) : (
              <Eye className="size-4" aria-hidden />
            )}
          </button>
        </div>
        {keyError !== '' && <p className="text-mcs-xs text-mcs-error-fg">{keyError}</p>}
        {apiKeyChannelDisabled && (
          <p className="flex items-center gap-1 text-mcs-xs text-mcs-text-muted">
            当前面板的部署配置已关闭 API Key 通道：Key 在 HTTP 与 WebSocket 上一律被拒绝。
            {/* 关闭原因与恢复路径收进浮层，行内只留状态与后果——两者是「填了也没用」的直接解释 */}
            <InfoHint label="API Key 通道关闭说明">
              {variant === 'onboarding'
                ? '本页不提供轮换入口（轮换属凭据管理，连接后在设置页可见）。'
                : '轮换入口已隐藏；值仍保留在服务端 .env，改回开启即恢复。'}
            </InfoHint>
          </p>
        )}
      </div>

      <div className="flex gap-3">
        <Button
          type="button"
          variant="outline"
          className="flex-1"
          onClick={handleTest}
          disabled={testing || saving}
        >
          {testing && !saving ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Wifi className="size-4" aria-hidden />
          )}
          {testing && !saving ? '测试中...' : '测试连接'}
        </Button>
        <Button
          type="button"
          className="flex-1"
          onClick={() => void handleSave()}
          disabled={testing || saving}
        >
          {saving ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Save className="size-4" aria-hidden />
          )}
          {saving ? saveLabels.busy : saveLabels.idle}
        </Button>
      </div>

      {/* 复制 / 粘贴导入（条目 23）：跨设备或多人共用同一面板时免手抄地址与 Key。
          两者都是「同一份配置换个载体」的辅助动作 → ghost，不占页面的次操作名额。 */}
      <div className="flex flex-wrap items-center gap-2 border-t border-mcs-border-muted pt-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void handleCopyConfig()}
          disabled={testing || saving}
        >
          <Copy className="size-3.5" aria-hidden />
          复制配置
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setImportOpen((v) => !v)
            setImportError('')
          }}
          aria-expanded={importOpen}
        >
          <ClipboardPaste className="size-3.5" aria-hidden />
          粘贴导入
        </Button>
        <InfoHint label="复制配置说明">
          复制出的文本含 API Key 明文，只应粘贴到你信任的设备；它相当于该面板的管理员凭据。
        </InfoHint>
      </div>

      {importOpen && (
        <div className="flex flex-col gap-2">
          <Label htmlFor="connection-import">粘贴连接配置</Label>
          <Textarea
            id="connection-import"
            value={importText}
            onChange={(e) => {
              setImportText(e.target.value)
              setImportError('')
            }}
            placeholder={['面板地址: https://192.168.1.100:25566', 'API Key: mc_…'].join('\n')}
            spellCheck={false}
            className="min-h-16 font-mono"
          />
          {importError !== '' && <p className="text-mcs-xs text-mcs-error-fg">{importError}</p>}
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={handleImport}>
              填入表单
            </Button>
            <span className="text-mcs-xs text-mcs-text-muted">
              只填入，不会自动保存——可先「测试连接」确认
            </span>
          </div>
        </div>
      )}
    </>
  )

  return (
    <div className={variant === 'onboarding' ? 'mx-auto w-full max-w-md' : 'w-full'}>
      {variant === 'onboarding' ? (
        <header className="mb-8 text-center">
          <HeadingTag className="text-mcs-xl font-semibold text-mcs-text-default">
            连接你的服务器
          </HeadingTag>
          <p className="mt-2 text-mcs-sm text-mcs-text-muted">
            输入 MC Commander 面板地址与 API Key，测试并保存连接配置后即可开始使用。
          </p>
        </header>
      ) : (
        <div
          className={cn(
            'flex items-center gap-2 rounded-mcs-md border px-4 py-3',
            isConnected
              ? toneClasses('success')
              : 'border-mcs-border-muted bg-mcs-bg-muted text-mcs-text-muted',
          )}
        >
          <span
            className={cn(
              'size-2 rounded-full',
              isConnected ? 'bg-mcs-success-fg' : 'bg-mcs-text-muted',
            )}
            aria-hidden
          />
          <span className="text-mcs-sm font-medium">{statusLabel}</span>
          {isConnected && latencyMs != null && (
            <span className="text-mcs-2xs text-mcs-text-muted">连接正常 · 延迟 {latencyMs}ms</span>
          )}
        </div>
      )}

      <Card as="div" className={cn('flex flex-col gap-5 p-6', variant === 'settings' && 'mt-4')}>
        {formFields}
      </Card>

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
