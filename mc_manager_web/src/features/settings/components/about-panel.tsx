/**
 * AboutPanel —— 设置页「关于」面板（静态）
 * - 应用名 + 副标题 + 版本徽章（mono）
 * - 开源卡片（success 色调三元组 token）
 * - 相关链接卡片：三行外链 <a target="_blank" rel="noreferrer">
 * - 版权行（居中 subtle）
 * 设计纪律：实底卡（玻璃禁区）+ --mcs-* 语义 token + shadcn 基座
 */
import { ChevronRight, Code, Heart, Link as LinkIcon, MessageSquareWarning, Tag } from 'lucide-react'
import type { AboutPanelProps } from './contracts'

/** 开源仓库主页（GitHub 主仓；Releases/Issues 由子路径拼接，国内镜像见 README） */
const REPO_URL = 'https://github.com/wyyfzb/mc-commander'

/** 三行外链：标题/副标题/地址 + 图标（图标底色走语义 token） */
const LINKS = [
  {
    title: '⭐ GitHub 仓库',
    subtitle: '查看源代码并参与贡献',
    href: REPO_URL,
    icon: Code,
    iconClass: 'bg-mcs-bg-emphasis',
  },
  {
    title: '🚀 项目 Releases',
    subtitle: '查看版本发布与更新日志',
    href: `${REPO_URL}/releases`,
    icon: Tag,
    iconClass: 'bg-mcs-info-bg-subtle',
  },
  {
    title: '🐛 问题反馈',
    subtitle: '报告 Bug 或建议新功能',
    href: `${REPO_URL}/issues`,
    icon: MessageSquareWarning,
    iconClass: 'bg-mcs-warning-bg-subtle',
  },
] as const

export function AboutPanel(_props: AboutPanelProps) {
  return (
    <div className="flex flex-col gap-3">
      {/* ── 应用信息：应用名 + 副标题 + 版本徽章 ── */}
      <section className="flex flex-col items-center gap-1.5 rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-muted px-4 py-6">
        <h3 className="text-mcs-xl font-bold text-mcs-text-default tracking-tight">MC Commander</h3>
        <p className="text-mcs-sm text-mcs-text-muted">自托管 Minecraft 服务器管理客户端</p>
        <span className="mt-1 inline-flex h-5 items-center rounded-mcs-xl border border-mcs-accent-border bg-mcs-accent-bg-subtle px-2 font-mono text-mcs-xs font-semibold text-mcs-accent-fg">
          v{__APP_VERSION__}
        </span>
      </section>

      {/* ── 开源卡片（success 色调三元组 token）── */}
      <section className="flex items-center gap-3 rounded-mcs-md border border-mcs-success-border bg-mcs-success-bg-subtle px-4 py-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-mcs-sm bg-mcs-success-bg-subtle">
          <Heart className="size-4 text-mcs-success-fg" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-mcs-sm font-semibold text-mcs-text-default">开源项目</div>
          <div className="text-mcs-xs text-mcs-text-muted">基于 AGPL-3.0 协议开源</div>
        </div>
      </section>

      {/* ── 相关链接卡片 ── */}
      <section className="rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-muted">
        <header className="flex items-center gap-3 border-b border-mcs-border-subtle px-4 py-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-mcs-sm bg-mcs-accent-bg-subtle">
            <LinkIcon className="size-4 text-mcs-accent" aria-hidden />
          </span>
          <h3 className="text-mcs-md font-semibold">相关链接</h3>
        </header>
        <div className="flex flex-col gap-1.5 p-3">
          {LINKS.map(({ title, subtitle, href, icon: Icon, iconClass }) => (
            <a
              key={href}
              href={href}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-3 rounded-mcs-sm border border-mcs-border-subtle bg-mcs-bg-subtle px-3 py-2.5 transition-colors hover:bg-mcs-bg-hover"
            >
              <span
                className={`flex size-9 shrink-0 items-center justify-center rounded-mcs-sm ${iconClass}`}
              >
                <Icon className="size-4 text-mcs-text-muted" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-mcs-sm font-semibold text-mcs-text-default">{title}</span>
                <span className="block text-mcs-xs text-mcs-text-subtle">{subtitle}</span>
              </span>
              <ChevronRight className="size-4 shrink-0 text-mcs-text-subtle" aria-hidden />
            </a>
          ))}
        </div>
      </section>

      {/* ── 版权（居中 subtle）── */}
      <p className="py-2 text-center text-mcs-xs text-mcs-text-subtle">
        © 2026 MC_Commander · 社区开源项目
      </p>
    </div>
  )
}
