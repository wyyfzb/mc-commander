/**
 * check-design-tokens.mjs 的额度/档位采集内核（纯函数：入参是文件源码，出参是命中列表）
 *
 * 为什么抽出来：第 21/27 条的「登记额度」与第 23 条的「角色档位表」必须有单测——
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
 * 交互形态按**元素标签**判定，不按同行标记：JSX 的属性常逐个换行写，
 * className 落在标签起始行的下方数行是常态（give-item-ticket 的数量输入框即此形态，
 * 同行匹配看不见它）。故先按标签扫描出每个元素的起始行与结束行，再在元素范围内判
 * 取消与替换。弹层容器、role=tab 等非表单/按钮形态刻意不判。
 * 入参须是 stripComments 后的正文。
 * @returns {{ line: number }[]} 1 基行号（className 所在行），按出现顺序
 */
const OUTLINE_CANCEL = /\boutline-(none|hidden)\b/
/** 交互元素起始标签（开标签本身，属性可跨行）；role="button" 的自定义容器同样计入 */
const INTERACTIVE_TAG_OPEN = /<(button|input|textarea|select|Button)\b|<(\w+)\b[^>]*?role="button"/g
const FOCUS_INDICATOR =
  /focus(-visible)?:(ring-(?:[1-9]|\d{2,}|\[)|outline-(?:[2-9]|\d{2,}|mcs-|\[))/

/**
 * JSX 开标签的结束偏移：从 `<tag` 起按引号/括号深度扫，直到深度归零的 `>`。
 * 自闭合 `/>` 同样在 `>` 处结束。找不到返回 -1（畸形源码，不判）。
 */
function tagEndOffset(code, start) {
  let depth = 0
  let quote = null
  for (let i = start; i < code.length; i++) {
    const ch = code[i]
    if (quote) {
      if (ch === quote && code[i - 1] !== '\\') quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch
    else if (ch === '{') depth++
    else if (ch === '}') depth--
    else if (ch === '>' && depth === 0) return i
  }
  return -1
}

export function collectFocusCancellationHits(code) {
  const hits = []
  for (const m of code.matchAll(INTERACTIVE_TAG_OPEN)) {
    const start = m.index
    const end = tagEndOffset(code, start)
    if (end === -1) continue
    const tag = code.slice(start, end + 1)
    if (!OUTLINE_CANCEL.test(tag) || FOCUS_INDICATOR.test(tag)) continue
    // 报 className 所在行（用户要改的那一行），而非标签起始行
    const cancelIdx = tag.search(OUTLINE_CANCEL)
    hits.push({ line: lineAt(code, start + cancelIdx) })
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

/**
 * 第 30 条：内容面 tint 被当交互悬浮用（hover/focus/active 背景）。
 * `--mcs-*-bg-subtle` 是为「承载文字/图标的常驻面」设计的不透明 tint，其有效色已经同
 * 基面算过一次；放到状态前缀上等于让常驻面互相替换，违反「交互悬浮只走覆盖层」
 * （覆盖层＝ --mcs-state-*，危险族另有 --mcs-state-hover-error）。
 * 判定面**含 ui/**：现实反例正是 ui/button 的 destructive-outline 变体——基座破例会被
 * 调用点逐字照抄（曾扩散到 4 处），只扫 feature 等于放行源头。
 * 状态前缀按「变体名里含 hover/focus/active」取，故 hover:/focus-visible:/group-hover:/
 * dark:hover: 一并命中；跨行 className 不判（与第 28/29 条同口径，宁漏不误报）。
 *
 * 数据属性形态的选中态（`data-active:` / `data-[state=active]:`）**不在判定面**：它们表达
 * 「已选中」而非「按下/悬浮」，用内容面 tint 正是设计意图（TONE_SELECTED_* 就这么写）。
 * 判据是前缀里出现 `data-`——CSS 伪类 `active:`（按下态）仍属违规，继续命中。
 * 入参须是 stripComments 后的正文。
 * @returns {{ line: number }[]} 1 基行号，按出现顺序
 */
const TINT_AS_INTERACTION =
  /(?:^|[\s"'`{>])((?:[a-z][\w-]*(?:\[[^\]]*\])?:)+)bg-mcs-[a-z-]*bg-subtle\b/g

/** 交互状态前缀（悬浮/聚焦/按下）；`active` 与 `data-*` 由调用方区分 */
const INTERACTION_PREFIX = /^(?:[\w-]*(?:hover|focus|active)[\w-]*)$/

export function collectTintAsInteractionHits(code) {
  const hits = []
  for (const [i, line] of code.split('\n').entries()) {
    for (const m of line.matchAll(TINT_AS_INTERACTION)) {
      const prefixes = m[1].split(':').filter(Boolean)
      // 数据属性形态（data-active / data-[state=active]）是选中态，不是交互悬浮
      if (prefixes.some((p) => p.startsWith('data-'))) continue
      if (!prefixes.some((p) => INTERACTION_PREFIX.test(p))) continue
      hits.push({ line: i + 1 })
      break
    }
  }
  return hits
}

/**
 * 第 31 条：自造 ARIA 交互组件。
 *
 * 基座（ui/ 下的 Radix 封装）已经提供完整的键盘语义与 ARIA 关系：Switch 有空格切换与
 * aria-checked、Tabs 有 roving tabindex / aria-controls / 方向键、Select 有 listbox 全套。
 * 手写 role="switch" / role="tablist" / role="listbox" 的现场实测都缺关键属性
 * （tablist 缺 aria-controls 且每个 tab 都是 tabIndex=0；listbox 的 option 缺 aria-selected），
 * 读屏与键盘用户拿到的是一个「看起来像、用起来不是」的控件。
 *
 * 判定面：role= 后跟 switch/tablist/listbox/menu/combobox 字面量。扫描面＝src/
 * （排除 components/ui/ 本身——基座就是这些角色的合法声明处）。
 * 宁漏不误报：role="button" 不判（自定义可点容器是常见且合理的选择）。
 *
 * 豁免：文件顶部带 @design-system-ok: <理由> 注释的现场不判。用于「基座装不下、
 * 但已按 ARIA APG 完整实现」的少数场景（如终端命令补全：输入框必须常驻焦点，
 * 用 aria-activedescendant 而非把焦点移进列表，ui/select 的弹层模型不适用）。
 * 豁免要求写出理由——空理由不放行，避免变成随手加的静音开关。
 */
const HANDWRITTEN_ARIA_ROLES = /\brole=["'](switch|tablist|listbox|combobox|menu|radiogroup)["']/
/** 理由须是同行的实词（只写注释结束符的空豁免不算） */
const ARIA_EXEMPTION = /@design-system-ok:[ \t]*(?!\*\/)\S+/

/**
 * @param code 已剥离注释的正文（注释里写的 role="switch" 示例不算现场）
 * @param raw  原文，用于识别 @design-system-ok 豁免标记（它在注释里，剥离后就没了）
 */
export function collectHandwrittenAriaHits(code, raw = '') {
  if (ARIA_EXEMPTION.test(raw)) return []
  const hits = []
  for (const [i, line] of code.split('\n').entries()) {
    const m = HANDWRITTEN_ARIA_ROLES.exec(line)
    if (m) hits.push({ line: i + 1, role: m[1] })
  }
  return hits
}

/**
 * 第 32 条：指针目标尺寸低于 WCAG 2.2 SC 2.5.8 的 24×24 CSS px。
 *
 * 判定的是**明确小于 24px 的显式尺寸**：size-3/3.5/4/5（12/14/16/20px）、
 * h-3…h-5、w-3…w-5。只认这些「写死的小档」——h-full w-5 这类相对尺寸要结合父容器
 * 才知道实际像素，静态判不出来（宁漏不误报）。
 *
 * 按**标签范围**判而不是按行：JSX 属性逐个换行是常态，className 与 <button 常不在同一行。
 * 扫描每个交互元素标签（button/input/textarea/select/Button 与 role="button" 容器），
 * 在标签范围内找小尺寸档；`aria-hidden` 的元素整体跳过（纯装饰标记，如按钮内的图标）。
 *
 * @returns {{ line: number }[]} 1 基行号（小尺寸所在行），按出现顺序
 */
const SMALL_TARGET = /\b(?:size-(?:3|3\.5|4|5)|h-(?:3|3\.5|4|5)|w-(?:3|3\.5|4|5))\b/
const SMALL_TARGET_TAG_OPEN =
  /<(button|input|textarea|select|Button)\b|<(\w+)\b[^>]*?role="button"/g

export function collectSmallTargetHits(code) {
  const hits = []
  for (const m of code.matchAll(SMALL_TARGET_TAG_OPEN)) {
    const start = m.index
    const end = tagEndOffset(code, start)
    if (end === -1) continue
    const tag = code.slice(start, end + 1)
    if (/aria-hidden/.test(tag)) continue
    const small = tag.search(SMALL_TARGET)
    if (small === -1) continue
    hits.push({ line: lineAt(code, start + small) })
  }
  return hits
}

/**
 * 第 33 条：焦点样式用 focus: 而非 focus-visible:。
 *
 * focus: 在鼠标点击时也匹配，于是鼠标用户每次点输入框都会看到一圈「键盘焦点环」——
 * 它既是视觉噪音，也让真正需要它的键盘用户失去信号（两者不再可区分）。
 * 判定面：focus: 后紧跟 ring/outline 类，且同一 className 内没有 focus-visible: 同档。
 * 基座（ui/）已统一用 focus-visible:，故本条只扫 feature 层。
 */
const BARE_FOCUS_RING = /\bfocus:(?:ring-|outline-)/
export function collectBareFocusHits(code) {
  const hits = []
  for (const [i, line] of code.split('\n').entries()) {
    if (BARE_FOCUS_RING.test(line) && !/focus-visible:/.test(line)) hits.push({ line: i + 1 })
  }
  return hits
}
