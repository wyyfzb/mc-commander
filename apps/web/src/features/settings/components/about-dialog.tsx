/**
 * AboutDialog —— 「关于」弹窗：应用信息 + 开源声明 + 相关链接 + 版权。
 *
 * 从子页改成弹窗：这一页没有可操作的东西（纯静态信息），占掉一个子导航位会让
 * 真正要操作的设置项被挤到后面；它也从不需要长时间停留。
 *
 * 更新检查与运行环境**不在这里**：那是「要不要更新」与「运行环境健不健康」，
 * 属于运维判断，与「关于」的静态介绍不是一回事。它们在「数据与卸载」页底部。
 */
import {
  ChevronRight,
  Code,
  GitBranch,
  Heart,
  Link as LinkIcon,
  MessageSquareWarning,
  Tag,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Card, CardBody, CardHeader } from '@/components/mcs/card'
import { NoticeBanner } from '@/components/mcs/notice-banner'
import { toneClasses } from '@/components/mcs/tone'

/** 开源仓库主页（GitHub 主仓；Releases/Issues 由子路径拼接） */
const REPO_URL = 'https://github.com/wyyfzb/mc-commander'
/** Gitee 国内镜像仓库主页 */
const GITEE_REPO_URL = 'https://gitee.com/wyyfzb/mc-commander'

/** 外链行：标题/副标题/地址 + 图标（图标底色走语义 token） */
const LINKS = [
  {
    title: 'GitHub 仓库',
    subtitle: '查看源代码并参与贡献',
    href: REPO_URL,
    icon: Code,
    iconClass: 'bg-mcs-bg-emphasis',
  },
  {
    title: 'Gitee 镜像仓库',
    subtitle: '国内访问 · 自动同步',
    href: GITEE_REPO_URL,
    icon: GitBranch,
    iconClass: 'bg-mcs-accent-bg-subtle',
  },
  {
    title: '项目 Releases',
    subtitle: '查看版本发布与更新日志',
    href: `${REPO_URL}/releases`,
    icon: Tag,
    iconClass: 'bg-mcs-info-bg-subtle',
  },
  {
    title: '问题反馈',
    subtitle: '报告 Bug 或建议新功能',
    href: `${REPO_URL}/issues`,
    icon: MessageSquareWarning,
    iconClass: 'bg-mcs-warning-bg-subtle',
  },
] as const

interface AboutDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function AboutDialog({ open, onOpenChange }: AboutDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-mcs-xl font-semibold text-mcs-text-default">
            MC Commander
          </DialogTitle>
          <DialogDescription className="text-mcs-sm text-mcs-text-muted">
            自托管 Minecraft 服务器管理客户端
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div>
            <span
              className={`inline-flex h-5 items-center rounded-full border px-2 font-mono text-mcs-xs font-semibold ${toneClasses('accent')}`}
            >
              v{__APP_VERSION__}
            </span>
          </div>

          <NoticeBanner variant="success" form="card" icon={Heart}>
            <div className="font-semibold text-mcs-text-default">开源项目</div>
            <div className="text-mcs-xs text-mcs-text-muted">基于 AGPL-3.0 协议开源</div>
          </NoticeBanner>

          <Card size="flush">
            <CardHeader className="gap-3 border-b border-mcs-border-subtle px-4 py-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-mcs-sm bg-mcs-accent-bg-subtle">
                <LinkIcon className="size-4 text-mcs-accent-fg" aria-hidden />
              </span>
              <h3 className="text-mcs-lg font-semibold">相关链接</h3>
            </CardHeader>
            <CardBody className="flex flex-col gap-1.5 p-3">
              {LINKS.map(({ title, subtitle, href, icon: Icon, iconClass }) => (
                <a
                  key={href}
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-3 rounded-mcs-sm border border-mcs-border-subtle bg-mcs-bg-subtle px-3 py-2.5 transition-colors hover:bg-mcs-state-hover"
                >
                  <span
                    className={`flex size-9 shrink-0 items-center justify-center rounded-mcs-sm ${iconClass}`}
                  >
                    <Icon className="size-4 text-mcs-text-muted" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-mcs-sm font-semibold text-mcs-text-default">
                      {title}
                    </span>
                    <span className="block text-mcs-xs text-mcs-text-muted">{subtitle}</span>
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-mcs-text-muted" aria-hidden />
                </a>
              ))}
            </CardBody>
          </Card>

          <p className="text-center text-mcs-xs text-mcs-text-muted">
            © 2026 MC_Commander · 社区开源项目
          </p>
          <p className="text-center text-mcs-xs text-mcs-text-muted">
            作者{' '}
            <a
              href="https://github.com/wyyfzb"
              target="_blank"
              rel="noreferrer"
              className="font-medium text-mcs-accent-fg underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-mcs-focus-ring focus-visible:outline-offset-2"
            >
              @wyyfzb
            </a>
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
