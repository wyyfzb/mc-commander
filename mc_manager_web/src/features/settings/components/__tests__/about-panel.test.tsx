/**
 * AboutPanel 测试（静态面板无网络依赖）：
 * - 应用名 + 副标题 + 版本徽章（mono）
 * - 开源卡片（开源项目 + 基于 AGPL-3.0 协议开源）
 * - 相关链接卡片：四行外链（含 Gitee 镜像） href/target/rel + 标题副标题
 * - 版权文案（居中 subtle）
 */
import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { AboutPanel } from '../about-panel'

// 与 vite define 同源（package.json version），避免逐版本改断言
const APP_VERSION = '0.1.0'

const REPO_URL = 'https://github.com/wyyfzb/mc-commander'
const GITEE_REPO_URL = 'https://gitee.com/wyyfzb/mc-commander'

describe('AboutPanel 应用信息', () => {
  it('应用名 + 副标题 + 版本徽章（mono）', () => {
    render(<AboutPanel />)
    expect(screen.getByRole('heading', { name: 'MC Commander' })).toBeInTheDocument()
    expect(screen.getByText('自托管 Minecraft 服务器管理客户端')).toBeInTheDocument()
    // 版本号随 package.json 走（vite define 注入），不逐版本改断言
    const badge = screen.getByText(new RegExp(`^v${APP_VERSION}$`))
    expect(badge).toBeInTheDocument()
    expect(badge.classList.contains('font-mono')).toBe(true)
  })
})

describe('AboutPanel 开源卡片', () => {
  it('「开源项目」+「基于 AGPL-3.0 协议开源」', () => {
    render(<AboutPanel />)
    expect(screen.getByText('开源项目')).toBeInTheDocument()
    expect(screen.getByText('基于 AGPL-3.0 协议开源')).toBeInTheDocument()
  })
})

describe('AboutPanel 相关链接', () => {
  it('四行外链：href 正确 + target=_blank + rel=noreferrer', () => {
    render(<AboutPanel />)
    const links = screen.getAllByRole('link')
    expect(links).toHaveLength(4)
    const hrefs = links.map((l) => l.getAttribute('href'))
    expect(hrefs).toEqual([REPO_URL, GITEE_REPO_URL, `${REPO_URL}/releases`, `${REPO_URL}/issues`])
    for (const link of links) {
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noreferrer')
    }
  })

  it('四行标题/副标题文案', () => {
    render(<AboutPanel />)
    const links = screen.getAllByRole('link')
    expect(within(links[0]!).getByText('⭐ GitHub 仓库')).toBeInTheDocument()
    expect(within(links[0]!).getByText('查看源代码并参与贡献')).toBeInTheDocument()
    expect(within(links[1]!).getByText('🇨🇳 Gitee 镜像仓库')).toBeInTheDocument()
    expect(within(links[1]!).getByText('国内访问 · 自动同步')).toBeInTheDocument()
    expect(within(links[2]!).getByText('🚀 项目 Releases')).toBeInTheDocument()
    expect(within(links[2]!).getByText('查看版本发布与更新日志')).toBeInTheDocument()
    expect(within(links[3]!).getByText('🐛 问题反馈')).toBeInTheDocument()
    expect(within(links[3]!).getByText('报告 Bug 或建议新功能')).toBeInTheDocument()
  })
})

describe('AboutPanel 版权', () => {
  it('版权文案（居中 subtle）', () => {
    render(<AboutPanel />)
    const copyright = screen.getByText('© 2026 MC_Commander · 社区开源项目')
    expect(copyright).toBeInTheDocument()
    expect(copyright.classList.contains('text-center')).toBe(true)
    expect(copyright.classList.contains('text-mcs-text-subtle')).toBe(true)
  })
})
