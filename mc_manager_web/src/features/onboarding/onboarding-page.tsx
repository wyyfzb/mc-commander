/**
 * OnboardingPage —— 首次使用引导页
 * - 部署方式按**发布物实际提供的能力**陈列三选一：已有服务端 / Linux 一键部署 / Windows 手动部署；
 *   Docker 官方不提供镜像，压成卡片区下方一行说明（不占卡片位、不泄漏内部术语）
 * - 连接表单复用 ConnectionForm variant onboarding；保存成功（setConfig → status ready）→ 跳转 /dashboard
 * - 路由保护：AppShell loader 在 status=unconfigured 时 redirect /onboarding
 */
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { AlertTriangle, Check, Copy, Lightbulb, Package, Server, Terminal } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { useRadioGroup, type RadioGroupItemProps } from '@/hooks/use-radio-group'
import { TONE_SELECTED_SURFACE_CLASSES } from '@/components/mcs/tone'
import { copyText } from '@/lib/clipboard'
import { BrandLogo } from '@/components/mcs/brand-logo'
import { NoticeBanner } from '@/components/mcs/notice-banner'
import { ConnectionForm } from '@/features/settings/components/connection-form'

type DeployMode = 'already' | 'linux' | 'windows'

/** 单选组内顺序（方向键按此循环；必须与卡片渲染顺序一致） */
const MODE_ORDER: DeployMode[] = ['already', 'linux', 'windows']

/** Linux 一键部署命令（项目公开仓库脚本地址；gitee 镜像同路径，README 与设置页一致用 main 分支） */
const DEPLOY_COMMAND =
  'sudo su -c "curl -fsSL https://gitee.com/wyyfzb/mc-commander/raw/main/mc_commander_server/scripts/deploy-mc-commander.sh | bash"'

/**
 * Windows 手动部署步骤（发布物只有 Linux 脚本与包，Windows 只能手跑）
 * 第 3-4 步不可省：`public/index.html` 不存在时服务端不挂载静态层（middleware/static_serve.js），
 * 只跑后端的话 :25566 返回 404 JSON，看不到面板界面
 */
const WINDOWS_STEPS = [
  '安装 Node.js 22+（nodejs.org 下载 LTS 安装包）',
  '克隆仓库并进入前端目录：git clone https://github.com/wyyfzb/mc-commander.git，cd mc-commander/mc_manager_web（未安装 git 时可从仓库主页下载 ZIP 解压）',
  '构建前端产物：npm install，npm run build',
  '把产物放进服务端目录：cd ../mc_commander_server，mkdir public -Force，Copy-Item ../mc_manager_web/dist/* public/ -Recurse -Force',
  '配置密钥：Copy-Item .env.example .env，编辑 .env 填入 API_KEY',
  '启动面板：npm install，npm start，浏览器打开 http://localhost:25566',
]

const LINUX_POINTS = [
  '脚本会自动安装 Java 17/21/25 和 Node.js 22+，无需手动准备环境',
  '脚本结束时打印服务器地址、端口与「API Key」，请妥善保存',
  '服务端默认运行在 25566 端口，安装目录为 /opt/mc-commander',
]

/** 部署方式卡片（已有服务端 / Linux 一键 / Windows 手动）——三选一的单选组，非独立开关 */
function ModeCard({
  mode,
  active,
  title,
  description,
  icon: Icon,
  onSelect,
  radioProps,
}: {
  mode: DeployMode
  active: boolean
  title: string
  description: string
  icon: typeof Server
  onSelect: (mode: DeployMode) => void
  /** radio 语义（role/aria-checked/roving tabindex/ref）由 useRadioGroup 统一管理 */
  radioProps: RadioGroupItemProps
}) {
  return (
    <button
      {...radioProps}
      type="button"
      onClick={() => onSelect(mode)}
      className={cn(
        'flex flex-1 flex-col items-start gap-2 rounded-mcs-md border p-4 text-left transition-colors',
        active
          ? `${TONE_SELECTED_SURFACE_CLASSES} shadow-mcs-card`
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

  // 单选组接线（roving tabindex + 方向键移动即选中、焦点跟随）统一走 useRadioGroup，
  // 与 webhook 渠道预设、J55 批次各组共用同一键盘模型
  const { groupProps, itemProps } = useRadioGroup<DeployMode>({
    label: '部署方式',
    value: mode,
    values: MODE_ORDER,
    onChange: setMode,
  })

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

        {/* ── 部署方式选择（三选一单选组）+ Docker 边界说明 ── */}
        <div {...groupProps} className="mb-2 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <ModeCard
            mode="already"
            active={itemProps(0)['aria-checked']}
            title="已有服务端"
            description="我已部署，直接连接"
            icon={Server}
            onSelect={setMode}
            radioProps={itemProps(0)}
          />
          <ModeCard
            mode="linux"
            active={itemProps(1)['aria-checked']}
            title="Linux 一键部署"
            description="一条命令装好运行环境"
            icon={Terminal}
            onSelect={setMode}
            radioProps={itemProps(1)}
          />
          <ModeCard
            mode="windows"
            active={itemProps(2)['aria-checked']}
            title="Windows 手动部署"
            description="自备 Node 22+ · 分步指引"
            icon={Package}
            onSelect={setMode}
            radioProps={itemProps(2)}
          />
        </div>
        <p className="mb-4 text-mcs-xs text-mcs-text-muted">
          Docker 不在支持范围内：官方不提供镜像，请用上方任一方式部署。
        </p>

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
                <ol className="flex list-decimal flex-col gap-1.5 pl-4 text-mcs-xs text-mcs-text-muted">
                  {WINDOWS_STEPS.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
                <NoticeBanner variant="warning" icon={AlertTriangle}>
                  未提供 Windows 安装包：官方部署脚本面向 Linux，Windows 请按上述步骤手动部署（第 3-4
                  步构建前端产物不可省，否则 :25566 只有接口没有界面）；遇到环境问题建议改用 WSL2
                  走 Linux 一键脚本。
                </NoticeBanner>
              </>
            )}
            {mode === 'linux' && (
              <>
                <div className="flex items-center gap-2">
                  <Terminal className="size-3.5 text-mcs-text-muted" aria-hidden />
                  <span className="text-mcs-xs font-medium text-mcs-text-muted">
                    Linux 一键部署命令
                  </span>
                </div>
                <CommandBlock command={DEPLOY_COMMAND} ariaLabel="复制部署命令" />
                <ul className="flex flex-col gap-1.5">
                  {LINUX_POINTS.map((point) => (
                    <li key={point} className="flex items-start gap-2 text-mcs-xs text-mcs-text-muted">
                      <Check className="mt-0.5 size-3 shrink-0 text-mcs-success-fg" aria-hidden />
                      {point}
                    </li>
                  ))}
                </ul>
                <NoticeBanner variant="success" icon={Lightbulb}>
                  部署完成后，记下终端输出的「API Key」，下一步连接时需要填写。
                </NoticeBanner>
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
          <p className="text-mcs-xs text-mcs-text-muted">
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
