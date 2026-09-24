/**
 * ReadonlyCredentialPanel —— 设置页「只读监控凭据」管理
 *
 * 背景：只读机器凭据（`READONLY_API_KEY_HASH`）此前只能改服务端 `.env` 或手调
 * `POST /rotate-readonly-key`——而「未配置 = 该通道不存在」（fail-closed），手工改 .env
 * 又要求部署方自己算 SHA-256 摘要。本面板把这条生命周期搬进浏览器：状态可见（通道开关 +
 * 是否已创建）、一键生成/轮换、明文一次性展示（与轮换端点同一口径：明文不落盘）。
 *
 * 三个设计取舍：
 * 1. 放在「账号与安全」而非「连接设置」：它管的是**面板侧的机器凭据**，不影响本浏览器
 *    的认证通道（连接表单里的 API Key 轮换会改写本机凭据，两者语义不同，混在一处会让人
 *    以为生成只读凭据会改变自己的连接）。
 * 2. 明文只在本次响应的组件 state 里：不写 store、不进 localStorage、不写 query 缓存——
 *    服务端只存摘要，页面刷新后再也拿不回来（与 TOTP 恢复码同款「只显示一次」结构）。
 * 3. 关闭态（READONLY_API_KEY_ENABLED=false）不禁用整个区块：入口禁用 + 说明恢复方法，
 *    否则用户只会看到一个「点了必然 403」的按钮或一个凭空消失的功能。
 * 4. 状态未知（探测失败）时**不猜**：既保留生成入口（同 connection-form 的取舍——误隐藏
 *    比误显示糟，点下去服务端会 fail-closed），又强制走二次确认（不知道是否已配置，
 *    就不能假定「这是首次生成」而省掉「旧凭据立即失效」的告知）。加载中只给 spinner：
 *    那是瞬态，没有可操作的下一步。
 */
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, Eye, KeyRound, Loader2, RefreshCw, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'
import { LoadingButton } from '@/components/mcs/loading-button'
import { NoticeBanner } from '@/components/mcs/notice-banner'
import { StatusPill } from '@/components/mcs/status-pill'
import { InfoHint } from '@/components/mcs/info-hint'
import { SettingsSectionCard as SectionCard } from './settings-section-card'
import { fetchAuthCapabilities, rotateReadonlyKey } from '@/api/auth'
import { queryKeys } from '@/api/queries'
import { getFriendlyErrorText } from '@/api/errors'
import { copyText } from '@/lib/clipboard'

interface ReadonlyCredentialPanelProps {
  baseUrl: string
  apiKey: string
  /** 是否具备认证通道（会话或 API Key）；false 时只渲染说明，不发请求 */
  authed: boolean
}

/** 只读凭据的能力边界（与 SECURITY.md「只读机器凭据」表一致，界面只讲结论不抄表） */
const READONLY_SCOPE_HINT =
  '只读凭据仅能访问 5 个读数端点（概览 / 系统指标 / 实例列表与状态 / 实例玩家列表），' +
  '其余端点一律 403；WebSocket 可连接但只收读数类事件（状态 / 性能 / 天气 / 玩家在线情况），' +
  '日志与命令原文、聊天、备份、任务、Webhook、部署与升级不下发；实例状态字段中 jvmArgs / ' +
  'startCommand / javaPath / seed 会被裁掉。'

export function ReadonlyCredentialPanel({ baseUrl, apiKey, authed }: ReadonlyCredentialPanelProps) {
  const queryClient = useQueryClient()
  const [issuedKey, setIssuedKey] = useState<string | null>(null)
  const [rotating, setRotating] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  // 不复用 @/api/queries 的 useApiKeyCapabilities：那里的 enabled 含「地址必须可解析为
  // 绝对 URL」，而本页的合法形态包含同源部署（baseUrl 为空串，配置里就是这么存的），
  // 复用会让同源部署下探测永不触发。queryKey 与它保持一致，缓存仍互为共享。
  const capabilities = useQuery({
    queryKey: queryKeys.authCapabilities(baseUrl, apiKey || ''),
    queryFn: () => fetchAuthCapabilities({ baseUrl, apiKey }),
    enabled: authed,
    staleTime: 60_000,
    retry: false,
  })

  const channelDisabled = capabilities.data?.readonlyApiKeyEnabled === false
  const configured = capabilities.data?.readonlyApiKeyConfigured === true
  /**
   * 是否需要二次确认：已知「已配置」、或状态未知（探测失败）、或本次已展示过明文——
   * 三种情形都不能假定「这是首次生成」，否则会在用户不知情时作废一把在用的凭据
   */
  const needsConfirm = configured || capabilities.isError || issuedKey !== null
  const busy = rotating

  async function handleRotate() {
    setConfirmOpen(false)
    setRotating(true)
    try {
      const res = await rotateReadonlyKey({ baseUrl, apiKey })
      setIssuedKey(res.apiKey)
      setCopied(false)
      void queryClient.invalidateQueries({
        queryKey: queryKeys.authCapabilities(baseUrl, apiKey || ''),
      })
      toast.success(configured ? '新只读凭据已生成，旧凭据立即失效' : '只读凭据已生成')
    } catch (err) {
      toast.error(`生成失败：${getFriendlyErrorText(err)}`)
    } finally {
      setRotating(false)
    }
  }

  async function handleCopy() {
    if (!issuedKey) return
    const ok = await copyText(issuedKey)
    if (ok) {
      setCopied(true)
      toast.success('只读凭据已复制')
    } else {
      toast.error('复制失败，请手动选中复制')
    }
  }

  /** 生成入口（正常态与未知态共用一处，避免两份文案/禁用条件漂移） */
  function renderActions() {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <LoadingButton
          type="button"
          variant="outline"
          size="sm"
          loading={busy}
          disabled={channelDisabled}
          onClick={() => (needsConfirm ? setConfirmOpen(true) : void handleRotate())}
        >
          {!busy && <RefreshCw className="size-3.5" aria-hidden />}
          {configured ? '重新生成只读凭据' : '生成只读凭据'}
        </LoadingButton>
        <InfoHint label="只读凭据明文说明">
          明文只在生成后显示一次；服务端只存 SHA-256 摘要。
        </InfoHint>
      </div>
    )
  }

  const body = (() => {
    if (!authed) {
      return (
        <p className="text-mcs-xs text-mcs-text-muted">
          只读凭据需要登录会话或 API Key 才能管理：请先完成连接配置。
        </p>
      )
    }
    if (capabilities.isLoading) {
      return (
        <div className="flex items-center gap-2 py-4 text-mcs-xs text-mcs-text-muted" role="status">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          正在读取凭据状态…
        </div>
      )
    }
    if (capabilities.isError) {
      // 未知态不猜状态，但**保留入口**（误隐藏会让用户以为没这个能力且无从恢复）；
      // 生成动作本身由服务端兜底（通道关闭/只读身份都会 403），并强制二次确认
      return (
        <div className="space-y-3">
          <div className="flex flex-col items-start gap-2 py-2">
            <p className="text-mcs-xs text-mcs-error-fg">
              凭据状态读取失败：{getFriendlyErrorText(capabilities.error)}
              （当前状态未知：下方入口仍可用，生成前会再确认一次）
            </p>
            <Button variant="outline" size="sm" onClick={() => void capabilities.refetch()}>
              重试
            </Button>
          </div>
          {renderActions()}
        </div>
      )
    }
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2.5">
          {channelDisabled ? (
            <StatusPill variant="outline" tone="warning" className="gap-1">
              <TriangleAlert className="size-3" aria-hidden />
              通道已关闭
            </StatusPill>
          ) : configured ? (
            <StatusPill tone="success" className="gap-1">
              <Check className="size-3" aria-hidden />
              已配置
            </StatusPill>
          ) : (
            <StatusPill variant="outline" tone="accent" className="gap-1">
              <KeyRound className="size-3" aria-hidden />
              尚未创建
            </StatusPill>
          )}
          <InfoHint label="只读凭据权限范围">{READONLY_SCOPE_HINT}</InfoHint>
        </div>

        {channelDisabled && (
          <NoticeBanner variant="warning" icon={TriangleAlert}>
            只读凭据通道已被部署配置关闭（
            <code className="font-mono">READONLY_API_KEY_ENABLED=false</code>）：
            携带该凭据的请求一律 403，生成入口不可用。需要在服务端把该值改回
            <code className="font-mono">true</code> 并重启面板后，本入口才会恢复。
          </NoticeBanner>
        )}

        {/* role=status（polite）而非 alert：这块内容是 76 字符的凭据，目标是让用户复制
            保存，不需要打断式朗读（TotpPanel 的恢复码块是 10 行短码，故用 alert） */}
        {issuedKey && (
          <div
            className="space-y-2 rounded-mcs-md border border-mcs-accent-border bg-mcs-accent-bg-subtle p-3"
            role="status"
          >
            <p className="flex items-center gap-1.5 text-mcs-xs font-medium text-mcs-text-default">
              <Eye className="size-3.5" aria-hidden />
              只读凭据（只显示这一次，请立即保存到监控端）
            </p>
            <code className="block break-all rounded-mcs-sm bg-mcs-bg-muted px-2.5 py-2 font-mono text-mcs-xs text-mcs-text-default">
              {issuedKey}
            </code>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => void handleCopy()}>
                {copied ? (
                  <Check className="size-3.5" aria-hidden />
                ) : (
                  <Copy className="size-3.5" aria-hidden />
                )}
                复制
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setIssuedKey(null)}>
                我已保存，收起
              </Button>
            </div>
            <p className="text-mcs-xs text-mcs-text-muted">
              服务端只保存摘要，收起或刷新后无法再次查看；如需换一把，重新生成即可（旧凭据随即失效）。
            </p>
          </div>
        )}

        {renderActions()}
      </div>
    )
  })()

  return (
    <SectionCard
      icon={KeyRound}
      title="只读监控凭据"
      description={
        <span className="inline-flex flex-wrap items-center gap-1">
          供监控 / 仪表盘等常驻自动化使用的低权限凭据
          <InfoHint label="只读凭据定位说明">
            与管理员 API Key
            是两条独立通道：只读凭据仅覆盖读数端点，泄漏时可单独作废而不影响管理通道。
          </InfoHint>
        </span>
      }
    >
      {body}

      {/* 唯一的确认弹窗（状态未知时也走它，不另挂一个）：文案据实分叉——
          已知已配置时是「确定会作废旧凭据」，状态未知时只能说「若已有则会作废」 */}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={configured ? '重新生成只读凭据？' : '生成只读凭据？'}
        description={
          configured
            ? '旧凭据立即失效：正在使用它的监控脚本/仪表盘需要更新为新凭据后才能继续读数。'
            : '当前无法确认服务端是否已有只读凭据：若已有，旧凭据将立即失效，正在使用它的监控需要更新。'
        }
        confirmText={configured ? '重新生成' : '生成'}
        danger
        onConfirm={() => void handleRotate()}
      />
    </SectionCard>
  )
}
