/**
 * TotpPanel —— 设置页「两步验证」挂靠向导（安全主线）
 *
 * 状态机（服务端 GET /auth/totp/status 驱动）：
 *  - 未启用：入口按钮 → POST /auth/totp/enroll 生成候选密钥与二维码；
 *  - 挂靠中：二维码（服务端产生的 data URL）+ 密钥文本（无法扫码时手动输入）+ 6 位码 → POST /auth/totp/confirm；
 *  - 确认成功：一次性展示 10 枚恢复码（服务端唯一的明文出口，之后只剩「剩余 N 个」）；
 *  - 已启用：显示启用时间与剩余恢复码数 → POST /auth/totp/disable（密码 + 第二因子双证）。
 *
 * 「只显示一次」由结构保证：恢复码仅存在于 confirm 响应，组件只用 state 暂存（不落 localStorage、
 * 不进 query 缓存），用户确认已保存后即从 state 清空并失效状态查询——刷新/重挂/切子页都拿不回来，
 * 这与服务端只存哈希的事实一致，不是显示层的刻意隐藏。
 *
 * 启用与关闭都会吊销其它会话（保留当前），故两处成功提示都明确说明「其它设备已登出」。
 * 设计纪律：实底卡（玻璃禁区）+ --mcs-* 语义 token + 危险动作只走 ui/button 的危险变体。
 */
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Check,
  Copy,
  Download,
  KeyRound,
  Loader2,
  Lock,
  ShieldCheck,
  Smartphone,
  TriangleAlert,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PasswordInput } from '@/components/ui/password-input'
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'
import { NoticeBanner } from '@/components/mcs/notice-banner'
import { LoadingButton } from '@/components/mcs/loading-button'
import { InfoHint } from '@/components/mcs/info-hint'
import { SettingsSectionCard } from './settings-section-card'
import { confirmTotp, disableTotp, enrollTotp, fetchTotpStatus } from '@/api/auth'
import type { TotpEnrollData } from '@/api/auth'
import { queryKeys } from '@/api/queries'
import { getFriendlyErrorText } from '@/api/errors'
import { copyText } from '@/lib/clipboard'
import { formatStartTime } from '@/lib/format'
import {
  SECOND_FACTOR_HINT,
  SECOND_FACTOR_PLACEHOLDER,
  SECOND_FACTOR_SHAPE_HINT,
  isSecondFactorSubmittable,
  sanitizeSecondFactorInput,
} from '@/lib/second-factor'

interface TotpPanelProps {
  baseUrl: string
  apiKey: string
  /** 是否具备认证通道（会话或 API Key）；false 时只渲染说明，不发请求 */
  authed: boolean
}

/**
 * 恢复码告警阈值：剩余 ≤ 3 即提示（服务端一次发 10 枚）。
 * 口径依据（单管理员自托管、无客服兜底）：恢复码与认证器是仅有的两条第二因子路径，
 * 码用光后若认证器同时不可用即永久锁死面板，而补发只能「关闭两步验证再重新挂靠」——
 * 代价高且必须先能登录。同类实现均取保守方向：Keycloak 12 枚码在剩 4 枚时提示、
 * Duende 在剩余 <3 时提示，本面板码更少（10 枚），故阈值取 3（少于半数即告警）。
 */
const RECOVERY_CODE_WARN_THRESHOLD = 3

/** 恢复码文件正文：码是本体的全部，头部只留「何时、何用、用完怎么办」 */
function recoveryCodesFileText(codes: string[]): string {
  return [
    'MC Commander 两步验证恢复码',
    '每枚仅可使用一次；登录或关闭两步验证时替代 6 位动态口令。',
    '请离线保存，不要在聊天/邮件中传输。',
    '',
    ...codes,
    '',
  ].join('\n')
}

/** 恢复码下载（原生 Blob + ObjectURL，不引入依赖；用完即回收对象 URL） */
function downloadRecoveryCodes(codes: string[]): boolean {
  const createUrl = typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
  if (!createUrl) return false
  try {
    const blob = new Blob([recoveryCodesFileText(codes)], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'mc-commander-recovery-codes.txt'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
    return true
  } catch {
    return false
  }
}

export function TotpPanel({ baseUrl, apiKey, authed }: TotpPanelProps) {
  const queryClient = useQueryClient()
  const config = { baseUrl, apiKey }

  const statusQuery = useQuery({
    queryKey: queryKeys.totpStatus(),
    queryFn: ({ signal }) => fetchTotpStatus(config, signal),
    enabled: authed,
  })

  /** 挂靠中的候选材料（secret/二维码）；null = 未在挂靠 */
  const [enrollment, setEnrollment] = useState<TotpEnrollData | null>(null)
  const [confirmCode, setConfirmCode] = useState('')
  const [enrolling, setEnrolling] = useState(false)
  const [confirming, setConfirming] = useState(false)
  /**
   * 恢复码暂存区：confirm 成功时写入，用户确认已保存后清空。
   * 刻意用 state 而非 query 缓存/fetch 结果留存——缓存会跨挂载存活，「只显示一次」就成了空话
   */
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null)
  const [errorText, setErrorText] = useState('')
  const [copiedSecret, setCopiedSecret] = useState(false)

  // ── 关闭两步验证（密码 + 第二因子双证）──
  const [disableOpen, setDisableOpen] = useState(false)
  const [disablePassword, setDisablePassword] = useState('')
  const [disableCode, setDisableCode] = useState('')
  const [disableError, setDisableError] = useState('')
  const [disabling, setDisabling] = useState(false)

  const enabled = statusQuery.data?.enabled ?? false

  async function handleEnroll() {
    setEnrolling(true)
    setErrorText('')
    try {
      setEnrollment(await enrollTotp(config))
      setConfirmCode('')
    } catch (err) {
      setErrorText(getFriendlyErrorText(err))
    } finally {
      setEnrolling(false)
    }
  }

  async function handleConfirm(e: React.FormEvent) {
    e.preventDefault()
    if (confirming) return
    if (!/^\d{6}$/.test(confirmCode)) {
      setErrorText('请输入认证器中显示的 6 位验证码')
      return
    }
    setConfirming(true)
    setErrorText('')
    try {
      const res = await confirmTotp(config, confirmCode)
      setRecoveryCodes(res.recoveryCodes)
      setEnrollment(null)
      setConfirmCode('')
      void queryClient.invalidateQueries({ queryKey: queryKeys.totpStatus() })
    } catch (err) {
      setErrorText(getFriendlyErrorText(err))
    } finally {
      setConfirming(false)
    }
  }

  async function handleCopy(text: string, successText: string): Promise<boolean> {
    const ok = await copyText(text)
    if (ok) toast.success(successText)
    else toast.error('复制失败，请手动选中复制')
    return ok
  }

  /** 「我已保存」：清空明文暂存并收起一次性面板；此后页面只剩「剩余 N 个」 */
  function handleCodesSaved() {
    setRecoveryCodes(null)
    setCopiedSecret(false)
    toast.success('恢复码已收起。如未保存，可关闭两步验证后重新挂靠以重新生成')
  }

  async function handleDisable() {
    if (disabling) return
    if (!disablePassword) {
      setDisableError('请输入管理员密码')
      return
    }
    if (!disableCode) {
      setDisableError('请输入 6 位验证码或一枚恢复码')
      return
    }
    // 与登录页同口径的前置拦截：形状不符的串服务端必拒，而这个往返同样计入登录失败封禁
    if (!isSecondFactorSubmittable(disableCode)) {
      setDisableError(SECOND_FACTOR_SHAPE_HINT)
      return
    }
    setDisabling(true)
    setDisableError('')
    try {
      await disableTotp(config, disablePassword, disableCode)
      setDisableOpen(false)
      setDisablePassword('')
      setDisableCode('')
      setEnrollment(null)
      setRecoveryCodes(null)
      toast.success('两步验证已关闭，其它设备已登出')
      void queryClient.invalidateQueries({ queryKey: queryKeys.totpStatus() })
    } catch (err) {
      setDisableError(getFriendlyErrorText(err))
    } finally {
      setDisabling(false)
    }
  }

  const body = (() => {
    if (!authed) {
      return (
        <p className="text-mcs-xs text-mcs-text-muted">
          两步验证需要登录会话或 API Key 才能配置：请先完成连接配置。
        </p>
      )
    }
    if (statusQuery.isLoading) {
      return (
        <div className="flex items-center gap-2 py-4 text-mcs-xs text-mcs-text-muted" role="status">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          正在读取两步验证状态…
        </div>
      )
    }
    if (statusQuery.isError) {
      return (
        <div className="flex flex-col items-start gap-2 py-2">
          <p className="text-mcs-xs text-mcs-error-fg">
            两步验证状态读取失败：{getFriendlyErrorText(statusQuery.error)}
          </p>
          <Button variant="outline" size="sm" onClick={() => void statusQuery.refetch()}>
            重试
          </Button>
        </div>
      )
    }

    // ── 一次性恢复码（confirm 成功后独占整个区块，必须先处置再谈其它） ──
    if (recoveryCodes) {
      return (
        <div className="space-y-3">
          <NoticeBanner variant="warning" role="alert" icon={TriangleAlert}>
            <strong className="font-semibold">这些恢复码只显示这一次</strong>
            ：离开或刷新本页面后无法再次查看，请立即保存到离线处；每枚只能使用一次。
          </NoticeBanner>
          <ul
            aria-label="两步验证恢复码"
            className="grid grid-cols-1 gap-2 rounded-mcs-md border border-mcs-border-default bg-mcs-bg-default p-3 font-mono text-mcs-md sm:grid-cols-2"
          >
            {recoveryCodes.map((code) => (
              <li key={code} className="select-all tracking-wider text-mcs-text-default">
                {code}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            {/* 「复制全部」与「下载 .txt」都是把同一份文本带走的**无后果辅助动作**，
                不构成独立的次操作决策 → 两者都走 ghost（ghost 不计配额）。
                本卡此状态下的实义动作只有「我已保存」（唯一的实底→已按页内口径降为 outline）。 */}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() =>
                void handleCopy(recoveryCodesFileText(recoveryCodes), '恢复码已复制到剪贴板')
              }
            >
              <Copy className="size-3.5" aria-hidden />
              复制全部
            </Button>
            {/* 「下载 .txt」是「复制全部」的等价出口（同一份文本的另一种带走方式），
                不是独立次操作：合并为一个名额（同页的「重试」同理）。 */}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                if (downloadRecoveryCodes(recoveryCodes)) toast.success('恢复码文件已开始下载')
                else toast.error('当前环境不支持直接下载，请改用「复制全部」')
              }}
            >
              <Download className="size-3.5" aria-hidden />
              下载 .txt
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={handleCodesSaved}>
              <Check className="size-3.5" aria-hidden />
              我已保存
            </Button>
          </div>
          <p className="text-mcs-xs text-mcs-text-muted">
            保存后关闭本提示，页面只显示剩余可用数量。
          </p>
        </div>
      )
    }

    // ── 挂靠中：二维码 + 密钥 + 6 位码 ──
    if (enrollment) {
      return (
        <form onSubmit={handleConfirm} className="space-y-4" noValidate>
          <ol className="space-y-1 text-mcs-xs text-mcs-text-muted">
            <li>1. 打开认证器 App（Google Authenticator、1Password 等），扫描下方二维码。</li>
            <li>2. 无法扫码时，手动输入下方密钥。</li>
            <li>3. 输入 App 中显示的 6 位验证码完成挂靠。</li>
          </ol>
          <div className="flex flex-col gap-4 sm:flex-row">
            <img
              src={enrollment.qrDataUrl}
              width={180}
              height={180}
              alt="两步验证二维码：用认证器 App 扫描后可自动添加本面板"
              // 服务端 PNG 自带白色静默区与深色模块，宿主面必须保持亮底（--mcs-qr-surface
              // 是主题无关的亮面 token）：暗色主题下换深底会把二维码埋进底色，扫码必失败。
              // object-contain：服务端给的是 240px 方图，框内留 8px 白边后须等比缩放，
              // 否则 top-left 裁切会啃掉定位图案所在的角
              className="h-45 w-45 shrink-0 self-start rounded-mcs-md border border-mcs-border-muted bg-mcs-qr-surface object-contain p-2"
            />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex items-center gap-1">
                <Label htmlFor="totp-secret">密钥（无法扫码时手动输入）</Label>
                <InfoHint label="密钥安全说明">
                  密钥等同第二因子凭据，请勿截图外发；挂靠完成前它不会生效。
                </InfoHint>
              </div>
              <div className="flex gap-2">
                <Input
                  id="totp-secret"
                  value={enrollment.secret}
                  readOnly
                  spellCheck={false}
                  className="font-mono"
                />
                {/* 复制是无后果的辅助动作 → ghost（与终端工具栏的复制、仪表盘「存为预设」同档） */}
                <Button
                  type="button"
                  variant="ghost"
                  className="shrink-0"
                  onClick={() =>
                    void handleCopy(enrollment.secret, '密钥已复制到剪贴板').then((ok) =>
                      setCopiedSecret(ok),
                    )
                  }
                >
                  {copiedSecret ? (
                    <Check className="size-3.5" aria-hidden />
                  ) : (
                    <Copy className="size-3.5" aria-hidden />
                  )}
                  {copiedSecret ? '已复制' : '复制'}
                </Button>
              </div>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="totp-confirm-code">认证器中的 6 位验证码</Label>
            <Input
              id="totp-confirm-code"
              value={confirmCode}
              onChange={(e) => {
                setConfirmCode(sanitizeSecondFactorInput(e.target.value))
                setErrorText('')
              }}
              placeholder="000000"
              inputMode="numeric"
              autoComplete="one-time-code"
              spellCheck={false}
              className="max-w-40 font-mono tracking-[0.2em]"
            />
          </div>
          {errorText && (
            <NoticeBanner variant="error" role="alert" icon={TriangleAlert}>
              {errorText}
            </NoticeBanner>
          )}
          <div className="flex flex-wrap gap-2">
            {/* 挂靠过程是**本卡的临时状态**（取消即退回稳态），其动作按覆盖层口径判：
                一个实底主操作 + ≤2 outline。故「复制」「取消」走 outline，
                「完成挂靠」是唯一实底——但页内已有「更新密码」这个实底，
                故它同样降为 outline，全页实底只留一个（见上「启用两步验证」处注释）。 */}
            <LoadingButton
              type="submit"
              variant="outline"
              loading={confirming}
              loadingText="确认中…"
            >
              <ShieldCheck aria-hidden />
              完成挂靠
            </LoadingButton>
            {/* 「取消」是无后果的退出口（退回稳态，不改任何服务端状态）→ ghost；
                ghost/link 明确不计入配额（见审查指南 §CTA 配额末条）。 */}
            <Button
              type="button"
              variant="ghost"
              disabled={confirming}
              onClick={() => {
                setEnrollment(null)
                setConfirmCode('')
                setErrorText('')
              }}
            >
              取消
            </Button>
          </div>
        </form>
      )
    }

    // ── 已启用 ──
    if (enabled) {
      const remainingRecoveryCodes = statusQuery.data?.recoveryCodesRemaining ?? 0
      return (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-mcs-xs text-mcs-text-muted">
            <span className="inline-flex items-center gap-1 font-medium text-mcs-success-fg">
              <ShieldCheck className="size-3.5" aria-hidden />
              已启用
            </span>
            <span>启用时间：{formatStartTime(statusQuery.data?.confirmedAt ?? null)}</span>
            <span>
              剩余恢复码：
              <span className="font-mono text-mcs-text-default">{remainingRecoveryCodes}</span> 个
            </span>
          </div>
          {remainingRecoveryCodes <= RECOVERY_CODE_WARN_THRESHOLD && (
            <NoticeBanner variant="warning" icon={TriangleAlert}>
              可用恢复码仅剩 {remainingRecoveryCodes} 枚：用完将无法在没有认证器的情况下登录。
              需要新的一批，只能关闭两步验证后重新挂靠。
            </NoticeBanner>
          )}
          <Button
            type="button"
            variant="destructive-outline"
            onClick={() => {
              setDisablePassword('')
              setDisableCode('')
              setDisableError('')
              setDisableOpen(true)
            }}
          >
            <Lock aria-hidden />
            关闭两步验证
          </Button>
          <p className="text-mcs-xs text-mcs-text-muted">
            关闭后本账号回到「仅密码」单因素状态，安全性降低；关闭不会卸载认证器里的条目。
          </p>
        </div>
      )
    }

    // ── 未启用 ──
    return (
      <div className="space-y-3">
        {errorText && (
          <NoticeBanner variant="error" role="alert" icon={TriangleAlert}>
            {errorText}
          </NoticeBanner>
        )}
        <div className="flex items-center gap-2">
          {/* outline 不是实底：本页的实底主操作是「更新密码」（表单提交，页内唯一）。
              TOTP 状态机按钮是无后果的引导动作，若也用实底，本页同屏会出现两个发光绿按钮
              （实测未启用态：更新密码 + 启用两步验证），主操作失去唯一性。
              同页稳态（未启用/已启用）经此收口即回到「1 实底 + ≤2 outline」配额内。 */}
          <LoadingButton
            type="button"
            variant="outline"
            loading={enrolling}
            loadingText="生成中…"
            onClick={() => void handleEnroll()}
          >
            <Smartphone aria-hidden />
            启用两步验证
          </LoadingButton>
          <InfoHint label="两步验证说明">
            当前仅用密码登录。启用两步验证后，登录还需输入认证器生成的 6 位验证码（服务端会同时给出
            10 枚一次性恢复码，供手机丢失时使用）。
          </InfoHint>
        </div>
      </div>
    )
  })()

  return (
    <>
      <SettingsSectionCard
        icon={KeyRound}
        title="两步验证（TOTP）"
        description="登录时除密码外再校验认证器动态口令；启用或关闭都会让其它设备下线"
      >
        {body}
      </SettingsSectionCard>

      <ConfirmDialog
        open={disableOpen}
        onOpenChange={(open) => {
          if (!open && !disabling) {
            setDisableOpen(false)
            setDisablePassword('')
            setDisableCode('')
            setDisableError('')
          }
        }}
        title="关闭两步验证？"
        description="关闭后本账号回到「仅密码」单因素状态，安全性降低；其它设备会被登出（当前浏览器保持登录）。恢复码将一并作废。"
        confirmText="关闭两步验证"
        danger
        loading={disabling}
        confirmDisabled={!disablePassword || !disableCode}
        onConfirm={() => void handleDisable()}
      >
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="totp-disable-password">管理员密码</Label>
            <PasswordInput
              id="totp-disable-password"
              value={disablePassword}
              onChange={(v) => {
                setDisablePassword(v)
                setDisableError('')
              }}
              autoComplete="current-password"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="totp-disable-code">两步验证码</Label>
            <Input
              id="totp-disable-code"
              value={disableCode}
              onChange={(e) => {
                setDisableCode(sanitizeSecondFactorInput(e.target.value))
                setDisableError('')
              }}
              placeholder={SECOND_FACTOR_PLACEHOLDER}
              inputMode="numeric"
              autoComplete="one-time-code"
              spellCheck={false}
              className="font-mono"
            />
            <p className="text-mcs-xs text-mcs-text-muted">{SECOND_FACTOR_HINT}</p>
          </div>
          {disableError && (
            <NoticeBanner variant="error" role="alert" icon={TriangleAlert}>
              {disableError}
            </NoticeBanner>
          )}
        </div>
      </ConfirmDialog>
    </>
  )
}
