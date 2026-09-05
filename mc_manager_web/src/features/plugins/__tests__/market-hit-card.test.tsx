/**
 * 市场结果卡片行为级测试（#482 拆分护住：render + userEvent 触达版本列表路径）
 * 覆盖：卡片主体渲染与展开回调 / 版本行渲染（通道徽章/同名已安装/体积/兼容截断）
 *       与安装回调 / 兜底路径（未命名项目 + 错误态 + 安装中禁用）
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { MarketSearchHit, MarketVersion } from '@/api/types'
import { MarketHitCard, type VersionsPanel } from '../market-hit-card'

const HIT: MarketSearchHit = {
  projectId: 'fake-core',
  slug: 'fake-core',
  title: 'FakeCore',
  description: 'A fake core library for testing',
  author: 'Steve',
  downloads: 757014,
  follows: 10,
  iconUrl: null,
  dateModified: '2026-01-01T00:00:00Z',
  categories: ['chat', 'economy'],
  serverSide: 'required',
  clientSide: 'unsupported',
}

const VERSION: MarketVersion = {
  versionNumber: '1.0.0',
  versionType: 'release',
  name: 'FakeCore 1.0.0',
  changelog: null,
  datePublished: '2026-01-01T00:00:00Z',
  downloads: 100,
  gameVersions: ['1.21.4', '1.21.3', '1.21.2', '1.21.1'],
  loaders: ['paper', 'fabric'],
  file: { url: null, filename: 'FakeCore-1.0.0.jar', size: 4605977 },
}

function renderCard(overrides: Partial<Parameters<typeof MarketHitCard>[0]> = {}) {
  const props = {
    hit: HIT,
    expanded: false,
    panel: null,
    installingKey: null,
    installedFiles: new Set<string>(),
    onToggle: vi.fn(),
    onInstall: vi.fn(),
    ...overrides,
  }
  render(<MarketHitCard {...props} />)
  return props
}

describe('MarketHitCard', () => {
  it('渲染卡片主体（标题/作者/下载量 chip/描述/分类）并经点击触发展开回调', async () => {
    const user = userEvent.setup()
    const props = renderCard()
    expect(screen.getByText('FakeCore')).toBeInTheDocument()
    expect(screen.getByText('Steve')).toBeInTheDocument()
    expect(screen.getByText('↓ 757k')).toBeInTheDocument() // formatCompact 紧凑格式
    expect(screen.getByText('A fake core library for testing')).toBeInTheDocument()
    expect(screen.getByText('chat')).toBeInTheDocument()
    expect(screen.getByText('economy')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '展开 FakeCore 的版本列表' }))
    expect(props.onToggle).toHaveBeenCalledTimes(1)
  })

  it('展开版本面板：通道徽章/loader chip/体积/兼容版本截断/同名已安装；点安装回调携带版本对象', async () => {
    const user = userEvent.setup()
    const panel: VersionsPanel = {
      slug: 'fake-core',
      versions: [VERSION],
      loading: false,
      error: null,
    }
    const props = renderCard({
      expanded: true,
      panel,
      installedFiles: new Set(['FakeCore-1.0.0.jar']),
    })
    expect(screen.getByTestId('market-versions')).toBeInTheDocument()
    expect(screen.getByText('1.0.0')).toBeInTheDocument()
    expect(screen.getByText('正式')).toBeInTheDocument()
    expect(screen.getByText('同名已安装')).toBeInTheDocument() // 净化文件名比对命中
    expect(screen.getByText('paper')).toBeInTheDocument()
    expect(screen.getByText('fabric')).toBeInTheDocument()
    expect(screen.getByText(/4\.4 MB/)).toBeInTheDocument() // formatFileSize（同行拼接发布时间）
    // 4 个兼容版本截断为前 3 个 + 「等」
    expect(screen.getByTitle('1.21.4, 1.21.3, 1.21.2, 1.21.1')).toHaveTextContent(
      '兼容 1.21.4, 1.21.3, 1.21.2 等',
    )
    await user.click(screen.getByRole('button', { name: '安装 FakeCore 1.0.0' }))
    expect(props.onInstall).toHaveBeenCalledTimes(1)
    expect(props.onInstall).toHaveBeenCalledWith(VERSION)
  })

  it('兜底路径：title/slug 均空回退「未命名项目」；面板错误态直出；安装中禁用按钮', async () => {
    renderCard({
      hit: { ...HIT, title: null, slug: null },
      expanded: true,
      panel: { slug: '', versions: [], loading: false, error: '版本拉取失败' },
    })
    // expanded=true 时 aria 前缀为「收起」
    expect(screen.getByRole('button', { name: /收起 未命名项目 的版本列表/ })).toBeInTheDocument()
    expect(screen.getByText('版本拉取失败')).toBeInTheDocument()

    renderCard({
      expanded: true,
      panel: { slug: 'fake-core', versions: [VERSION], loading: false, error: null },
      installingKey: 'fake-core@1.0.0',
    })
    const installing = screen.getByRole('button', { name: '安装 FakeCore 1.0.0' })
    expect(installing).toBeDisabled()
    expect(screen.getByText('安装中…')).toBeInTheDocument()
  })
})
