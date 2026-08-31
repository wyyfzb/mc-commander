/**
 * LoginPage —— 管理员登录 / 首访设密（安全主线）
 * 三态自适应（探测 GET /auth/status 驱动）：
 *  - setup：后端未设密 → 首访设密向导（一次输入，成功即自动登录）
 *  - login：已设密 → 密码登录（服务端按 IP 锁定 10 次/5min）
 *  - unreachable：后端不可达 → 错误态 + 重试（高级区可改面板地址）
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
import { Label } from '@/components/ui/label'
import { PasswordInput } from '@/components/ui/password-input'
import { cn } from '@/lib/utils'
import { fetchAuthStatus, login, setupPassword } from '@/api/auth'
import { ApiError, NetworkError } from '@/api/client'
import { getFriendlyErrorText } from '@/api/errors'
import { useAuthStore } from '@/stores/auth'
import { useConnectionStore } from '@/stores/connection'
import { useUiStore } from '@/stores/ui'
import {
  assessPasswordStrength,
  STRENGTH_BAR_STYLES,
  STRENGTH_TEXT_STYLES,
} from '@/lib/password-strength'

type Phase = 'probing' | 'setup' | 'login' | 'unreachable'

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
  const [baseUrl, setBaseUrl] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [errorText, setErrorText] = useState('')
  const probeSeq = useRef(0)

  const strength = assessPasswordStrength(password)

  // 探测后端状态（公开端点；seq 防并发乱序）
  const probe = useCallback(async (base: string) => {
    const seq = ++probeSeq.current
    setPhase('probing')
    setErrorText('')
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- baseUrl 变化由探测按钮显式驱动
  }, [probe])

  /** 登录/设密成功：写会话 → 同步连接状态（setConfig 内含凭据重算）→ 回跳 */
  const handleAuthSuccess = (token: string, sessionId: string, expiresAt: string) => {
    useAuthStore.getState().setSession({ token, sessionId, expiresAt })
    useConnectionStore.getState().setConfig({ baseUrl })
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
    }
    if (!password) {
      setErrorText('请输入管理员密码')
      return
    }

    setSubmitting(true)
    setErrorText('')
    try {
      const session =
        phase === 'setup' ? await setupPassword(baseUrl, password) : await login(baseUrl, password)
      handleAuthSuccess(session.token, session.sessionId, session.expiresAt)
    } catch (err) {
      if (err instanceof ApiError) {
        // 40911：探测到未设密后他人抢先设密 → 回登录模式重试
        if (err.code === 40911) {
          setPhase('login')
          setErrorText('管理员密码已被设置，请直接登录')
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
    phase === 'setup' ? '设置管理员密码' : phase === 'login' ? '管理员登录' : '连接面板'

  return (
    <div className="relative flex min-h-svh flex-col items-center justify-center overflow-hidden bg-mcs-bg-canvas px-4 py-10">
      {/* 主题切换（本地偏好，与会话无关；登录态外仍可调） */}
      <button
        type="button"
        onClick={toggleTheme}
        aria-label={theme === 'dark' ? '切换到亮色主题' : '切换到深色主题'}
        className="absolute right-4 top-4 z-10 rounded-mcs-md p-2 text-mcs-text-subtle transition-colors hover:bg-mcs-bg-hover hover:text-mcs-text-default"
      >
        {theme === 'dark' ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}
      </button>

      {/* 装饰性网格纹理（控制台质感；aria 隐藏） */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.35] [background-image:linear-gradient(var(--color-mcs-border-muted)_1px,transparent_1px),linear-gradient(90deg,var(--color-mcs-border-muted)_1px,transparent_1px)] [background-size:32px_32px] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_40%,black_30%,transparent_75%)]"
      />

      {/* 顶部品牌区 */}
      <div className="relative z-10 mb-6 flex items-center gap-3">
        <div className="flex size-11 items-center justify-center rounded-mcs-md border border-mcs-accent-border bg-mcs-accent-bg-subtle shadow-sm">
          <ShieldCheck className="size-6 text-mcs-accent-fg" aria-hidden />
        </div>
        <div>
          <h1 className="text-mcs-lg font-bold tracking-tight text-mcs-text-default">MC Commander</h1>
          <p className="text-mcs-xs text-mcs-text-subtle">Minecraft 服务器管理面板</p>
        </div>
      </div>

      {/* 登录卡片 */}
      <main className="relative z-10 w-full max-w-md rounded-mcs-lg border border-mcs-border-muted bg-mcs-bg-default p-6 shadow-lg shadow-black/5">
        <div className="mb-5">
          <h2 className="text-mcs-md font-semibold text-mcs-text-default">{heading}</h2>
          <p className="mt-1 text-mcs-xs text-mcs-text-subtle">
            {phase === 'setup'
              ? '首次使用：设置管理员密码后即可登录管理面板（8–128 位）'
              : phase === 'login'
                ? '输入管理员密码访问管理面板（会话有效期 7 天，支持滑动续期）'
                : phase === 'probing'
                  ? '正在连接面板服务器…'
                  : '无法连接面板服务器，请检查部署状态'}
          </p>
        </div>

        {/* 探测中骨架 */}
        {phase === 'probing' && (
          <div className="flex flex-col items-center gap-3 py-8" role="status" aria-label="正在探测面板状态">
            <Loader2 className="size-6 animate-spin text-mcs-text-subtle" aria-hidden />
            <div className="w-full space-y-2">
              <div className="h-9 w-full animate-pulse rounded-mcs-sm bg-mcs-bg-muted" />
              <div className="h-9 w-full animate-pulse rounded-mcs-sm bg-mcs-bg-muted" />
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
                  请确认服务端已启动（默认端口 25566），或展开下方「高级」修改面板地址后重试。
                </p>
              </div>
            </div>
            <Button type="button" className="w-full" onClick={() => void probe(baseUrl)}>
              <RefreshCw className="size-4" aria-hidden />
              重新探测
            </Button>
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
                }}
                placeholder={phase === 'setup' ? '设置 8–128 位密码' : '输入密码'}
                autoComplete={phase === 'setup' ? 'new-password' : 'current-password'}
                autoFocus
              />
            </div>
            {phase === 'setup' && (
              <div className="space-y-2">
                <Label htmlFor="confirm-password">确认密码</Label>
                <Input
                  id="confirm-password"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="再次输入密码"
                  autoComplete="new-password"
                  className="h-10 font-mono"
                />
              </div>
            )}
            {phase === 'setup' && (password.length > 0 || confirmPassword.length > 0) && (
              <StrengthBar score={strength.score} label={strength.label} />
            )}

            {errorText && (
              <p
                role="alert"
                className="flex items-start gap-1.5 rounded-mcs-sm border border-mcs-error-border bg-mcs-error-bg-subtle px-2.5 py-2 text-mcs-xs text-mcs-error-fg"
              >
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {errorText}
              </p>
            )}

            <Button type="submit" className="h-10 w-full font-semibold" disabled={submitting}>
              {submitting ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <KeyRound className="size-4" aria-hidden />
              )}
              {phase === 'setup' ? '设置密码并登录' : '登录'}
              {!submitting && <ArrowRight className="size-4" aria-hidden />}
            </Button>
          </form>
        )}

        {/* 高级：自定义面板地址（默认同源；远程面板/CORS 场景使用） */}
        <div className="mt-5 border-t border-mcs-border-muted pt-4">
          <button
            type="button"
            onClick={() => setBaseUrlOpen((v) => !v)}
            aria-expanded={baseUrlOpen}
            className="flex items-center gap-1 text-mcs-2xs font-medium text-mcs-text-subtle transition-colors hover:text-mcs-text-default"
          >
            <span aria-hidden>{baseUrlOpen ? '▾' : '▸'}</span>
            高级：自定义面板地址
          </button>
          {baseUrlOpen && (
            <div className="mt-2.5 space-y-2">
              <Label htmlFor="base-url" className="text-mcs-2xs">
                面板地址（留空 = 当前页面同源）
              </Label>
              <div className="flex gap-2">
                <Input
                  id="base-url"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value.trim())}
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
                  <RefreshCw className="size-3.5" aria-hidden />
                  探测
                </Button>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* 底部辅助链接 */}
      <footer className="relative z-10 mt-6 flex flex-col items-center gap-1.5 text-center">
        <p className="text-mcs-2xs text-mcs-text-subtle">
          使用 API Key 直连（自动化 / 运维场景）？{' '}
          <Link
            to="/onboarding"
            className="font-medium text-mcs-accent-fg underline-offset-2 hover:underline"
          >
            前往连接引导
          </Link>
        </p>
        <p className="text-mcs-2xs text-mcs-text-subtle">
          会话可在「设置 → 账号与安全」中随时下线或踢出其他设备
        </p>
      </footer>
    </div>
  )
}
