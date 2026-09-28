/**
 * `docs/user-guide.md` 的极小 Markdown 解析器（帮助页专用，**不是**通用实现）。
 *
 * 为什么不用现成实现：只有这一份文档要解析，而它的构件集是**封闭且可枚举**的（见
 * `__tests__/guide-markdown.test.ts` 对真实文档的逐行覆盖断言）。为一个受控文档引
 * Markdown 依赖（还得配 sanitizer）不划算，且通用渲染器输出裸 HTML —— 与本仓
 * 现无 `dangerouslySetInnerHTML` 的现状相悖。
 *
 * 覆盖面由测试锁定：解析**真实**文档时不得产出 `unknown` 块。文档里出现新构件时
 * 测试先红，再决定「补解析」还是「改写文档」，不会静默丢内容。
 */

/** 行内构件（顺序即优先级：图片先于链接，代码先于加粗） */
export type GuideInline =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; href: string }
  | { kind: 'image'; alt: string; src: string }

export interface GuideListItem {
  inline: GuideInline[]
  /** 子列表（本文件的真实形态：目录里嵌在有序项下的无序子项） */
  sub?: GuideList
}

export interface GuideList {
  ordered: boolean
  items: GuideListItem[]
}

export type GuideBlock =
  | { kind: 'heading'; depth: number; id: string; inline: GuideInline[] }
  | { kind: 'paragraph'; inline: GuideInline[] }
  | { kind: 'list'; list: GuideList }
  | { kind: 'table'; head: GuideInline[][]; rows: GuideInline[][][] }
  | { kind: 'quote'; inline: GuideInline[] }
  | { kind: 'divider' }
  | { kind: 'image'; alt: string; src: string }
  /** 未覆盖的行：测试断言真实文档下为零（见文件头注释） */
  | { kind: 'unknown'; line: number; text: string }

export interface ParsedGuide {
  /** 文档自身的一级标题（页面拿它当页头标题，故正文里不再重复渲染） */
  title: string
  blocks: GuideBlock[]
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/
const DIVIDER_RE = /^-{3,}\s*$/
const QUOTE_RE = /^>\s?(.*)$/
const UL_ITEM_RE = /^(\s*)[-*]\s+(.*)$/
const OL_ITEM_RE = /^(\s*)\d+\.\s+(.*)$/
const IMAGE_RE = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/
const TABLE_ROW_RE = /^\|(.*)\|\s*$/
const TABLE_SEP_RE = /^\|[\s:|-]+\|$/
/** 列表项续行/嵌套子项的前导缩进阈值（文档用 2 空格续行、3 空格嵌套项） */
const INDENT_RE = /^\s{2,}\S/

/**
 * 标题锚点：对齐 GitHub 的 slug 规则（本文件目录里的 11 条 `](#...)` 链接据此解析）。
 * 实测规则：小写 → 空白折叠为 `-` → 去标点（含全角括号与顿号），保留 CJK 与 `-`。
 */
export function headingId(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*`]/g, '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}\-_]/gu, '')
}

/**
 * 合并软换行。Markdown 规范是折行处补空格，但中文文档是**硬折行**的：
 * 补空格会在汉字之间留下可见缝隙（`删除。` + `挂载后` → `删除。 挂载后`）。
 * 故仅当两侧都是 ASCII 字母数字（英文词中折行）才补空格，其余直接粘合。
 */
function joinLines(prev: string, next: string): string {
  return /[A-Za-z0-9]$/.test(prev) && /^[A-Za-z0-9]/.test(next)
    ? `${prev} ${next}`
    : `${prev}${next}`
}

/** 行内解析（单遍扫描：先切构件，再递归处理链接文本里的加粗/代码） */
export function parseInline(text: string): GuideInline[] {
  const re = /(\*\*[^*]+\*\*|`[^`]+`|!\[[^\]]*\]\([^)]+\)|\[[^\]]+\]\([^)]+\))/g
  const out: GuideInline[] = []
  let last = 0
  for (const m of text.matchAll(re)) {
    const index = m.index ?? 0
    if (index > last) out.push({ kind: 'text', text: text.slice(last, index) })
    const token = m[0]
    if (token.startsWith('**')) {
      out.push({ kind: 'strong', text: token.slice(2, -2) })
    } else if (token.startsWith('`')) {
      out.push({ kind: 'code', text: token.slice(1, -1) })
    } else if (token.startsWith('![')) {
      const alt = token.slice(2, token.indexOf(']'))
      out.push({ kind: 'image', alt, src: token.slice(token.indexOf('](') + 2, -1) })
    } else {
      const close = token.indexOf('](')
      out.push({ kind: 'link', text: token.slice(1, close), href: token.slice(close + 2, -1) })
    }
    last = index + token.length
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) })
  return out
}

/** 表格行 → 单元格行内节点（首尾空段来自围栏竖线，去掉） */
function parseRow(line: string): GuideInline[][] {
  const body = line.replace(TABLE_ROW_RE, '$1')
  return body.split('|').map((cell) => parseInline(cell.trim()))
}

export function parseGuide(markdown: string): ParsedGuide {
  const lines = markdown.split(/\r?\n/)
  const blocks: GuideBlock[] = []
  const usedIds = new Set<string>()
  let title = ''

  /**
   * 累积中的块一律先存**原始 markdown 文本**，到 flush 时才 `parseInline`。
   * 反过来（先解析、续行再往 inline 数组尾部追加纯文本）会让折行里的行内标记
   * 变成字面量：文档中「快照**挂载**到当前实例」的 `**挂载**` 正落在续行上，
   * 实测会原样渲染出双星号。
   */
  interface RawItem {
    raw: string
    sub?: { ordered: boolean; items: RawItem[] }
  }
  let openParagraph: string | null = null
  let openList: { ordered: boolean; items: RawItem[] } | null = null
  let openItem: RawItem | null = null
  let openQuote: string | null = null
  let tableRows: string[] = []

  const toList = (raw: { ordered: boolean; items: RawItem[] }): GuideList => ({
    ordered: raw.ordered,
    items: raw.items.map((item) => ({
      inline: parseInline(item.raw),
      ...(item.sub ? { sub: toList(item.sub) } : {}),
    })),
  })

  const flushParagraph = () => {
    if (openParagraph !== null) {
      blocks.push({ kind: 'paragraph', inline: parseInline(openParagraph) })
      openParagraph = null
    }
  }
  const flushList = () => {
    if (openList !== null) {
      blocks.push({ kind: 'list', list: toList(openList) })
      openList = null
      openItem = null
    }
  }
  const flushQuote = () => {
    if (openQuote !== null) {
      blocks.push({ kind: 'quote', inline: parseInline(openQuote) })
      openQuote = null
    }
  }
  const flushTable = () => {
    if (tableRows.length > 0) {
      // 第一行是表头、第二行是分隔行（`|---|`），其余是数据行
      const head = parseRow(tableRows[0]!)
      const rest = tableRows.slice(1).filter((row) => !TABLE_SEP_RE.test(row))
      blocks.push({ kind: 'table', head, rows: rest.map(parseRow) })
      tableRows = []
    }
  }
  const flushAll = () => {
    flushParagraph()
    flushList()
    flushQuote()
    flushTable()
  }

  for (const [i, rawLine] of lines.entries()) {
    const line = rawLine.trimEnd()
    if (line.trim() === '') {
      flushAll()
      continue
    }

    if (TABLE_ROW_RE.test(line)) {
      flushParagraph()
      flushList()
      flushQuote()
      tableRows.push(line.trim())
      continue
    }
    flushTable()

    const heading = HEADING_RE.exec(line)
    if (heading) {
      flushAll()
      const depth = heading[1]!.length
      const text = heading[2]!.trim()
      if (depth === 1 && title === '' && blocks.length === 0) {
        title = text
        continue
      }
      let id = headingId(text)
      // 同 id 冲突会静默指向第一个标题（目录链接跳错），补序去重
      for (let n = 2; usedIds.has(id); n++) id = `${headingId(text)}-${n}`
      usedIds.add(id)
      blocks.push({ kind: 'heading', depth, id, inline: parseInline(text) })
      continue
    }

    if (DIVIDER_RE.test(line)) {
      flushAll()
      blocks.push({ kind: 'divider' })
      continue
    }

    const quote = QUOTE_RE.exec(line)
    if (quote) {
      flushParagraph()
      flushList()
      const text = quote[1]!.trim()
      openQuote = openQuote === null ? text : joinLines(openQuote, text)
      continue
    }
    flushQuote()

    const image = IMAGE_RE.exec(line)
    if (image) {
      flushAll()
      blocks.push({ kind: 'image', alt: image[1]!, src: image[2]! })
      continue
    }

    const ul = UL_ITEM_RE.exec(line)
    const ol = ul ? null : OL_ITEM_RE.exec(line)
    if (ul || ol) {
      flushParagraph()
      const indent = (ul ? ul[1]! : ol![1]!).length
      const text = (ul ? ul[2]! : ol![2]!).trim()
      const ordered = ol !== null
      const item: RawItem = { raw: text }
      if (openList !== null && indent > 0 && openItem !== null) {
        // 嵌套子项：挂在当前项下，且不改「当前项」（其后缩进续行仍归父项）
        const sub = openItem.sub ?? { ordered, items: [] }
        sub.items.push(item)
        openItem.sub = sub
      } else if (openList !== null && openList.ordered === ordered) {
        openList.items.push(item)
        openItem = item
      } else {
        flushList()
        openList = { ordered, items: [item] }
        openItem = item
      }
      continue
    }

    // 显式报 unknown 的两类：代码围栏与裸 HTML 标签行。二者不会被下方「并入段落」捕获成
    // 正文（围栏会被吃掉行结构、HTML 会被 React 当文本转义显示），故在这里显式登记，
    // 由测试对真实文档断言未知块为 0。
    if (/^\s*```/.test(rawLine) || /^\s*<\/?[a-zA-Z][^>]*>/.test(rawLine)) {
      flushAll()
      blocks.push({ kind: 'unknown', line: i + 1, text: line })
      continue
    }

    if (INDENT_RE.test(rawLine) && openItem !== null) {
      // 列表项续行：折行属于上一项（文档里归档快照那条即此形态），并入其原始文本
      openItem.raw = joinLines(openItem.raw, line.trim())
      continue
    }

    // Markdown 段落可跨行折行（**不限缩进**），故非块起手的行一律并入当前段落。
    // 代价是「未知构件会被当正文渲染」——它会以字面量形式出现在页面上（可见的错），
    // 而不是被静默丢掉；真正会被静默吞掉的只有代码围栏与裸 HTML，二者在上方显式报 unknown，
    // 并由测试对真实文档断言为 0。
    if (openParagraph !== null) {
      openParagraph = joinLines(openParagraph, line.trim())
      continue
    }
    if (openList !== null) flushList()
    openParagraph = line
  }
  flushAll()
  return { title, blocks }
}
