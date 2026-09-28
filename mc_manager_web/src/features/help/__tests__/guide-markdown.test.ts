/**
 * 帮助页 Markdown 解析器对**真实文档**的覆盖锁定。
 *
 * 为什么必须有：解析器是「受控文档」的实现——覆盖面靠「文档里出现的构件集可枚举」成立。
 * 文档加一个新构件（代码围栏、嵌套引用……）时，通用解析器最多渲染得难看，而这里会
 * **静默丢内容**。故断言「解析真实文档不产出 unknown 块」：加构件时本用例先红，
 * 再决定补解析还是改写文档。
 */
import { describe, it, expect } from 'vitest'
import { headingId, parseGuide, parseInline, type GuideBlock } from '../guide-markdown'
import guideRaw from '../../../../../docs/user-guide.md?raw'

const guide = parseGuide(guideRaw)

/** 行内节点的纯文本（图片取 alt：断言的是「这段文字在不在」） */
function inlineText(nodes: { kind: string; text?: string; alt?: string }[]): string {
  return nodes.map((n) => n.text ?? n.alt ?? '').join('')
}

function inlineTexts(block: GuideBlock): string {
  if (block.kind === 'heading' || block.kind === 'paragraph' || block.kind === 'quote') {
    return inlineText(block.inline)
  }
  return ''
}

describe('真实文档：构件覆盖', () => {
  it('不产出 unknown 块（文档出现新构件时此处先红）', () => {
    const unknown = guide.blocks.filter((b) => b.kind === 'unknown')
    expect(unknown.map((b) => `L${b.line}: ${b.text}`)).toEqual([])
  })

  it('一级标题被抽为页面标题，不留在正文块里', () => {
    expect(guide.title).toBe('MC_Commander 用户向导')
    const h1 = guide.blocks.filter((b) => b.kind === 'heading' && b.depth === 1)
    expect(h1).toEqual([])
  })

  it('标题层级与顺序：7 个二级 + 5 个三级', () => {
    const heads = guide.blocks.filter((b) => b.kind === 'heading')
    expect(heads.filter((b) => b.depth === 2)).toHaveLength(7)
    expect(heads.filter((b) => b.depth === 3)).toHaveLength(5)
  })

  it('目录里 11 条锚点链接全部能在标题 id 上解析（改标题不更目录即红）', () => {
    const ids = new Set(guide.blocks.flatMap((b) => (b.kind === 'heading' ? [b.id] : [])))
    const anchors = [...guideRaw.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]!)
    expect(anchors).toHaveLength(11)
    const dangling = anchors.filter((a) => !ids.has(a))
    expect(dangling).toEqual([])
  })

  it('表格：2 张，表头与数据行列数一致', () => {
    const tables = guide.blocks.filter((b) => b.kind === 'table')
    expect(tables).toHaveLength(2)
    for (const t of tables) {
      expect(t.head.length).toBeGreaterThan(0)
      for (const row of t.rows) expect(row).toHaveLength(t.head.length)
    }
  })

  it('列表：目录 1 个有序项 + 5 个嵌套子项；正文列表齐备', () => {
    const lists = guide.blocks.flatMap((b) => (b.kind === 'list' ? [b.list] : []))
    const toc = lists[0]!
    expect(toc.ordered).toBe(true)
    expect(toc.items).toHaveLength(6)
    expect(toc.items[4]!.sub?.items).toHaveLength(5)
    expect(toc.items[4]!.sub?.ordered).toBe(false)
  })

  it('引用块 2 处、分隔线 6 条', () => {
    expect(guide.blocks.filter((b) => b.kind === 'quote')).toHaveLength(2)
    expect(guide.blocks.filter((b) => b.kind === 'divider')).toHaveLength(6)
  })

  it('截图 5 张被解析出来（站内不渲染，见 help-page 说明）', () => {
    const images = guide.blocks.filter((b) => b.kind === 'image')
    expect(images).toHaveLength(5)
    for (const img of images) expect(img.src).toMatch(/^\.\.\/screenshots\/.+\.png$/)
  })

  it('正文没有裸 HTML 与代码围栏（否则解析器会漏渲染）', () => {
    expect(guideRaw).not.toMatch(/^\s*```/m)
    expect(guideRaw.replace(/[^<]*<[^a-zA-Z/][^>]*>[^<]*/g, '')).not.toMatch(/<[a-z]/i)
  })
})

describe('软换行合并', () => {
  it('中文折行处不补空格（补了会在汉字间留缝）', () => {
    const para = guide.blocks.find(
      (b) => b.kind === 'paragraph' && inlineTexts(b).includes('面板会终止下载或安装进程'),
    )
    expect(para).toBeDefined()
    // 三个折行接缝：`确认——` / `实例（` / `面板自动`。补空格会在汉字之间留下可见缝隙。
    // 不整体断言「无空格」——该段本就含 ASCII 空格（`MC 版本`、`JAR 并初始化`），那不是折行接缝。
    const text = inlineTexts(para!)
    expect(text).toContain('确认——面板会终止')
    expect(text).toContain('半个实例（若目录')
    expect(text).toContain('并初始化。部署期间')
  })

  it('折行里的行内标记仍然解析（防「先解析、续行再拼字面量」的实现）', () => {
    // 实测踩过：「快照**挂载**到当前实例」的 `**挂载**` 正落在归档快照那条的续行上，
    // 早先实现先 parseInline 再把续行当纯文本追加 ⇒ 页面上原样出现双星号。
    expect(guideRaw).toContain('**挂载**')
    const lists = guide.blocks.flatMap((b) => (b.kind === 'list' ? [b.list] : []))
    const item = lists
      .flatMap((l) => l.items)
      .find((i) => inlineText(i.inline).includes('归档快照'))!
    const strong = item.inline.filter((n) => n.kind === 'strong').map((n) => n.text)
    expect(strong).toContain('挂载')
    expect(strong).toContain('卸载前若还想保留这些备份，请先下载到本机或挂载给另一个实例。')
  })

  it('续行并入所属列表项（归档快照那条横跨 6 行）', () => {
    const lists = guide.blocks.flatMap((b) => (b.kind === 'list' ? [b.list] : []))
    const item = lists
      .flatMap((l) => l.items)
      .find((i) => inlineText(i.inline).includes('归档快照'))
    expect(item).toBeDefined()
    const text = inlineText(item!.inline)
    expect(text).toContain('它是唯一副本')
    expect(text).toContain('挂载给另一个实例')
  })
})

describe('markdown 折行且两侧是英文词时补空格', () => {
  it('ASCII 词中折行补空格，中文折行不补', () => {
    const parsed = parseGuide(['a', 'b', '', '中', '文'].join('\n'))
    expect(inlineTexts(parsed.blocks[0]!)).toBe('a b')
    expect(inlineTexts(parsed.blocks[1]!)).toBe('中文')
  })
})

describe('行内构件', () => {
  it('加粗 / 行内代码 / 链接 / 图片四类齐备且顺序正确', () => {
    expect(parseInline('**加粗**与`代码`')).toEqual([
      { kind: 'strong', text: '加粗' },
      { kind: 'text', text: '与' },
      { kind: 'code', text: '代码' },
    ])
    expect(parseInline('见 [文档](https://example.com) 与 ![图](../screenshots/a.png)')).toEqual([
      { kind: 'text', text: '见 ' },
      { kind: 'link', text: '文档', href: 'https://example.com' },
      { kind: 'text', text: ' 与 ' },
      { kind: 'image', alt: '图', src: '../screenshots/a.png' },
    ])
  })

  it('标题锚点规则：去标点、空白转连字符、保留 CJK', () => {
    expect(headingId('仪表盘（终端与命令）')).toBe('仪表盘终端与命令')
    expect(headingId('1. 部署面板')).toBe('1-部署面板')
  })

  it('slug 冲突时补序去重（否则目录链接静默指向第一个同名标题）', () => {
    const parsed = parseGuide('# T\n\n## 同名\n\n## 同名')
    const ids = parsed.blocks.filter((b) => b.kind === 'heading').map((b) => b.id)
    expect(ids).toEqual(['同名', '同名-2'])
  })
})
