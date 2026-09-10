/**
 * OnboardingPage —— 首次使用引导页
 * - SSH 自动部署不在 Web 端提供；部署方式按**发布物实际提供的能力**陈列：
 *   已有服务端 / Windows 手动部署（Node 22+）/ Linux 一键脚本 / Docker（明确不提供，说明边界）
 * - 连接表单复用 ConnectionForm variant onboarding；保存成功（setConfig → status ready）→ 跳转 /dashboard
 * - 路由保护：AppShell loader 在 status=unconfigured 时 redirect /onboarding
 */
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { Check, Container, Copy, Lightbulb, Package, Server, Terminal } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { copyText } from '@/lib/clipboard'
import { BrandLogo } from '@/components/mcs/brand-logo'
import { ConnectionForm } from '@/features/settings/components/connection-form'

type DeployMode = 'already' | 'windows' | 'docker' | 'manual'

/** 手动部署一键命令（项目公开仓库脚本地址；gitee 镜像同路径，README 与设置页一致用 main 分支） */
const DEPLOY_COMMAND =
  'sudo su -c "curl -fsSL https://gitee.com/wyyfzb/mc-commander/raw/main/mc_commander_server/scripts/deploy-mc-commander.sh | bash"'

/** Windows 手动部署步骤（发布物不含 Windows 包，只能手跑；面板本身跨平台可用） */
const WINDOWS_STEPS = [
  '安装 Node.js 22+（nodejs.org 下载 LTS 安装包）',
  '克隆仓库并进入服务端目录：git clone https://github.com/wyyfzb/mc-commander.git',
  '复制 .env.example 为 .env 并填入 API_KEY（PowerShell：Copy-Item .env.example .env）',
  '执行 npm install 与 npm start，浏览器打开 http://localhost:25566',
]

const MANUAL_POINTS = [
  '脚本会自动安装 Java 17/21/25 和 Node.js 22+，无需手动准备环境',
  '部署完成后会输出「面板地址」和「API Key」，请妥善保存',
  '服务端默认运行在 25566 端口，安装目录为 /opt/mc-commander',
]

/** 部署方式卡片（Windows 一键包推荐 / Docker / 手动 Node 22+） */
function ModeCard({
  mode,
  active,
  title,
  description,
  icon: Icon,
  onSelect,
}: {
  mode: DeployMode
  active: boolean
  title: string
  description: string
  icon: typeof Server
  onSelect: (mode: DeployMode) => void
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={() => onSelect(mode)}
      className={cn(
        'flex flex-1 flex-col items-start gap-2 rounded-mcs-md border p-4 text-left transition-colors',
        active
          ? 'border-mcs-accent-border-strong bg-mcs-accent-bg-subtle shadow-mcs-card'
          : 'border-mcs-border-muted bg-mcs-bg-muted shadow-mcs-card hover:bg-mcs-state-hover',
      )}
    >
      <Icon
        className={cn('size-5', active ? 'text-mcs-accent-fg' : 'text-mcs-text-muted')}
        aria-hidden
      />
      <span className="text-mcs-sm font-semibold text-mcs-text-default">{title}</span>
      <span className="text-mcs-xs text-mcs-text-muted">{description}</span>
    </button>
  )
}

/** 命令展示块（mono 可复制） */
function CommandBlock({ command, ariaLabel }: { command: string; ariaLabel: string }) {
  const copy = async () => {
    // copyText 内部降级 execCommand（HTTP 非安全上下文可用）且绝不抛异常
    const ok = await copyText(command)
    if (ok) toast.success('命令已复制', { duration: 1500 })
    else toast.error('复制失败，请手动复制')
  }
  return (
    <div className="flex items-start gap-2">
      <code className="min-w-0 flex-1 break-all rounded-mcs-sm border border-mcs-border-muted bg-mcs-bg-subtle px-2.5 py-2 font-mono text-mcs-xs text-mcs-text-default">
        {command}
      </code>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={ariaLabel}
        className="shrink-0 rounded-mcs-sm border border-mcs-border-muted bg-mcs-bg-subtle p-2 text-mcs-text-muted hover:bg-mcs-state-hover hover:text-mcs-text-default"
      >
        <Copy className="size-3.5" aria-hidden />
      </button>
    </div>
  )
}

export function OnboardingPage() {
  const navigate = useNavigate()
  const [mode, setMode] = useState<DeployMode>('already')

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-mcs-bg-default p-6">
      <div className="w-full max-w-xl">
        {/* ── 欢迎区（品牌 Logo + 标题） ── */}
        <div className="mb-6 text-center">
          <BrandLogo className="mx-auto mb-3 size-12 text-mcs-text-default" label="MC Commander Logo" />
          <h1 className="text-mcs-2xl font-semibold text-mcs-text-default">欢迎使用 MC Commander</h1>
          <p className="mt-2 text-mcs-sm text-mcs-text-muted">
            自托管 Minecraft 服务器管理面板。首次使用前，请先确认服务端部署状态。
          </p>
        </div>

        {/* ── 部署方式选择（三选一） ── */}
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <ModeCard
            mode="already"
            active={mode === 'already'}
            title="已有服务端"
            description="我已部署，直接连接"
            icon={Server}
            onSelect={setMode}
          />
          <ModeCard
            mode="windows"
            active={mode === 'windows'}
            title="Windows 部署"
            description="手动步骤 · 自备 Node 22+"
            icon={Package}
            onSelect={setMode}
          />
          <ModeCard
            mode="docker"
            active={mode === 'docker'}
            title="Docker"
            description="暂不提供 · 见不做清单"
            icon={Container}
            onSelect={setMode}
          />
          <ModeCard
            mode="manual"
            active={mode === 'manual'}
            title="手动（Node 22+）"
            description="Linux 一键部署脚本"
            icon={Terminal}
            onSelect={setMode}
          />
        </div>

        {/* ── 部署指南（随选择切换） ── */}
        {mode !== 'already' && (
          <div className="mb-4 flex flex-col gap-3 rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-muted p-4 shadow-mcs-card">
            {mode === 'windows' && (
              <>
                <div className="flex items-center gap-2">
                  <Package className="size-3.5 text-mcs-text-muted" aria-hidden />
                  <span className="text-mcs-xs font-medium text-mcs-text-muted">
                    Windows 手动部署（Node 22+）
                  </span>
                </div>
                <ol className="flex list-inside list-decimal flex-col gap-1.5 text-mcs-xs text-mcs-text-muted">
                  {WINDOWS_STEPS.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
                <div
                  role="note"
                  className="flex items-start gap-2 rounded-mcs-sm border border-mcs-warning-border bg-mcs-warning-bg-subtle px-2.5 py-2"
                >
                  <Lightbulb className="mt-0.5 size-4 shrink-0 text-mcs-warning-fg" aria-hidden />
                  <p className="text-mcs-xs text-mcs-text-muted">
                    未提供 Windows 一键包：当前发布物只有 Linux tarball，Windows 请按上述步骤手动部署。
                  </p>
                </div>
              </>
            )}
            {mode === 'docker' && (
              <>
                <div className="flex items-center gap-2">
                  <Container className="size-3.5 text-mcs-text-muted" aria-hidden />
                  <span className="text-mcs-xs font-medium text-mcs-text-muted">
                    Docker：暂不提供
                  </span>
                </div>
                <p className="text-mcs-xs text-mcs-text-muted">
                  路线图的「不做清单」明确不做容器化（与轻量自托管定位冲突），故这里不给出
                  <code className="font-mono text-mcs-text-default">docker run</code> 命令。
                </p>
                <div
                  role="note"
                  className="flex items-start gap-2 rounded-mcs-sm border border-mcs-warning-border bg-mcs-warning-bg-subtle px-2.5 py-2"
                >
                  <Lightbulb className="mt-0.5 size-4 shrink-0 text-mcs-warning-fg" aria-hidden />
                  <p className="text-mcs-xs text-mcs-text-muted">
                    替代路径：用 Linux 一键脚本或 Windows 手动部署；如需自行容器化，可基于 Node 22
                    官方镜像构建（服务端 + public/ 前端产物）。
                  </p>
                </div>
              </>
            )}
            {mode === 'manual' && (
              <>
                <div className="flex items-center gap-2">
                  <Terminal className="size-3.5 text-mcs-text-muted" aria-hidden />
                  <span className="text-mcs-xs font-medium text-mcs-text-muted">
                    Linux 一键部署命令
                  </span>
                </div>
                <CommandBlock command={DEPLOY_COMMAND} ariaLabel="复制部署命令" />
                <ul className="flex flex-col gap-1.5">
                  {MANUAL_POINTS.map((point) => (
                    <li key={point} className="flex items-start gap-2 text-mcs-xs text-mcs-text-muted">
                      <Check className="mt-0.5 size-3 shrink-0 text-mcs-success-fg" aria-hidden />
                      {point}
                    </li>
                  ))}
                </ul>
                <div
                  role="note"
                  className="flex items-start gap-2 rounded-mcs-sm border border-mcs-success-border bg-mcs-success-bg-subtle px-2.5 py-2"
                >
                  <Lightbulb className="mt-0.5 size-4 shrink-0 text-mcs-success-fg" aria-hidden />
                  <p className="text-mcs-xs text-mcs-text-muted">
                    部署完成后，记下终端输出的「API Key」，下一步连接时需要填写。
                  </p>
                </div>
              </>
            )}
          </div>
        )}

        {/* ── 连接表单（复用；保存成功 → 跳转仪表盘） ── */}
        <ConnectionForm
          variant="onboarding"
          onSaved={() => {
            toast.success('欢迎使用，已进入管理面板')
            navigate('/dashboard')
          }}
        />

        {/* 底部：登录页经「前往连接引导」单向跳入此处，需提供返回入口 */}
        <div className="mt-6 flex flex-col items-center gap-1.5 border-t border-mcs-border-muted pt-4">
          <Link
            to="/login"
            className="text-mcs-xs font-semibold text-mcs-accent-fg transition-colors hover:underline"
          >
            ← 返回登录页
          </Link>
          <p className="text-mcs-2xs text-mcs-text-muted">
            遇到问题？{' '}
            <a
              href="https://gitee.com/wyyfzb/mc-commander"
              target="_blank"
              rel="noreferrer"
              className="font-semibold text-mcs-accent-fg transition-colors hover:underline"
            >
              查看部署文档 →
            </a>
          </p>
        </div>
      </div>
    </div>
  )
}
