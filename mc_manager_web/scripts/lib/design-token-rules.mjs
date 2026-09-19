/**
 * check-design-tokens.mjs 的额度/档位采集内核（纯函数：入参是文件源码，出参是命中列表）
 *
 * 为什么抽出来：第 21/27 条的「登记额度」与第 23 条的「角色档位表」此前只有探针证据、没有单测——
 * 额度记错一位会静默放行额度外的第 N 处（门禁自己不报错），档位表解析错则让标题档位发散的页面
 * 静默通过；两者都是「门禁看起来在跑、其实放行」的失效模式。规则口径只增不减、不得放宽。
 *
 * 约定：本模块不读文件系统（路径解析仍由门禁脚本负责），文件内容由调用方传入，故可单测。
 */

/** 字符串字面量（单引号/双引号/无反引号插值的模板串）；门禁的词表侧判定与本模块共用 */
export const STRING_LITERAL = /'[^'\n]*'|"[^"\n]*"|`(?:[^`\\]|\\.)*`/g

/** 引号配对写法（同一引号字符开合，含反引号内的转义）：按空白切词的现场计数用它，
 *  与 STRING_LITERAL 的差别只在反引号转义处理——两者都是「宁漏不误报」口径 */
const QUOTED_LITERAL = /(["'`])([^"'`\n]*)\1/g

/** 剥掉注释后的正文（一律等长空白替换，保证偏移量↔行号仍与原文对齐）。
 *  供文件级采集判定使用（第 21/27/28 条：注释里的配方示例不算现场）；
 *  逐行规则（第 1–11 条）按原始行判定、不经本函数——两者的取舍各自成立 */
export function stripComments(content) {
  return (
    content
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      // 行注释同样抹成等长空白：会把 https:// 这类串连同其后内容一并吃掉，属「宁漏不误报」的取舍
      .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
  )
}

/** 正文偏移量 → 1 基行号（报错行号与编辑器一致） */
export function lineAt(text, offset) {
  return text.slice(0, offset).split('\n').length
}

/**
 * 额度口径（第 21 条卡片面额度、第 27 条 text-base 额度共用）：
 * 登记额度放行的是**前 N 处现场**，不是整个文件——额度外的第 N+1 处照样报错。
 * 未登记（quota 为 undefined）即额度 0，一处即报。
 */
export function overQuota(hits, quota) {
  return hits.slice(quota ?? 0)
}

/**
 * 第 21 条：卡片面配方标记（`shadow-mcs-card`，卡阴影无第二用途）的现场偏移。
 * 入参须是 stripComments 后的正文：注释里的配方示例不算现场。
 */
export function collectCardSurfaceOffsets(code) {
  return [...code.matchAll(/shadow-mcs-card/g)].map((m) => m.index)
}

/**
 * 第 27 条：原生 text-base（16px，体系外第 7 个字号）的现场。
 * 判定 = 字符串字面量按空白切词后的**整词**比对：变体前缀与拼写（`sm:text-base`）看不见，
 * 同一行的两处各计一次（额度按现场数而非行数）。
 * @returns {{ line: number }[]} 1 基行号，按出现顺序
 */
export function collectTextBaseHits(content) {
  const hits = []
  for (const [i, line] of content.split('\n').entries()) {
    for (const m of line.matchAll(QUOTED_LITERAL)) {
      for (const word of m[2].split(/\s+/)) {
        if (word === 'text-base') hits.push({ line: i + 1 })
      }
    }
  }
  return hits
}

/**
 * 第 28 条：弱档危险描边 + 按钮语义同行的现场（手写危险按钮配方）。
 * 危险按钮的配方唯一声明源是 ui/button 的 destructive 变体——调用点手写
 * `border-mcs-error-border`（弱档，不含 -strong：强档描边是「已选中」语义且
 * 只在变体/tone 词表里声明）加按钮语义，会让危险形态再次发散。
 * 按钮语义按同行标记近似（onClick / Button / 原生 button / role="button"）；
 * 跨行的 className 刻意不判（与逐行规则口径一致，宁漏不误报）。
 * 入参须是 stripComments 后的正文：注释里引用的配方示例不算现场。
 * @returns {{ line: number }[]} 1 基行号，按出现顺序
 */
const DANGEROUS_BUTTON_BORDER = /border-mcs-error-border(?!-strong)/
const BUTTON_SEMANTICS = /\bonClick=|<Button\b|<button\b|role="button"/
export function collectDangerousButtonBorderHits(code) {
  const hits = []
  for (const [i, line] of code.split('\n').entries()) {
    if (DANGEROUS_BUTTON_BORDER.test(line) && BUTTON_SEMANTICS.test(line))
      hits.push({ line: i + 1 })
  }
  return hits
}

/**
 * 第 29 条：交互元素裸取消 outline 的现场（焦点不可见）。
 * 全局 `:focus-visible` 兜底（index.css）给所有未显式声明焦点类的交互元素提供
 * token 焦点环；`outline-none/outline-hidden` 在 utilities 层会把它的 outline-style
 * 钉死为 none——同处没有 ring/outline 替换指示器时，键盘焦点完全不可见
 * （第 8 条只拦「outline-none 与 focus-visible:outline-* 互相抵消」的成对形态，
 * 单独裸取消正是它的漏检面；「outline-none + 仅 outline 颜色类」的组合刻意留给
 * 第 8 条判，本条不重复计数）。替换指示器按 focus ring 与 focus outline 的粗细档
 * 近似，outline-1 不算——替换须达到全局兜底同级的 2px 基线。
 * 交互形态按同行标记近似：按钮四标记之外含 input/textarea/select（表单控件的
 * 焦点环同等重要，ui/command.tsx:103 的命令面板输入框曾是现实反例）；弹层容器、
 * role=tab 等其余形态刻意不判——跨行 className 也不判（与第 28 条同口径，宁漏不误报）。
 * 入参须是 stripComments 后的正文。
 * @returns {{ line: number }[]} 1 基行号，按出现顺序
 */
const OUTLINE_CANCEL = /\boutline-(none|hidden)\b/
const INTERACTIVE_MARKERS =
  /\bonClick=|<Button\b|<button\b|role="button"|<input\b|<textarea\b|<select\b/
const FOCUS_INDICATOR =
  /focus(-visible)?:(ring-(?:[1-9]|\d{2,}|\[)|outline-(?:[2-9]|\d{2,}|mcs-|\[))/
export function collectFocusCancellationHits(code) {
  const hits = []
  for (const [i, line] of code.split('\n').entries()) {
    if (
      OUTLINE_CANCEL.test(line) &&
      INTERACTIVE_MARKERS.test(line) &&
      !FOCUS_INDICATOR.test(line)
    ) {
      hits.push({ line: i + 1 })
    }
  }
  return hits
}

/** 标题标签所在行（显式字号档的判定行） */
const HEADING_TAG_LINE = /<h[1-6][\s>]/
/** 字号档类名（2xs/xs/sm/md/lg/xl/display = token 名，与标题标签行的档同口径） */
export const MCS_SIZE_CLASS = /text-mcs-(2xs|xs|sm|md|lg|xl|display)\b/g
/** 标题组件声明：`function *Title/*Header(`（含 export） */
const TITLE_FUNCTION_DECL = /(?:export\s+)?function\s+\w+(?:Title|Header)\w*\s*\(/g
/** 组件体内承载标题的元素：带 className 的 JSX 起始标签（含基座里的 `<Tag`），
 *  档位取该类名串的首个 text-mcs-* */
const JSX_TEXT_ELEMENT = /<([a-zA-Z][\w.]*)\b[^\n]*?className=[^\n]*?text-mcs-/
/** `<*Title/*Header>` 用法（大写开头，故与 `function XxxTitle(` 声明不混） */
const JSX_TITLE_TAG = /<([A-Z]\w*(?:Title|Header))\b/g
/** 标题组件的角色轴档位表声明：`const NAME = { role: 'text-mcs-档' } as const`
 *  （角色轴基座的事实源——档位不在元素行上，元素行只写 `NAME[variant]`） */
const ROLE_TIER_MAP_DECL = /const\s+([A-Z]\w*)\s*=\s*\{([\s\S]*?)\}\s*as\s+const/g
/** 角色轴档位表的条目（角色名 → 字号档；档取 token 名，与标题标签行的档同口径） */
const ROLE_TIER_ENTRY = /(\w+)\s*:\s*'text-mcs-(2xs|xs|sm|md|lg|xl|display)'/g
/** 元素行上的角色查表写法 `NAME[param]` */
const ROLE_LOOKUP = /([A-Z]\w*)\s*\[\s*(\w+)\s*\]/
/** 调用点上的字面量角色 `variant="label"`（单双引号等义，都算字面量；只认双引号会把
 *  单引号调用点误判成缺省角色、静默丢掉另一档） */
const VARIANT_LITERAL = /\svariant=["'](\w+)["']/

/**
 * 角色档位表采集（G23）：`const NAME = { role: 'text-mcs-档' } as const` → Map<表名, Map<角色, 档>>。
 * 档位不硬编码：基座改角色表即改口径。非 `as const` 的对象、非字号档取值、非字面量条目都不采集
 * （读不出档就不计档，宁漏不误报）。
 */
export function collectRoleTierMaps(code) {
  const maps = new Map()
  for (const m of code.matchAll(ROLE_TIER_MAP_DECL)) {
    const entries = new Map()
    for (const entry of m[2].matchAll(ROLE_TIER_ENTRY)) entries.set(entry[1], entry[2])
    if (entries.size > 0) maps.set(m[1], entries)
  }
  return maps
}

/**
 * 该文件里各标题组件自身的基座档（G23）。单档基座取组件体内第一个承载标题的元素行的
 * text-mcs-*；角色轴基座（元素行写 `NAME[variant]`）读同文件的角色档位表 + 参数默认角色，
 * 调用点再按 `variant="..."` 分类取档。两种都读不出档即不计档（宁漏不误报）。
 */
export function titleBaseTiers(code) {
  const roleMaps = collectRoleTierMaps(code)
  const facets = []
  for (const m of code.matchAll(TITLE_FUNCTION_DECL)) {
    const name = m[0].match(/function\s+(\w+)/)[1]
    // 参数表的 `{` 不是函数体，先按括号配平跨过参数表，再从体的 `{` 起按花括号配平
    const parenAt = code.indexOf('(', m.index)
    let parens = 1
    let after = parenAt + 1
    for (; after < code.length && parens > 0; after++) {
      if (code[after] === '(') parens++
      else if (code[after] === ')') parens--
    }
    const bodyStart = code.indexOf('{', after)
    if (bodyStart < 0) continue
    let braces = 0
    let end = bodyStart
    for (; end < code.length; end++) {
      if (code[end] === '{') braces++
      else if (code[end] === '}' && --braces === 0) break
    }
    const body = code.slice(bodyStart, end)
    const lookup = body.match(ROLE_LOOKUP)
    const roleTiers = lookup ? roleMaps.get(lookup[1]) : null
    if (roleTiers) {
      // 默认角色＝该参数在签名里的默认值（`variant = 'heading'`）
      const declared = code
        .slice(parenAt + 1, after - 1)
        .match(new RegExp(`\\b${lookup[2]}\\s*=\\s*'(\\w+)'`))
      facets.push({ name, roleTiers, defaultRole: declared ? declared[1] : null })
      continue
    }
    for (const line of body.split('\n')) {
      if (!JSX_TEXT_ELEMENT.test(line)) continue
      const tier = [...line.matchAll(MCS_SIZE_CLASS)][0]
      if (tier) facets.push({ name, tier: tier[1] })
      break
    }
  }
  return facets
}

/** 调用点上该标题实际落的档：单档基座直取；角色轴基座按 `variant="..."` 分类，
 *  无 variant 或 variant 非字面量走缺省角色（调用点实际角色静态不可判），未登记角色不计档 */
export function baseTierOf(base, tagText) {
  if (!base.roleTiers) return base.tier
  const gt = tagText.indexOf('>')
  const literal = (gt < 0 ? tagText : tagText.slice(0, gt)).match(VARIANT_LITERAL)
  const role = literal ? literal[1] : base.defaultRole
  return role ? base.roleTiers.get(role) : undefined
}

/**
 * 第 23 条的标题档位采集（静态近似）：判定面＝传入的各模块源码（页文件 + 其直接引用的页内模块
 * + 这些模块再引用的基座），采集「该页可能渲染出的标题」用到的字号档。
 *
 * 已知边界（本条的取舍，非缺陷）：不辨识互斥渲染——设置页 6 个路由子页合计恰好 3 档、正贴上限，
 * 将来任一子面板再加一档就会静默越界；只覆盖一层页内模块，再深一层的模块不计（宁漏不误报）。
 * 档位来源两类：① 标题标签（h1–h6）行的 text-mcs-*；② `<*Title/*Header>` 用法的基座档
 * （从基座声明读，基座换档时自动跟随）。同文件里的正文、角标、数字档不进判定面：
 * KPI 数字档（lg/display）不是标题档，收进来会把数字面板误判成「标题档位发散」。
 *
 * @param {Iterable<string>} scopedCodes 判定面本体（页文件 + 其一层页内模块）的源码
 * @param {Iterable<string>} [baseCodes] 额外用于解析标题**基座档**的模块源码（如 mcs/card）；
 *   缺省同 scopedCodes。基座只贡献「组件名 → 档」的查表项，其自身的标题标签不计入同屏
 *   （否则基座文件里的 h3 会被当成页面上真实渲染的标题标签）
 * @returns {Set<string>} 用到的字号档集合
 */
export function collectHeadingTiers(scopedCodes, baseCodes) {
  const scoped = [...scopedCodes]
  const bases = baseCodes ? [...baseCodes] : scoped
  const baseTierByName = new Map()
  for (const code of bases) {
    for (const facet of titleBaseTiers(code)) baseTierByName.set(facet.name, facet)
  }
  const tiers = new Set()
  for (const code of scoped) {
    for (const line of code.split('\n')) {
      if (HEADING_TAG_LINE.test(line)) {
        const explicit = [...line.matchAll(MCS_SIZE_CLASS)][0]
        if (explicit) tiers.add(explicit[1])
      }
      for (const tag of line.matchAll(JSX_TITLE_TAG)) {
        const base = baseTierByName.get(tag[1])
        if (!base) continue
        const tier = baseTierOf(base, line.slice(tag.index))
        if (tier) tiers.add(tier)
      }
    }
  }
  return tiers
}
