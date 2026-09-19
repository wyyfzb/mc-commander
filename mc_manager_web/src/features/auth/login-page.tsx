/**
 * LoginPage —— 管理员登录 / 首访设密（安全主线）
 * 三态自适应（探测 GET /auth/status 驱动）：
 *  - setup：后端未设密 → 首访设密向导（一次输入，成功即自动登录）
 *  - login：已设密 → 密码登录（服务端按 IP 锁定 10 次/5min）
 *  - unreachable：后端不可达 → 错误态 + 重试（此时才提供「连接其他面板地址」入口，渐进披露）
 * 细节：密码显隐切换 / CapsLock 提醒 / 强度条（引导性）/ returnTo 回跳 /
 *       装饰性网格纹理 / 公开端点探测不携带任何凭据头
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams, Link } from 'react-router'
import {
  ArrowRight,
  KeyRound,
  Loader2,
  Moon,
  RefreshCw,
  ServerOff,
  ShieldCheck,
  Sun,
  TriangleAlert,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { BrandLogo } from '@/components/mcs/brand-logo'
import { NoticeBanner } from '@/components/mcs/notice-banner'
import { Card } from '@/components/mcs/card'
import { Label } from '@/components/ui/label'
import { PasswordInput } from '@/components/ui/password-input'
import { cn } from '@/lib/utils'
import { panelAddress } from '@/lib/mc-connection'
import { fetchAuthStatus, login, setupPassword } from '@/api/auth'
import { ApiError, NetworkError } from '@/api/client'
import { ErrorCode, getFriendlyErrorText } from '@/api/errors'
import {
  SECOND_FACTOR_HINT,
  SECOND_FACTOR_PLACEHOLDER,
  SECOND_FACTOR_SHAPE_HINT,
  isSecondFactorSubmittable,
  sanitizeSecondFactorInput,
} from '@/lib/second-factor'
import { useAuthStore } from '@/stores/auth'
import { useConnectionStore } from '@/stores/connection'
import { useUiStore } from '@/stores/ui'
import {
  assessPasswordStrength,
  STRENGTH_BAR_STYLES,
  STRENGTH_TEXT_STYLES,
} from '@/lib/password-strength'

type Phase = 'probing' | 'setup' | 'login' | 'unreachable'

/** 服务端 AUTH_SETUP_TOKEN_INVALID：公网部署开启了首访设密所有权证明（issue 309） */
const AUTH_SETUP_TOKEN_INVALID_CODE = 40104

/**
 * 封禁文案（42901）。锁定时长由服务端 AUTH_LOGIN_LOCK_MS 决定、不回传，故这里只说量级
 * 与下一步动作，不编造一个精确倒计时去误导用户。
 */
function lockoutMessage(hadSecondFactor: boolean): string {
  const scope = hadSecondFactor ? '密码或验证码' : '密码'
  return `${scope}错误次数过多，登录已被暂时锁定（通常约 5 分钟），请稍后再试；锁定期间请勿反复提交。`
}

/** 强度条（4 段，score 决定填充段数与色阶） */
function StrengthBar({ score, label }: { score: number; label: string }) {
  return (
    <div className="space-y-1.5" aria-live="polite">
      <div className="flex gap-1" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className={cn(
              'h-1 flex-1 rounded-full transition-colors duration-mcs-base',
              i < score ? STRENGTH_BAR_STYLES[score] : 'bg-mcs-border-muted',
            )}
          />
        ))}
      </div>
      <p className={cn('text-mcs-2xs font-medium', STRENGTH_TEXT_STYLES[score])}>
        密码强度：{label}
        {score > 0 && score < 3 && '（建议混合大小写字母、数字与符号）'}
      </p>
    </div>
  )
}

export function LoginPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const returnTo = searchParams.get('returnTo') ?? '/dashboard'
  const theme = useUiStore((s) => s.theme)
  const toggleTheme = useUiStore((s) => s.toggleTheme)

  const [phase, setPhase] = useState<Phase>('probing')
  const [baseUrlOpen, setBaseUrlOpen] = useState(false)
  // 初值取 store 里已配置的地址：探测、登录 POST、会话绑定（issuedFor）三者
  // 落在同一地址——若初值为空串（同源），store 已配置分域地址时会出现
  // 「登录打到 A、会话却登记成属于 B」的凭据错配
  const [baseUrl, setBaseUrl] = useState(() => useConnectionStore.getState().baseUrl)
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  // 首访设密所有权证明（issue 309）：服务端返回 40104 时展示 SETUP_TOKEN 输入框
  const [needsSetupToken, setNeedsSetupToken] = useState(false)
  const [setupToken, setSetupToken] = useState('')
  /**
   * 第二因子（40105：密码已通过、服务端未签发会话）。
   * 就地展开验证码输入框——密码仍在 state 里原样保留，不跳页、不要求重输。
   */
  const [totpRequired, setTotpRequired] = useState(false)
  const [totpCode, setTotpCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [errorText, setErrorText] = useState('')
  const probeSeq = useRef(0)
  /** 用户是否显式处置过面板地址（见 handleAuthSuccess：未处置则不写回，避免空串覆盖已存地址） */
  const addressSettled = useRef(false)

  const strength = assessPasswordStrength(password)

  // 探测后端状态（公开端点；seq 防并发乱序）
  const probe = useCallback(async (base: string) => {
    const seq = ++probeSeq.current
    setPhase('probing')
    setErrorText('')
    setNeedsSetupToken(false)
    setSetupToken('')
    setTotpRequired(false)
    setTotpCode('')
    try {
      const status = await fetchAuthStatus(base)
      if (seq !== probeSeq.current) return
      setPhase(status.hasPassword ? 'login' : 'setup')
    } catch {
      if (seq !== probeSeq.current) return
      setPhase('unreachable')
    }
  }, [])

  useEffect(() => {
    void probe(baseUrl)
    // 仅首挂载探测一次；baseUrl 修改后由「探测」按钮显式触发
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- baseUrl 变化由探测按钮显式驱动
  }, [probe])

  /**
   * 登录/设密成功：写会话 → 同步连接状态 → 回跳。
   * 会话绑定「本浏览器将使用的面板地址」（issuedFor）：令牌只对它签发的面板有效，
   * 换地址后不再发 Bearer、也不会因该面板的 40103 把这次登录踢掉（见 api/client.ts）。
   * baseUrl 初值即 store 里已配置的地址，用户未处置时探测/登录/绑定天然同址；
   * 显式改过输入框则以填写值为准（绑定值与登录请求仍一致）。
   * 地址只在用户显式处置过（改过输入框 / 点过「恢复默认地址」）时写回：
   * 未触碰时的空串会经 setConfig 覆盖 localStorage 里的已配置地址
   * （stores/connection.ts 用 `??` 只挡 null/undefined，挡不住空串），
   * 分域部署下次进面板就找不到服务端了
   */
  const handleAuthSuccess = (token: string, sessionId: string, expiresAt: string) => {
    const connection = useConnectionStore.getState()
    useAuthStore.getState().setSession({
      token,
      sessionId,
      expiresAt,
      issuedFor: panelAddress(addressSettled.current ? baseUrl : connection.baseUrl),
    })
    if (addressSettled.current) connection.setConfig({ baseUrl })
    else connection.refreshStatus()
    toast.success(phase === 'setup' ? '管理员密码设置成功' : '登录成功')
    navigate(returnTo.startsWith('/') ? returnTo : '/dashboard', { replace: true })
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (submitting) return

    if (phase === 'setup') {
      if (strength.score === 0) {
        setErrorText('密码至少需要 8 位')
        return
      }
      if (password !== confirmPassword) {
        setErrorText('两次输入的密码不一致')
        return
      }
      if (needsSetupToken && !setupToken.trim()) {
        setErrorText('请输入 SETUP_TOKEN（部署完成时输出的一次性令牌）')
        return
      }
    }
    if (!password) {
      setErrorText('请输入管理员密码')
      return
    }
    // 第二因子已展开后，空值/形状不符都不发请求：错误尝试在服务端计入登录失败封禁，
    // 拿必然失败的往返去换一句「格式不对」是净损失
    if (totpRequired) {
      if (!totpCode) {
        setErrorText('请输入认证器中的 6 位验证码，或一枚恢复码')
        return
      }
      if (!isSecondFactorSubmittable(totpCode)) {
        setErrorText(SECOND_FACTOR_SHAPE_HINT)
        return
      }
    }

    setSubmitting(true)
    setErrorText('')
    try {
      const session =
        phase === 'setup'
          ? await setupPassword(baseUrl, password, needsSetupToken ? setupToken.trim() : undefined)
          : await login(baseUrl, password, totpRequired ? totpCode : undefined)
      handleAuthSuccess(session.token, session.sessionId, session.expiresAt)
    } catch (err) {
      if (err instanceof ApiError) {
        // 40911：探测到未设密后他人抢先设密 → 回登录模式重试
        if (err.code === 40911) {
          setPhase('login')
          setTotpRequired(false)
          setErrorText('管理员密码已被设置，请直接登录')
        } else if (err.code === AUTH_SETUP_TOKEN_INVALID_CODE) {
          // 40104：公网部署开启了首访设密所有权证明 → 展示 SETUP_TOKEN 输入框
          setNeedsSetupToken(true)
          setErrorText(err.message || 'SETUP_TOKEN 缺失或错误：请粘贴部署完成时输出的一次性令牌')
        } else if (err.code === ErrorCode.AUTH_TOTP_REQUIRED) {
          // 40105：密码已通过、仅缺第二因子。服务端此时未签发会话也未计失败，
          // 故这不是「错误」而是流程下一步——展开输入框，不用错误色播报
          setTotpRequired(true)
        } else if (err.code === ErrorCode.AUTH_TOTP_INVALID) {
          // 40106：第二因子错误（与密码错误 40102 分开提示）；清空已提交的码，避免原样重提
          setTotpRequired(true)
          setTotpCode('')
          setErrorText(getFriendlyErrorText(err))
        } else if (err.code === ErrorCode.AUTH_LOGIN_LOCKED) {
          // 42901：密码错与第二因子错共用同一封禁计数，文案随是否已进入第二因子区分
          setErrorText(lockoutMessage(totpRequired))
        } else if (err.code === ErrorCode.RATE_LIMITED) {
          // 42900：/api/ 通用洪泛限流（与登录失败计数无关）——复用封禁文案会把它
          // 谎报成「密码错误次数过多」，把限流说成凭据问题
          setErrorText('提交过于频繁，已被临时限流，请稍后再试（与密码是否正确无关）。')
        } else {
          setErrorText(getFriendlyErrorText(err))
        }
      } else if (err instanceof NetworkError) {
        setErrorText('网络连接失败，请检查面板地址与服务器状态')
      } else {
        setErrorText('操作失败，请重试')
      }
    } finally {
      setSubmitting(false)
    }
  }

  const heading =
    phase === 'setup'
      ? '设置管理员密码'
      : phase === 'login'
        ? totpRequired
          ? '两步验证'
          : '管理员登录'
        : '连接面板'

  return (
    <div className="mcs-shell-bg mcs-grain relative flex min-h-svh flex-col items-center justify-center overflow-hidden px-4 py-10">
      {/* 主题切换（本地偏好，与会话无关；登录态外仍可调） */}
      <button
        type="button"
        onClick={toggleTheme}
        aria-label={theme === 'dark' ? '切换到亮色主题' : '切换到深色主题'}
        className="absolute right-4 top-4 z-(--mcs-z-local) rounded-mcs-md p-2 text-mcs-text-muted transition-colors hover:bg-mcs-state-hover hover:text-mcs-text-default"
      >
        {theme === 'dark' ? (
          <Sun className="size-4" aria-hidden />
        ) : (
          <Moon className="size-4" aria-hidden />
        )}
      </button>

      {/* 装饰性方块网格（MC 世界语义，24px = 1 格；aria 隐藏） */}
      <div aria-hidden className="mcs-grid-bg mcs-grid-fade pointer-events-none absolute inset-0" />

      {/* 顶部品牌区：裸 logo 与侧栏同语言（无装饰容器），放大档位；items-stretch 令 logo 与两行文字等高 */}
      <div className="animate-mcs-fade-up relative z-(--mcs-z-local) mb-6 flex items-stretch gap-3">
        {/* 57.6px = 标题 22px + 副标题 14px 两行行高之和（1.6 行高系数），字号档位调整时需同步 */}
        <BrandLogo className="h-14 w-auto text-mcs-text-default" />
        <div>
          <h1 className="text-mcs-xl font-semibold text-mcs-text-default">MC Commander</h1>
          <p className="text-mcs-sm text-mcs-text-muted">Minecraft 服务器管理面板</p>
        </div>
      </div>

      {/* 登录卡片（浮起面：卡阴影 + 顶部受光线；stagger 入场跟随品牌区） */}
      <Card
        as="main"
        className="animate-mcs-fade-up mcs-delay-1 mcs-edge-top relative z-(--mcs-z-local) w-full max-w-md p-6"
      >
        <div className="mb-5">
          <h2 className="text-mcs-lg font-semibold text-mcs-text-default">{heading}</h2>
          <p className="mt-1 text-mcs-xs text-mcs-text-muted">
            {phase === 'setup'
              ? '首次使用：设置管理员密码后即可登录管理面板（8–128 位）'
              : phase === 'probing'
                ? '正在连接面板服务器…'
                : phase === 'unreachable'
                  ? '无法连接面板服务器，请检查部署状态'
                  : totpRequired
                    ? '该账号已启用两步验证：密码已通过，请输入认证器中的 6 位验证码'
                    : '输入管理员密码访问管理面板（会话有效期 7 天，支持滑动续期）'}
          </p>
        </div>

        {/* 探测中骨架 */}
        {phase === 'probing' && (
          <div
            className="flex flex-col items-center gap-3 py-8"
            role="status"
            aria-label="正在探测面板状态"
          >
            <Loader2 className="size-6 animate-spin text-mcs-text-muted" aria-hidden />
            <div className="w-full space-y-2">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          </div>
        )}

        {/* 不可达错误态 */}
        {phase === 'unreachable' && (
          <div className="space-y-4">
            <div
              role="alert"
              className="flex items-start gap-2.5 rounded-mcs-md border border-mcs-error-border bg-mcs-error-bg-subtle p-3"
            >
              <ServerOff className="mt-0.5 size-4 shrink-0 text-mcs-error-fg" aria-hidden />
              <div className="text-mcs-xs text-mcs-error-fg">
                <p className="font-semibold">连接失败</p>
                <p className="mt-0.5 opacity-90">
                  请确认面板服务端已启动（默认端口 25566）。
                  {baseUrl && ' 当前地址无法连接，可恢复默认地址重试。'}
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <Button type="button" className="h-10 flex-1" onClick={() => void probe(baseUrl)}>
                <RefreshCw className="size-4" aria-hidden />
                重新探测
              </Button>
              {baseUrl && (
                <Button
                  type="button"
                  variant="outline"
                  className="h-10 flex-1"
                  onClick={() => {
                    addressSettled.current = true
                    setBaseUrl('')
                    void probe('')
                  }}
                >
                  恢复默认地址
                </Button>
              )}
            </div>
            {/* 「连接其他地址」入口仅出现在连接失败时（渐进披露，正常路径不出现） */}
            <div>
              <button
                type="button"
                onClick={() => setBaseUrlOpen((v) => !v)}
                aria-expanded={baseUrlOpen}
                className="flex items-center gap-1 text-mcs-2xs font-medium text-mcs-text-muted transition-colors hover:text-mcs-text-default"
              >
                <span aria-hidden>{baseUrlOpen ? '▾' : '▸'}</span>
                尝试连接其他面板地址
              </button>
              {baseUrlOpen && (
                <div className="mt-2.5 space-y-2">
                  <Label htmlFor="base-url" className="text-mcs-2xs">
                    面板服务端地址（用于面板网页与服务端分开部署的场景）
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      id="base-url"
                      value={baseUrl}
                      onChange={(e) => {
                        addressSettled.current = true
                        setBaseUrl(e.target.value.trim())
                      }}
                      placeholder="http://your-server:25566"
                      className="h-8 font-mono text-mcs-xs"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8"
                      onClick={() => void probe(baseUrl)}
                    >
                      连接
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* 设密 / 登录表单 */}
        {(phase === 'setup' || phase === 'login') && (
          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <div className="space-y-2">
              <Label htmlFor="admin-password">管理员密码</Label>
              <PasswordInput
                id="admin-password"
                value={password}
                onChange={(v) => {
                  setPassword(v)
                  setErrorText('')
                  // 输入框不锁定、也不清空：改密码后第二因子需要重走一次（服务端按当前密码判是否已启用），
                  // 但已输入的验证码留着——它可能仍然有效，重新提交即可
                }}
                placeholder={phase === 'setup' ? '设置 8–128 位密码' : '输入密码'}
                autoComplete={phase === 'setup' ? 'new-password' : 'current-password'}
                autoFocus={!totpRequired}
              />
            </div>
            {phase === 'login' && totpRequired && (
              <div className="space-y-2">
                <Label htmlFor="totp-code">两步验证码</Label>
                <Input
                  id="totp-code"
                  value={totpCode}
                  onChange={(e) => {
                    setTotpCode(sanitizeSecondFactorInput(e.target.value))
                    setErrorText('')
                  }}
                  placeholder={SECOND_FACTOR_PLACEHOLDER}
                  // 一次性验证码的浏览器输入习惯：数字键盘 + 系统/密码管理器自动填充建议；
                  // 不自动提交（onChange 里凑满 6 位就发请求会让「码还没看清」也算一次错误尝试）
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  spellCheck={false}
                  className="font-mono"
                />
                <p className="text-mcs-2xs text-mcs-text-muted">{SECOND_FACTOR_HINT}</p>
              </div>
            )}
            {phase === 'setup' && (
              <div className="space-y-2">
                <Label htmlFor="confirm-password">确认密码</Label>
                {/* 与上方「管理员密码」同走 PasswordInput：打字错位的风险恰恰落在第二次输入上，
                    只让第一个框能显隐等于把最容易核对的那半藏起来 */}
                <PasswordInput
                  id="confirm-password"
                  value={confirmPassword}
                  onChange={(v) => {
                    setConfirmPassword(v)
                    setErrorText('')
                  }}
                  placeholder="再次输入密码"
                  autoComplete="new-password"
                />
              </div>
            )}
            {phase === 'setup' && needsSetupToken && (
              <div className="space-y-2">
                <Label htmlFor="setup-token">SETUP_TOKEN（一次性，部署完成时输出）</Label>
                <PasswordInput
                  id="setup-token"
                  value={setupToken}
                  onChange={(v) => {
                    setSetupToken(v)
                    setErrorText('')
                  }}
                  placeholder="粘贴部署输出中的 SETUP_TOKEN"
                  autoComplete="off"
                />
                <p className="text-mcs-2xs text-mcs-text-muted">
                  该面板已开启部署保护：公网部署场景下需证明您是部署者（令牌见部署脚本完成输出，用后即作废）。
                </p>
              </div>
            )}
            {phase === 'setup' && (password.length > 0 || confirmPassword.length > 0) && (
              <StrengthBar score={strength.score} label={strength.label} />
            )}

            {errorText ? (
              <NoticeBanner variant="error" role="alert" icon={TriangleAlert}>
                {errorText}
              </NoticeBanner>
            ) : (
              // 40105 是流程的下一步而不是错误（服务端未计失败、也未签发会话）：
              // 用 info 级常驻提示引导，不用错误色播报一次并未发生的失败
              phase === 'login' &&
              totpRequired && (
                <NoticeBanner variant="info" icon={ShieldCheck}>
                  请输入认证器中的 6 位验证码；手机不在身边时可改用一枚恢复码（恢复码用后即作废）。
                </NoticeBanner>
              )
            )}

            <Button type="submit" className="h-10 w-full font-semibold" disabled={submitting}>
              {submitting ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : totpRequired ? (
                <ShieldCheck className="size-4" aria-hidden />
              ) : (
                <KeyRound className="size-4" aria-hidden />
              )}
              {phase === 'setup' ? '设置密码并登录' : totpRequired ? '验证并登录' : '登录'}
              {!submitting && <ArrowRight className="size-4" aria-hidden />}
            </Button>
          </form>
        )}
      </Card>

      {/* 底部辅助链接 */}
      <footer className="animate-mcs-fade-up mcs-delay-2 relative z-(--mcs-z-local) mt-6 flex flex-col items-center gap-1.5 text-center">
        <p className="text-mcs-2xs text-mcs-text-muted">
          使用 API Key 直连（自动化 / 运维场景）？{' '}
          <Link
            to="/onboarding"
            className="font-medium text-mcs-accent-fg underline-offset-2 hover:underline"
          >
            前往连接引导
          </Link>
        </p>
        <p className="text-mcs-2xs text-mcs-text-muted">
          会话可在「设置 → 账号与安全」中随时下线或踢出其他设备
        </p>
      </footer>
    </div>
  )
}
