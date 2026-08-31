/**
 * AccountPanel —— 设置页「账号与安全」面板（安全主线）
 * - 当前身份卡：会话登录（Bearer）/ API Key 直连 双模式徽章 + 会话到期时间
 * - 修改密码：验旧密改新密；服务端踢其余会话保留当前（响应 kickedSessions）
 * - 活跃会话列表：30s 轮询 + current 标记 + 踢单设备（ConfirmDialog）
 * - 登出：删除当前会话 → 清凭据 → 回登录页
 * API Key 直连用户：会话区块显示引导空态（建议改用会话登录），改密仍可用
 * 设计纪律：实底卡（玻璃禁区）+ --mcs-* 语义 token + shadcn 基座
 */
import { useState } from 'react'
import { useNavigate } from 'react-router'
import {
  Clock,
  Fingerprint,
  KeyRound,
  Loader2,
  LogOut,
  MonitorSmartphone,
  ShieldCheck,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { StatusPill } from '@/components/mcs/status-pill'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'
import { queryKeys } from '@/api/queries'
import { changePassword, fetchSessions, kickSession, logout } from '@/api/auth'
import { ApiError } from '@/api/client'
import { getFriendlyErrorText } from '@/api/errors'
import { useAuthStore } from '@/stores/auth'
import { useConnectionStore } from '@/stores/connection'
import { formatRelativeTime, formatStartTime as formatDateTime } from '@/lib/format'
import {
  assessPasswordStrength,
  STRENGTH_BAR_STYLES,
  STRENGTH_TEXT_STYLES,
} from '@/lib/password-strength'

/** 简易 UA 描述（浏览器名 + 移动端标记；服务端存原文，展示层简化） */
function describeUserAgent(ua: string | null): string {
  if (!ua) return '未知设备'
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Safari\//.test(ua)
          ? 'Safari'
          : '未知浏览器'
  const mobile = /Mobile|Android|iPhone/.test(ua) ? '（移动端）' : ''
  return `${browser}${mobile}`
}

/** 通用区块卡片（面板内三段复用） */
function SectionCard({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: typeof ShieldCheck
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <section className="rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-default p-5">
      <div className="mb-4 flex items-start gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-mcs-sm bg-mcs-accent-bg-subtle">
          <Icon className="size-4 text-mcs-accent-fg" aria-hidden />
        </div>
        <div>
          <h3 className="text-mcs-sm font-semibold text-mcs-text-default">{title}</h3>
          <p className="mt-0.5 text-mcs-2xs text-mcs-text-subtle">{description}</p>
        </div>
      </div>
      {children}
    </section>
  )
}

export function AccountPanel() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const session = useAuthStore((s) => s.session)
  const apiKey = useConnectionStore((s) => s.apiKey)
  const baseUrl = useConnectionStore((s) => s.baseUrl)
  const authed = Boolean(session?.token || apiKey)

  // ── 活跃会话（30s 轮询；API Key 直连时空态引导） ──
  const sessionsQuery = useQuery({
    queryKey: queryKeys.authSessions(),
    queryFn: () => fetchSessions({ baseUrl, apiKey }),
    enabled: authed,
    refetchInterval: 30_000,
  })

  // ── 修改密码表单 ──
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [changing, setChanging] = useState(false)
  const [changeError, setChangeError] = useState('')
  const strength = assessPasswordStrength(newPassword)

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    if (changing) return
    if (!currentPassword) {
      setChangeError('请输入当前密码（未设密时留空）')
      return
    }
    if (strength.score === 0) {
      setChangeError('新密码至少需要 8 位')
      return
    }
    if (newPassword !== confirmPassword) {
      setChangeError('两次输入的新密码不一致')
      return
    }
    setChanging(true)
    setChangeError('')
    try {
      const res = await changePassword({ baseUrl, apiKey }, currentPassword, newPassword)
      toast.success(`密码已更新${res.kickedSessions > 0 ? `，已下线其他 ${res.kickedSessions} 个会话` : ''}`)
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } catch (err) {
      setChangeError(getFriendlyErrorText(err))
    } finally {
      setChanging(false)
    }
  }

  // ── 踢单设备 ──
  const [kickTarget, setKickTarget] = useState<string | null>(null)
  const [kicking, setKicking] = useState(false)

  const handleKick = async () => {
    if (kickTarget == null) return
    setKicking(true)
    try {
      await kickSession({ baseUrl, apiKey }, kickTarget)
      toast.success('会话已下线')
      void queryClient.invalidateQueries({ queryKey: queryKeys.authSessions() })
    } catch (err) {
      // 踢自己：服务端删除后当前令牌失效 → 本地同步登出
      if (err instanceof ApiError && err.code === 40103) {
        handleLogoutLocal('当前会话已被下线')
      } else {
        toast.error(`操作失败：${getFriendlyErrorText(err)}`)
      }
    } finally {
      setKicking(false)
      setKickTarget(null)
    }
  }

  // ── 登出 ──
  const [logoutOpen, setLogoutOpen] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)

  const handleLogoutLocal = (message: string) => {
    useAuthStore.getState().clearSession()
    useConnectionStore.getState().refreshStatus()
    toast.info(message)
    navigate('/login', { replace: true })
  }

  const handleLogout = async () => {
    setLoggingOut(true)
    try {
      if (session?.token) {
        await logout({ baseUrl, apiKey })
      }
      handleLogoutLocal('已退出登录')
    } catch {
      // 服务端登出失败不阻塞本地登出（令牌已不可用）
      handleLogoutLocal('已退出登录')
    } finally {
      setLoggingOut(false)
      setLogoutOpen(false)
    }
  }

  const sessions = sessionsQuery.data?.sessions ?? []

  return (
    <div className="space-y-4">
      {/* ── 当前身份 ── */}
      <SectionCard
        icon={Fingerprint}
        title="当前身份"
        description="浏览器访问面板所使用的认证通道与凭据状态"
      >
        <div className="flex flex-wrap items-center gap-2.5">
          {session?.token ? (
            <StatusPill tone="success" className="gap-1">
              <ShieldCheck className="size-3" aria-hidden />
              管理员会话
            </StatusPill>
          ) : (
            <StatusPill variant="outline" tone="warning" className="gap-1">
              <KeyRound className="size-3" aria-hidden />
              API Key 直连
            </StatusPill>
          )}
          {session?.expiresAt && (
            <span className="inline-flex items-center gap-1 text-mcs-2xs text-mcs-text-subtle">
              <Clock className="size-3" aria-hidden />
              会话到期：{formatDateTime(session.expiresAt)}（活动自动续期）
            </span>
          )}
        </div>
        {!session?.token && (
          <p className="mt-3 flex items-start gap-1.5 rounded-mcs-sm border border-mcs-warning-border bg-mcs-warning-bg-subtle px-2.5 py-2 text-mcs-2xs text-mcs-warning-fg">
            <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
            当前使用明文 API Key 直连。建议退出后使用管理员密码登录（令牌仅存服务端摘要，传输/存储更安全）。
          </p>
        )}
      </SectionCard>

      {/* ── 修改密码 ── */}
      <SectionCard
        icon={KeyRound}
        title="修改管理员密码"
        description="修改成功后其他设备的会话将全部下线（当前浏览器保持登录）"
      >
        <form onSubmit={handleChangePassword} className="grid gap-4 sm:grid-cols-3" noValidate>
          <div className="space-y-2">
            <Label htmlFor="current-password" className="text-mcs-xs">
              当前密码
            </Label>
            <Input
              id="current-password"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
              className="h-9 font-mono"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-password" className="text-mcs-xs">
              新密码（8–128 位）
            </Label>
            <Input
              id="new-password"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              className="h-9 font-mono"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm-new-password" className="text-mcs-xs">
              确认新密码
            </Label>
            <Input
              id="confirm-new-password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
              className="h-9 font-mono"
            />
          </div>

          {newPassword.length > 0 && (
            <div className="sm:col-span-3">
              <div className="flex gap-1" aria-hidden>
                {[0, 1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className={`h-1 flex-1 rounded-full transition-colors duration-mcs-base ${
                      i < strength.score ? STRENGTH_BAR_STYLES[strength.score] : 'bg-mcs-border-muted'
                    }`}
                  />
                ))}
              </div>
              <p className={`mt-1 text-mcs-2xs font-medium ${STRENGTH_TEXT_STYLES[strength.score]}`}>
                新密码强度：{strength.label}
                {strength.score > 0 && strength.score < 3 && '（建议混合大小写字母、数字与符号）'}
              </p>
            </div>
          )}

          {changeError && (
            <p
              role="alert"
              className="sm:col-span-3 rounded-mcs-sm border border-mcs-error-border bg-mcs-error-bg-subtle px-2.5 py-2 text-mcs-xs text-mcs-error-fg"
            >
              {changeError}
            </p>
          )}

          <div className="sm:col-span-3">
            <Button type="submit" size="sm" disabled={changing || !authed}>
              {changing && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
              更新密码
            </Button>
          </div>
        </form>
      </SectionCard>

      {/* ── 活跃会话 ── */}
      <SectionCard
        icon={MonitorSmartphone}
        title="活跃会话"
        description="所有已登录设备；发现异常登录可立即下线（最长 7 天未活动自动过期）"
      >
        {sessionsQuery.isLoading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-mcs-xs text-mcs-text-subtle" role="status">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            正在加载会话列表…
          </div>
        ) : sessions.length === 0 ? (
          <div className="rounded-mcs-md border border-dashed border-mcs-border-muted py-8 text-center">
            <MonitorSmartphone className="mx-auto size-8 text-mcs-text-subtle/60" aria-hidden />
            <p className="mt-2 text-mcs-xs text-mcs-text-muted">
              {session?.token ? '暂无活跃会话' : '当前为 API Key 直连，暂无浏览器会话'}
            </p>
            {!session?.token && (
              <p className="mt-1 text-mcs-2xs text-mcs-text-subtle">
                退出登录后通过密码登录，即可在此管理设备会话
              </p>
            )}
          </div>
        ) : (
          <div className="max-h-96 overflow-y-auto rounded-mcs-md border border-mcs-border-muted">
            <Table>
              <TableHeader>
                <TableRow className="bg-mcs-bg-muted/60">
                  <TableHead className="text-mcs-2xs">设备</TableHead>
                  <TableHead className="text-mcs-2xs">IP 地址</TableHead>
                  <TableHead className="text-mcs-2xs">最后活跃</TableHead>
                  <TableHead className="text-mcs-2xs">到期时间</TableHead>
                  <TableHead className="w-10 text-right text-mcs-2xs">
                    <span className="sr-only">操作</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="py-2.5">
                      <div className="flex items-center gap-2">
                        <span className="text-mcs-xs font-medium text-mcs-text-default">
                          {describeUserAgent(s.userAgent)}
                        </span>
                        {s.current && (
                          <StatusPill variant="outline" tone="accent" className="text-mcs-2xs">
                            本机
                          </StatusPill>
                        )}
                      </div>
                      <p className="mt-0.5 max-w-52 truncate text-mcs-2xs text-mcs-text-subtle" title={s.userAgent ?? undefined}>
                        登录于 {formatDateTime(s.createdAt)}
                      </p>
                    </TableCell>
                    <TableCell className="py-2.5 font-mono text-mcs-xs text-mcs-text-muted">
                      {s.ip ?? '—'}
                    </TableCell>
                    <TableCell className="py-2.5 text-mcs-xs text-mcs-text-muted">
                      {formatRelativeTime(s.lastSeenAt)}
                    </TableCell>
                    <TableCell className="py-2.5 text-mcs-xs text-mcs-text-muted">
                      {formatDateTime(s.expiresAt)}
                    </TableCell>
                    <TableCell className="py-2.5 text-right">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`下线会话（${describeUserAgent(s.userAgent)}）`}
                        onClick={() => setKickTarget(String(s.id))}
                        className="text-mcs-text-subtle hover:text-mcs-error-fg"
                      >
                        <Trash2 className="size-3.5" aria-hidden />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      {/* ── 登出 ── */}
      <SectionCard
        icon={LogOut}
        title="退出登录"
        description="删除当前浏览器会话；API Key 直连不受影响"
      >
        <Button
          type="button"
          variant="destructive"
          size="sm"
          onClick={() => setLogoutOpen(true)}
          disabled={!session?.token}
          title={session?.token ? undefined : 'API Key 直连无会话可登出'}
        >
          <LogOut className="size-3.5" aria-hidden />
          退出登录
        </Button>
      </SectionCard>

      {/* 踢单设备确认 */}
      <ConfirmDialog
        open={kickTarget != null}
        onOpenChange={(open) => {
          if (!open) setKickTarget(null)
        }}
        title="下线该会话？"
        description={
          kickTarget != null && sessions.find((s) => String(s.id) === kickTarget)?.current
            ? '这是当前浏览器的会话，下线后需要重新登录。'
            : '该设备将被强制登出，需重新输入密码才能访问面板。'
        }
        confirmText="下线"
        danger
        loading={kicking}
        onConfirm={() => void handleKick()}
      />

      {/* 登出确认 */}
      <ConfirmDialog
        open={logoutOpen}
        onOpenChange={setLogoutOpen}
        title="退出登录？"
        description="当前浏览器会话将被删除，下次访问需重新输入管理员密码。"
        confirmText="退出登录"
        danger
        loading={loggingOut}
        onConfirm={() => void handleLogout()}
      />
    </div>
  )
}
