/**
 * AboutDialog 测试（静态内容，无网络依赖）：
 * - 弹窗可访问名来自 DialogTitle（h2「MC Commander」），不是内嵌卡片里的 h3
 * - 版本徽章随 package.json（vite define 注入）
 * - 开源声明 + 四行外链 href/target/rel + 标题副标题
 * - 版权与作者署名
 * - 边界：更新检查与运行环境**不**在关于弹窗里（它们住「数据与卸载」）
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AboutDialog } from '@/features/settings/components/about-dialog'

// 与组件同源（vite define 注入，随 package.json version 走），避免逐版本改断言
const APP_VERSION = __APP_VERSION__

const REPO_URL = 'https://github.com/wyyfzb/mc-commander'
const GITEE_REPO_URL = 'https://gitee.com/wyyfzb/mc-commander'
const AUTHOR_URL = 'https://github.com/wyyfzb'

function renderDialog(open = true) {
  const onOpenChange = vi.fn<(open: boolean) => void>()
  render(<AboutDialog open={open} onOpenChange={onOpenChange} />)
  return { onOpenChange }
}

describe('AboutDialog 可访问名与版本', () => {
  it('弹窗以「MC Commander」为可访问名（DialogTitle 承担，不是内嵌卡片的 h3）', () => {
    renderDialog()
    const dialog = screen.getByRole('dialog', { name: 'MC Commander' })
    expect(dialog).toBeInTheDocument()
    // 标题是弹窗标题本身：h2（弹窗层级的标题），不是卡片里的 h3
    expect(screen.getByRole('heading', { name: 'MC Commander', level: 2 })).toBeInTheDocument()
    expect(screen.getByText('自托管 Minecraft 服务器管理客户端')).toBeInTheDocument()
  })

  it('版本徽章随 package.json 走（mono）', () => {
    renderDialog()
    const badge = screen.getByText(new RegExp(`^v${APP_VERSION}$`))
    expect(badge).toBeInTheDocument()
    expect(badge.classList.contains('font-mono')).toBe(true)
  })

  it('open=false 时不渲染内容', () => {
    renderDialog(false)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('AboutDialog 开源声明', () => {
  it('「开源项目」+「基于 AGPL-3.0 协议开源」', () => {
    renderDialog()
    expect(screen.getByText('开源项目')).toBeInTheDocument()
    expect(screen.getByText('基于 AGPL-3.0 协议开源')).toBeInTheDocument()
  })
})

describe('AboutDialog 相关链接', () => {
  it('四行外链：href 正确 + target=_blank + rel=noreferrer', () => {
    renderDialog()
    // 作者署名也是链接，先按 href 把「相关链接」的四行摘出来
    const links = screen.getAllByRole('link').filter((l) => l.getAttribute('href') !== AUTHOR_URL)
    expect(links).toHaveLength(4)
    const hrefs = links.map((l) => l.getAttribute('href'))
    expect(hrefs).toEqual([REPO_URL, GITEE_REPO_URL, `${REPO_URL}/releases`, `${REPO_URL}/issues`])
    for (const link of links) {
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noreferrer')
    }
  })

  it('四行标题/副标题文案', () => {
    renderDialog()
    const links = screen.getAllByRole('link').filter((l) => l.getAttribute('href') !== AUTHOR_URL)
    expect(within(links[0]!).getByText('GitHub 仓库')).toBeInTheDocument()
    expect(within(links[0]!).getByText('查看源代码并参与贡献')).toBeInTheDocument()
    expect(within(links[1]!).getByText('Gitee 镜像仓库')).toBeInTheDocument()
    expect(within(links[1]!).getByText('国内访问 · 自动同步')).toBeInTheDocument()
    expect(within(links[2]!).getByText('项目 Releases')).toBeInTheDocument()
    expect(within(links[2]!).getByText('查看版本发布与更新日志')).toBeInTheDocument()
    expect(within(links[3]!).getByText('问题反馈')).toBeInTheDocument()
    expect(within(links[3]!).getByText('报告 Bug 或建议新功能')).toBeInTheDocument()
  })
})

describe('AboutDialog 作者与版权', () => {
  it('作者署名链接指向作者主页', () => {
    renderDialog()
    const author = screen.getByRole('link', { name: '@wyyfzb' })
    expect(author).toHaveAttribute('href', AUTHOR_URL)
    expect(author).toHaveAttribute('target', '_blank')
    expect(author).toHaveAttribute('rel', 'noreferrer')
  })

  it('版权文案（居中 subtle）', () => {
    renderDialog()
    const copyright = screen.getByText('© 2026 MC_Commander · 社区开源项目')
    expect(copyright.classList.contains('text-center')).toBe(true)
    expect(copyright.classList.contains('text-mcs-text-muted')).toBe(true)
  })
})

describe('AboutDialog 边界', () => {
  /* 反向锚点：更新检查与运行环境是「要不要更新 / 环境健不健康」的运维判断，
     不是关于的静态介绍。它们住「数据与卸载」页底部，出现在这里说明归属又漂了 */
  it('不含更新检查与运行环境（它们住「数据与卸载」）', () => {
    renderDialog()
    expect(screen.queryByText(/检查更新/)).not.toBeInTheDocument()
    expect(screen.queryByText(/运行环境/)).not.toBeInTheDocument()
  })

  it('关闭按钮触发 onOpenChange(false)', async () => {
    const user = userEvent.setup()
    const { onOpenChange } = renderDialog()
    await user.click(screen.getByRole('button', { name: '关闭弹窗' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
