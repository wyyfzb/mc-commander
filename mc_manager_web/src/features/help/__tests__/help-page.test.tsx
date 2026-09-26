/**
 * HelpPage 渲染锁定。两条腿，缺一不可：
 * ① **真实文档**（`docs/user-guide.md` → `?raw` 内联）：锁「文档 → 页面」这条链路。
 *    文档改了标题层级或表格形状而页面没跟上 → 这里红。
 * ② **夹具**（`GuideBlocks` / `Block` / `Inline`）：真实文档里没有外链（实测 0 处）、
 *    没有三级以下标题、引用块也不含块级内容 —— 只对着真实文档测，这些分支等于零覆盖。
 */
import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { Block, GuideBlocks, HelpPage, Inline } from '../help-page'
import { parseGuide } from '../guide-markdown'

describe('HelpPage（真实文档）', () => {
  it('页头标题取自文档一级标题（不是页面里手写的另一份）', () => {
    render(<HelpPage />)
    expect(screen.getByRole('heading', { name: 'MC_Commander 用户向导' })).toBeInTheDocument()
  })

  it('渲染文档章节标题', () => {
    render(<HelpPage />)
    for (const section of ['部署面板', '首次设密', '创建 MC 实例', '常见问题']) {
      expect(screen.getByRole('heading', { name: new RegExp(section) })).toBeInTheDocument()
    }
  })

  it('目录锚点可跳转：目录里每条链接都指向页面上真实存在的标题 id', () => {
    render(<HelpPage />)
    const anchors = screen
      .getAllByRole('link')
      .map((a) => a.getAttribute('href'))
      .filter((h): h is string => h !== null && h.startsWith('#'))
    expect(anchors).toHaveLength(11)
    const missing = anchors.filter((h) => document.getElementById(h.slice(1)) === null)
    expect(missing).toEqual([])
  })

  it('目录项锚点落在标题上（不只是「有个同 id 的元素」）', () => {
    render(<HelpPage />)
    const link = screen.getByRole('link', { name: '部署面板' })
    const id = link.getAttribute('href')!.slice(1)
    expect(document.getElementById(id)!.tagName).toBe('H2')
  })

  it('表格渲染为真表格（部署方式表：表头 2 列 + 2 行数据）', () => {
    render(<HelpPage />)
    const tables = screen.getAllByRole('table')
    expect(tables).toHaveLength(2)
    const first = tables[0]!
    expect(within(first).getByRole('columnheader', { name: '方式' })).toBeInTheDocument()
    expect(within(first).getByRole('columnheader', { name: '适用' })).toBeInTheDocument()
    // 1 行表头 + 2 行数据（Linux 一键部署 / 手动部署）
    expect(within(first).getAllByRole('row')).toHaveLength(3)
  })

  it('行内构件不留字面量标记（反引号 / 双星号）', () => {
    const { container } = render(<HelpPage />)
    const text = container.textContent ?? ''
    expect(text).not.toContain('`')
    expect(text).not.toContain('**')
  })

  it('加粗渲染为 strong（文档里「操作路径」等被加粗）', () => {
    const { container } = render(<HelpPage />)
    const strongs = [...container.querySelectorAll('strong')]
    expect(strongs.length).toBeGreaterThan(0)
    expect(strongs.some((s) => s.textContent?.includes('操作路径'))).toBe(true)
  })

  it('行内代码渲染为 code（如 server.jar）', () => {
    const { container } = render(<HelpPage />)
    const codes = [...container.querySelectorAll('code')]
    expect(codes.some((c) => c.textContent === 'server.jar')).toBe(true)
  })

  it('截图不伪装成图片：以「截图见仓库文档」的诚实说明呈现', () => {
    render(<HelpPage />)
    // 产物内没有 screenshots/（Release tarball 只打包服务端 + 内联 mc-schemas），
    // 渲染 <img> 只会是坏图
    expect(screen.queryAllByRole('img')).toHaveLength(0)
    expect(screen.getAllByText(/截图见仓库文档/).length).toBe(5)
  })

  it('无 unknown 块泄漏到页面（解析器兜底路径不该在真实文档下命中）', () => {
    const { container } = render(<HelpPage />)
    expect(container.querySelectorAll('.text-mcs-error-fg')).toHaveLength(0)
  })
})

describe('渲染分支（夹具：真实文档覆盖不到的部分）', () => {
  it('外链：target=_blank + rel=noreferrer（与设置页「关于」范式一致）', () => {
    render(<Inline nodes={[{ kind: 'link', text: '仓库', href: 'https://example.com/x' }]} />)
    const link = screen.getByRole('link', { name: /仓库/ })
    expect(link).toHaveAttribute('href', 'https://example.com/x')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noreferrer')
  })

  it('站内锚点链接不加 target（同页跳转不该开新窗口）', () => {
    render(<Inline nodes={[{ kind: 'link', text: '部署', href: '#1-部署面板' }]} />)
    const link = screen.getByRole('link', { name: '部署' })
    expect(link).not.toHaveAttribute('target')
  })

  it('三级以下标题按 h3 渲染（文档目前最深到 h3）', () => {
    const parsed = parseGuide('## 二档\n\n### 三档\n\n#### 四档')
    render(<GuideBlocks blocks={parsed.blocks} />)
    expect(screen.getByRole('heading', { name: '二档', level: 2 })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '三档', level: 2 })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '四档', level: 3 })).toBeInTheDocument()
  })

  it('引用块与分隔线渲染为 blockquote / hr', () => {
    const parsed = parseGuide('> 一句提示\n\n---')
    const { container } = render(<GuideBlocks blocks={parsed.blocks} />)
    expect(container.querySelector('blockquote')?.textContent).toBe('一句提示')
    expect(container.querySelector('hr')).not.toBeNull()
  })

  it('有序/无序列表与嵌套子列表都按对应语义渲染', () => {
    const parsed = parseGuide('1. 甲\n   - 甲一\n   - 甲二\n2. 乙')
    const { container } = render(<GuideBlocks blocks={parsed.blocks} />)
    const outer = container.querySelector('ol')!
    expect(outer.querySelectorAll(':scope > li')).toHaveLength(2)
    expect(outer.querySelector('ul')!.querySelectorAll('li')).toHaveLength(2)
  })

  it('unknown 块显式可见（含行号），不静默丢内容', () => {
    render(<Block block={{ kind: 'unknown', line: 7, text: '```js' }} />)
    expect(screen.getByText(/\[7\] ```js/)).toBeInTheDocument()
  })
})
