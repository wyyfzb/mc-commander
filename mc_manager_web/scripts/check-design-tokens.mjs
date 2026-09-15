/**
 * 设计 token 完整性守门脚本（设计文档 §4.5 token 纪律）
 * 用法：node scripts/check-design-tokens.mjs
 * 逐行检查（第 1–11 条，排除 src/components/ui/）：
 *   1. Tailwind 原始色板类（text-{color}/bg-{color}/border-{color}/ring-{color}）
 *   2. dark: 前缀类
 *   3. transition-all（ui/ 由第 20 条覆盖）
 *   4. duration-{数字}（非 token 的硬编码时长；ui/ 由第 20 条覆盖）
 *   5. rounded-[ 任意值圆角
 *   6. Tailwind 原生字号 3xl 及以上（原生字号上限 xl；本仓文字档上限 text-mcs-xl（22px）；
 *      数字面板可走 --mcs-font-size-display（30px），须与 .mcs-num 同用，不占文字档位）
 *   7.（空缺保留）原紧急页字重限定：/emergency 页已移除，后续编号不重排以免外部引用失效
 *   8. 焦点可见性：outline-none 与 focus-visible:outline-* 同处 utilities 层会互相抵消
 *      （outline-style 恒为 none，焦点环零绘制），未补 ring 兜底即报错
 *   9. 未注册的 mcs-* 工具类：@theme 未注册 → Tailwind 静默不生成任何规则（语义丢失）
 *  10. token 角色越界：填充档（tint/brand）作边框或文字 → 边界不可见（1.00-1.40:1）
 *  11. alpha 修饰符越界：文字/边界档叠加 /NN → 跌破实测对比度下限（3.32:1）
 * 全仓检查（第 12–20 条，含 src/components/ui/ 与 e2e/）：
 *  12. 未定义类：源码使用但项目 CSS 未定义、@theme 未注册 → Tailwind 不生成规则（静默无效果）
 *  13. 死类：项目 CSS 定义但全仓 0 使用 → 报错（`@reserved` 注释可豁免）
 *  14. 死 token：semantic.css 定义但全仓 0 消费 → 报错（删除，或加 `@reserved` 注释说明预留原因）
 *  15. 内容面 tint 叠加：同元素出现 ≥2 个 `bg-mcs-*-bg-subtle`，或内容面 tint 与玻璃面同元素 → 报错
 *      （含词表间接写法：同一次 cn/clsx 或同一模板串里 `toneClasses()` 与字面量 tint 共存）
 *      ＋ 六档语义色三件套只允许声明在 components/mcs/tone.ts（别处整串写出一档的
 *      border+bg-subtle+fg 即又抄了一份词表；测试与 tone.ts 自身除外），accent 的
 *      「选中强调」形态（border-strong+bg-subtle 同处共现，三件套与把 fg 留给子元素的
 *      两件套容器两种现场同判）同样只允许出自 tone.ts 的 TONE_SELECTED_* 常量。
 *      注：11b/11c 走 walkDir(srcDir)，即**只扫 src/ 且不含 components/ui/**，不覆盖 e2e/ 与
 *      scripts/；三条声明源判定（词表 tint 叠加 / 六档三件套 / accent 选中强调）的面都是
 *      **一次 cn/clsx 调用的实参表**——同一次调用的不同实参拆写与单个字面量内共现同判
 *      （跨行按括号配平，嵌套调用只取最外层）；模板串另按整串判（cn 之外的常见写法）。
 *      弱档「容器 border+bg / 子元素 fg」的拆写形态**刻意不判**（口径＝维持现状，词表不收
 *      弱档容器，代表点 features/players/components/batch-bar.tsx:111）：弱档描边仅装饰
 *      （暗 25% / 亮 30% alpha），现网 12 处合法着色点覆盖六档语义色，收进判定面只会大面积
 *      误报——属宁漏不误报。
 *  16. Z 轴阶梯：禁裸 z-<数字>（类名 / 内联 zIndex / CSS z-index）
 *  17. 玻璃预算：全站各 1 处（顶栏 glass-chrome + 覆盖层 glass-overlay）
 *  18. 危险语义色禁半透明底：bg-destructive/<alpha>
 *  19. 内容面 tint 必须不透明
 *  20. 布局属性动画（transition-all）与数字时长档（duration-<数字>），含 ui/ 基座
 * 门禁（第 21–27 条，J23/t27；扫描 src/ 全量，排除项在各条内声明）：
 *  21. 卡片面类名（配方）只允许声明在 components/mcs/card.tsx——非卡片面但共用
 *      `shadow-mcs-card` 标记的现场按「登记额度」豁免（额度外的第 N 处即报，豁免的是现场
 *      而非整个文件）
 *  22. 标签组件唯一性：只读状态 StatusPill / 可交互 Chip / 计数 CountBadge，禁第四套标签组件、
 *      已删除的 shadcn ui/badge 引用与重建；判定面是组件声明、模块引用与基座文件存在性
 *      （行内胶囊着色点不判）
 *  23. 页面页头：AppShell 主页面必须有且仅有一个 PageHeader，且该页标题字号档 ≤3
 *      （标题组件的角色轴按调用点分类：CardTitle 默认角色 = 区块标题档，variant="label" = 标签档）
 *  24. 全屏覆盖层必须来自 ui/sheet 或 ui/dialog（禁裸 z-modal 全屏容器 / aside）
 *  25. 行内 onKeyDown 对空格/回车 preventDefault 前必须判落点（e.target）——否则容器会吞掉
 *      行内控件自己的激活键；宿主是 input/textarea 时其默认行为属控件自身，不判
 *  26. 内联 style 的 width/height 必须是数值或含单位字符串（传 Tailwind 类名会被浏览器当
 *      非法 CSS 丢弃——骨架列宽曾整片失效）
 *  27. 原生 text-base（16px，体系外第 7 个字号）：唯一豁免现场是 ui/input.tsx 与
 *      ui/textarea.tsx 各 1 处（移动端聚焦时 <16px 会触发 iOS 自动缩放），按「登记额度」
 *      校验——额度外的第 N 处即报（写法同第 21 条卡片面额度）
 * 类名提取覆盖 className="..."、className={cn(...)}、模板字面量、对象映射值（如 tone: 'bg-...'），
 * 不留「只在 className 字面属性里才检查」的盲区。
 * 发现违规 → 输出 文件:行号 → 非零退出码（阻止合并）
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, extname, relative, sep } from 'node:path'
// 额度/档位采集内核（纯函数；单测见 scripts/__tests__/design-token-rules.test.mjs）。
// 抽出的动因：这些判定此前只有探针证据、没有单测——额度记错一位会静默放行额度外的第 N 处。
import {
  STRING_LITERAL,
  collectCardSurfaceOffsets,
  collectHeadingTiers,
  collectTextBaseHits,
  lineAt,
  overQuota,
  stripComments,
} from './lib/design-token-rules.mjs'

const root = join(import.meta.dirname, '..')
const srcDir = join(root, 'src')
const EXCLUDE_DIR = 'src/components/ui'

// Tailwind 调色板色名（仅拦截视觉色值类，不拦截 transparent/current 等功能值）
const PALETTE_COLORS = new Set([
  'slate','gray','zinc','neutral','stone','red','orange','amber','yellow',
  'lime','green','emerald','teal','cyan','sky','blue','indigo','violet',
  'purple','fuchsia','pink','rose','black','white',
])

/** @theme 注册集（index.css）与 effects.css 定义的动画类——未注册即静默失效 */
function readRegistered() {
  const indexCss = readFileSync(join(srcDir, 'index.css'), 'utf-8')
  const effectsCss = readFileSync(join(srcDir, 'styles', 'effects.css'), 'utf-8')
  // keep：Tailwind v4 的配对行高子键（--text-mcs-sm--line-height）会被贪婪捕获成
  // `sm--line-height`。parseTokenClass 对含 `--` 的 raw 先返回 null，故该路径当前不可达，
  // 保留它是防御性的：注册集本身不该收进子键名，将来正则或解析改动时不会再放出假档名。
  const collect = (css, re, keep = () => true) =>
    new Set([...css.matchAll(re)].map((m) => m[1]).filter(keep))
  return {
    color: collect(indexCss, /--color-mcs-([\w-]+)\s*:/g),
    radius: collect(indexCss, /--radius-mcs-([\w-]+)\s*:/g),
    text: collect(indexCss, /--text-mcs-([\w-]+)\s*:/g, (name) => !name.endsWith('--line-height')),
    duration: collect(indexCss, /--duration-mcs-([\w-]+)\s*:/g),
    ease: collect(indexCss, /--ease-mcs-([\w-]+)\s*:/g),
    shadow: collect(indexCss, /--shadow-mcs-([\w-]+)\s*:/g),
    animate: collect(effectsCss, /\.animate-mcs-([\w-]+)\s*\{/g),
  }
}
const REGISTERED = readRegistered()
const COLOR_PREFIXES = new Set([
  'bg','text','border','ring','outline','fill','stroke','divide','decoration','caret','from','via','to',
])

let violations = 0

/** 提取一行中的全部字符串字面量（单引号/双引号/无反引号插值的模板串） */
function extractLiterals(line) {
  const out = []
  for (const m of line.matchAll(/(["'`])([^"'`\n]*)\1/g)) out.push(m[2])
  return out
}

/** 解析一条类名 → { prefix, name, alpha }；非 token 类返回 null（剥离变体前缀、!、alpha 修饰符） */
function parseTokenClass(raw) {
  if (!raw.includes('-mcs-')) return null
  if (raw.includes('(') || raw.includes('--')) return null // var(--mcs-*) / color-mix 等非类名
  const body = raw.replace(/!$/, '')
  const alphaMatch = body.match(/\/(\d+|\[[^\]]+\])$/)
  const base = alphaMatch ? body.slice(0, -alphaMatch[0].length) : body
  const m = base.slice(base.lastIndexOf(':') + 1).match(/^([a-z-]+)-mcs-([a-z0-9-]+)$/)
  if (!m) return null
  return { prefix: m[1], name: m[2], alpha: alphaMatch ? alphaMatch[1] : null }
}

/** 该 token 名是否颜色档（文字档/圆角档/动效档等同名前缀不算） */
function isColorToken(prefix, name) {
  if (prefix === 'rounded' || prefix.startsWith('rounded-')) return false
  if (prefix === 'duration' || prefix === 'ease' || prefix === 'animate') return false
  if (prefix === 'text') return REGISTERED.color.has(name) && !REGISTERED.text.has(name)
  if (prefix === 'shadow') return REGISTERED.color.has(name) && !REGISTERED.shadow.has(name)
  return REGISTERED.color.has(name)
}

/** token 角色（按命名公式推导，新增 token 自动归类；unknown 不参与角色矩阵） */
function roleOf(name) {
  if (name === 'focus-ring') return 'ring'
  // 顺序敏感：tint 判定必须先于 dimension-（维度色也有 -bg-subtle 内容面档）
  if (name.endsWith('-bg-subtle') || name.startsWith('state-') || name.startsWith('scrim')) return 'tint'
  if (name.startsWith('dimension-')) return 'graphic'
  if (name === 'terminal-bg') return 'surface'
  if (name.startsWith('bg-')) return 'surface'
  if (name === 'accent') return 'brand'
  if (name.endsWith('-fg') || name === 'on-accent' || name.startsWith('text-') || name.startsWith('terminal-')) return 'text'
  if (name.startsWith('border-') || name.endsWith('-border') || name.endsWith('-border-strong')) return 'border'
  return 'unknown'
}

/**
 * 角色矩阵（G5）：前缀 → 允许的角色
 * 豁免口径（写进矩阵而非散落注释）：
 *   surface 作 border/ring —— 用页面底色画「间隔环」（头像描边等）；
 *   text 作 border/ring —— 状态 fg 作可见描边（*-border 为 25% alpha，不承担可辨识边界）；
 *   text/border/graphic 作 bg —— ≤8px 色点、进度条、1px 分隔线的图形填充（系统无 fill 档）。
 * 未列出的前缀不参与矩阵（如 from-/via-/to- 渐变档）。
 */
const ROLE_MATRIX = {
  border: new Set(['border', 'ring', 'text', 'surface']),
  outline: new Set(['border', 'ring', 'text', 'surface']),
  divide: new Set(['border', 'ring', 'text', 'surface']),
  ring: new Set(['border', 'ring', 'text', 'surface']),
  text: new Set(['text']),
  bg: new Set(['surface', 'tint', 'brand', 'text', 'border', 'graphic']),
  fill: new Set(['surface', 'tint', 'brand', 'text', 'border', 'graphic']),
  stroke: new Set(['surface', 'tint', 'brand', 'text', 'border', 'graphic']),
}

/**
 * alpha 修饰符白名单（G4）：仅「不透明填充档」可叠加透明度
 * （bg-mcs-bg-muted/40 斑马纹、bg-mcs-accent/5 拖拽罩）。
 * 文字/边界档禁止加 alpha 修饰符；已 alpha 的 tint 档禁止二次叠加。
 */
const ALPHA_ALLOW_PREFIX = new Set(['bg', 'fill', 'stroke'])
const ALPHA_ALLOW_ROLE = new Set(['surface', 'brand'])

/** token 类三查：注册（G2）→ 角色矩阵（G5）→ alpha 白名单（G4） */
function checkTokenClasses(classes, filePath, lineNum) {
  for (const raw of classes.split(/\s+/)) {
    const parsed = parseTokenClass(raw)
    if (!parsed) continue
    const { prefix, name, alpha } = parsed

    let ok
    if (prefix === 'rounded' || prefix.startsWith('rounded-')) ok = REGISTERED.radius.has(name)
    else if (prefix === 'duration') ok = REGISTERED.duration.has(name)
    else if (prefix === 'ease') ok = REGISTERED.ease.has(name)
    else if (prefix === 'animate') ok = REGISTERED.animate.has(name)
    else if (prefix === 'shadow') ok = REGISTERED.shadow.has(name) || REGISTERED.color.has(name)
    else if (prefix === 'text') ok = REGISTERED.text.has(name) || REGISTERED.color.has(name)
    else ok = COLOR_PREFIXES.has(prefix) && REGISTERED.color.has(name)
    if (!ok) {
      console.log(`${filePath}:${lineNum + 1}: ${raw} 未在 @theme/effects 注册 → Tailwind 不生成任何规则（语义静默丢失）`)
      violations++
      continue
    }
    if (!isColorToken(prefix, name)) continue

    const role = roleOf(name)
    const allowed = ROLE_MATRIX[prefix]
    if (allowed && role !== 'unknown' && !allowed.has(role)) {
      console.log(`${filePath}:${lineNum + 1}: ${raw} 角色越界 → --mcs-${name} 是 ${role} 档，不可作 ${prefix}-（改用同族 -fg/-border 档或 border-default；角色表见本文件 ROLE_MATRIX）`)
      violations++
    }
    if (alpha !== null && !(ALPHA_ALLOW_PREFIX.has(prefix) && ALPHA_ALLOW_ROLE.has(role))) {
      console.log(`${filePath}:${lineNum + 1}: ${raw} 不可叠加 alpha → 仅不透明填充档（bg- 前缀 + surface/brand 角色）可加 /NN`)
      violations++
    }
  }
}

/**
 * text-base 的现场豁免额度（第 27 条在 G21–G27 段判定）。
 * 额度是裁定结果而非白名单：唯一来源是移动端输入控件聚焦时的 iOS 自动缩放防护——
 * 其余任何位置（含豁免文件里的第 2 处）都属体系外第 7 个字号。
 */
const TEXT_BASE_ALLOWLIST = new Map([
  ['src/components/ui/input.tsx', 1],    // 输入框：<16px 时 iOS 聚焦自动放大页面
  ['src/components/ui/textarea.tsx', 1], // 多行输入：同上
])

/** 在单条类名串中检测违规模式 */
function checkClasses(filePath, lineNum, classes) {
  // 1. dark: 前缀
  if (/\bdark:\w/.test(classes)) {
    console.log(`${filePath}:${lineNum + 1}: dark: 前缀类 → ${extractViolatingClass(classes, 'dark:')}`)
    violations++
  }
  // 2. transition-all
  if (/\btransition-all\b/.test(classes)) {
    console.log(`${filePath}:${lineNum + 1}: transition-all → 请改用具体属性如 transition-[property]`)
    violations++
  }
  // 3. duration-{纯数字}
  if (/\bduration-(\d+)\b/.test(classes)) {
    console.log(`${filePath}:${lineNum + 1}: duration-${classes.match(/\bduration-(\d+)\b/)[1]} → 请使用 duration-mcs-fast/base/slow token`)
    violations++
  }
  // 4. rounded-[ 任意值
  if (/\brounded-\[/.test(classes)) {
    console.log(`${filePath}:${lineNum + 1}: rounded-[...] 任意值 → 请使用 rounded-mcs-* token`)
    violations++
  }
  // 5. 原始色板类 (text-{color}, bg-{color}, border-{color}, ring-{color})
  for (const prefix of ['text-','bg-','border-','ring-']) {
    for (const cm of classes.matchAll(new RegExp(`\\b${prefix}([a-zA-Z][\\w-]*)`, 'g'))) {
      // 去 alpha 后缀与色阶数字（bg-red-500 → red），否则带色阶的色板类会漏检
      const colorName = cm[1].split('/')[0].replace(/-\d+$/, '')
      if (PALETTE_COLORS.has(colorName)) {
        const fullClass = prefix + cm[1]
        if (!fullClass.includes('mcs-')) {
          console.log(`${filePath}:${lineNum + 1}: ${prefix}${colorName} 原始色板类 → 请使用 --mcs-* token`)
          violations++
        }
      }
    }
  }
  // 6. bg-black（特殊情况，不含后缀）
  if (/\bbg-black\b/.test(classes)) {
    console.log(`${filePath}:${lineNum + 1}: bg-black → 请使用 --mcs-* token`)
    violations++
  }
  // 7. Tailwind 原生超大字号（3xl+）
  const oversize = classes.match(/\btext-(3xl|4xl|5xl|6xl|7xl|8xl|9xl)\b/)
  if (oversize) {
    console.log(`${filePath}:${lineNum + 1}: text-${oversize[1]} 超出字号 token 体系 → 请使用 text-mcs-* token（文字档上限 text-mcs-xl）或 text-mcs-display（配 .mcs-num）`)
    violations++
  }
  // 8. 原生的 16px text-base 由第 27 条统一判定（含 ui/ 扫描面与豁免额度），此处不报
  // 9. 焦点可见性：outline-none 会抵消同层的 focus-visible:outline-*（outline-style 恒为 none）
  if (
    /\boutline-none\b/.test(classes) &&
    /\bfocus(-visible)?:outline-(?:[2-9]|\d{2,}|mcs-|\[)/.test(classes) &&
    !/\bring-/.test(classes)
  ) {
    console.log(`${filePath}:${lineNum + 1}: outline-none 与 focus-visible:outline-* 互相抵消（焦点环不绘制）→ 删 outline-none 或补 focus-visible:ring-*`)
    violations++
  }
  // 10. 未注册 token 类 / 角色越界 / alpha 越界（语义静默丢失与对比度跌破）
  checkTokenClasses(classes, filePath, lineNum)
  // 11. 内容面 tint 不得叠加：不透明 tint 叠加无意义（后者覆盖前者），叠玻璃面同理（背景由后写者决定）
  const contentTints = classes.match(/\bbg-mcs-[\w-]+-bg-subtle\b/g)
  if (contentTints && (contentTints.length > 1 || /\bglass-(chrome|overlay|toast)\b/.test(classes))) {
    console.log(`${filePath}:${lineNum + 1}: ${contentTints.join(' + ')}${contentTints.length > 1 ? ' 内容面 tint 叠加' : ' 与玻璃面同元素'} → 同一元素只允许一个背景来源（不透明 tint 会互相覆盖）`)
    violations++
  }
}

/** 在单行中提取类名串并逐条检测（覆盖 cn(...)/模板串/对象值，不限 className= 字面属性） */
function checkLine(filePath, lineNum, line) {
  for (const literal of extractLiterals(line)) {
    if (!literal.includes('-') && !literal.includes(':')) continue
    checkClasses(filePath, lineNum, literal)
  }
}

/**
 * 一次 `cn`/`clsx` 调用的实参表（J70）：从 `(` 起按括号配平取到配对右括号，跨行；
 * 嵌套调用只取最外层（内层实参本就是外层实参的片段，重复计入会让同一处报两次）；
 * 未配平（写法异常）跳过。语义色形态的三条判定（三件套 / 选中强调 / 词表 tint 叠加）
 * 都在这张表上做，口径因此统一：**同一次调用的不同实参拆写与单串共现同判**；
 * 「先赋值再传入」的变量中转过看不见（宁漏不误报）。返回 [{ offset, end, args }]。
 */
function cnCallArgTables(code) {
  const hits = []
  const covered = (offset) => hits.some((h) => offset > h.offset && offset < h.end)
  for (const m of code.matchAll(/\b(?:cn|clsx)\(/g)) {
    if (covered(m.index)) continue
    const start = m.index + m[0].length
    let depth = 1
    let i = start
    while (i < code.length && depth > 0) {
      if (code[i] === '(') depth++
      else if (code[i] === ')') depth--
      i++
    }
    if (depth > 0) continue
    hits.push({ offset: m.index, end: i, args: code.slice(start, i - 1) })
  }
  return hits
}

/** 字面量的整词集合（'a b' → {a,b}）；形态判定一律整词比对，不做子串包含 */
function literalTokens(literal) {
  return new Set(literal.slice(1, -1).split(/\s+/).filter(Boolean))
}

/** 实参表里所有字面量的词集合（含嵌套 cn/clsx 与数组/对象实参里的字面量） */
function argTokens(args) {
  const tokens = new Set()
  for (const m of args.matchAll(STRING_LITERAL)) for (const t of literalTokens(m[0])) tokens.add(t)
  return tokens
}

/**
 * 内容面 tint 叠加（词表侧）：`toneClasses()` / `SEMANTIC_TONE_CLASSES[...].bg` 的产出也是
 * 内容面 tint，与字面量 tint 落在同一处着色（同一次 cn/clsx 调用，或同一个模板串）即叠加。
 * 逐行数字面量的那条看不见这种间接写法，而语义色收归词表后恰是常见形态。
 * 返回 [{ offset, end }]。
 */
function findToneTintOverlaps(content) {
  const code = stripComments(content)
  // 80 是属性访问写法（SEMANTIC_TONE_CLASSES[tone].bg）的向后搜索窗口，现网最长约 40 字符
  const TINT_SOURCE = /toneClasses\(|SEMANTIC_TONE_CLASSES[\s\S]{0,80}?\.bg\b/
  const TINT_LITERAL = /bg-mcs-[\w-]+-bg-subtle/
  const hits = []

  for (const call of cnCallArgTables(code)) {
    if (TINT_SOURCE.test(call.args) && TINT_LITERAL.test(call.args)) hits.push({ offset: call.offset, end: call.end })
  }

  // 模板串：同一个串里两种来源并存（cn 之外的常见写法）；已被 cn 命中区间包住的不重复计数
  for (const m of code.matchAll(/`(?:[^`\\]|\\.)*`/g)) {
    const end = m.index + m[0].length
    const insideCall = hits.some((h) => m.index > h.offset && m.index < h.end)
    const wrapsCall = hits.some((h) => m.index <= h.offset && end >= h.end)
    if (insideCall || wrapsCall) continue
    if (TINT_SOURCE.test(m[0]) && TINT_LITERAL.test(m[0])) hits.push({ offset: m.index, end })
  }
  return hits
}

/**
 * 六档语义色的「静态三件套」声明源只有 mcs/tone.ts。
 * 判定面＝一次 cn/clsx 调用的实参表 ∪ 单个字面量：三件套拆到同一次调用的不同实参里同样算
 * 手写（J70 扩面），拆到不同调用、不同元素上则看不见（宁漏不误报）。
 * 按空白切词做**整词**比对（不用子串包含）：`border-mcs-accent-border-strong` 是另一档
 * 描边（选中强调，由下面 findHandwrittenSelectedShapes 单独判定）、`hover:bg-mcs-*-bg-subtle`
 * 是交互覆盖层而非内容面 tint，两者都不算手写三件套，不能被误报。
 */
const TONE_TRIAD_NAMES = ['accent', 'success', 'warning', 'error', 'info', 'purple']

/** 三件套命中（整词）：返回档名或 undefined */
function triadToneOf(tokens) {
  return TONE_TRIAD_NAMES.find(
    (t) =>
      tokens.has(`border-mcs-${t}-border`) &&
      tokens.has(`bg-mcs-${t}-bg-subtle`) &&
      tokens.has(`text-mcs-${t}-fg`),
  )
}

function findHandwrittenToneTriads(content) {
  const code = stripComments(content)
  const hits = []
  const inside = (offset) => hits.some((h) => offset > h.offset && offset < (h.end ?? h.offset + 1))
  for (const call of cnCallArgTables(code)) {
    const tone = triadToneOf(argTokens(call.args))
    if (tone) hits.push({ offset: call.offset, end: call.end, tone })
  }
  for (const m of code.matchAll(STRING_LITERAL)) {
    if (inside(m.index)) continue
    const tone = triadToneOf(literalTokens(m[0]))
    if (tone) hits.push({ offset: m.index, tone })
  }
  return hits
}

/**
 * 选中强调形态（J57）：`border-mcs-accent-border-strong` 与 `bg-mcs-accent-bg-subtle`
 * 同处共现（同一次 cn/clsx 调用的实参表，或单个字面量）即为手写选中态。词表的两个形状都由
 * 这两个 token 构成——三件套 `TONE_SELECTED_CLASSES` 与两件套容器
 * `TONE_SELECTED_SURFACE_CLASSES`（后者把前景留给子元素），故一条判定同时覆盖两种现场；
 * 声明源只有 components/mcs/tone.ts。
 * 仍是**整词**比对：`border-mcs-accent-border`（弱档）是普通内容面描边，
 * 与强档语义不同，不能被子串包含误收。
 * 只有 accent 有「内容面强档」token：`--mcs-error-border-strong` 虽存在，
 * 但仅 components/ui/button 危险变体使用，而 components/ui 在 walkDir 扫描范围外。
 */
const SELECTED_SHAPE_TOKENS = ['border-mcs-accent-border-strong', 'bg-mcs-accent-bg-subtle']

function findHandwrittenSelectedShapes(content) {
  const code = stripComments(content)
  const hits = []
  const inside = (offset) => hits.some((h) => offset > h.offset && offset < (h.end ?? h.offset + 1))
  const isShape = (tokens) => SELECTED_SHAPE_TOKENS.every((t) => tokens.has(t))
  for (const call of cnCallArgTables(code)) {
    if (isShape(argTokens(call.args))) hits.push({ offset: call.offset, end: call.end })
  }
  for (const m of code.matchAll(STRING_LITERAL)) {
    if (inside(m.index)) continue
    if (isShape(literalTokens(m[0]))) hits.push({ offset: m.index })
  }
  return hits
}

function extractViolatingClass(classes, prefix) {
  const parts = classes.split(' ')
  const found = parts.find(c => c.startsWith(prefix))
  return found || prefix + '...'
}

/** 递归遍历 src/ 目录（排除 ui/） */
function walkDir(dir) {
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.name === 'node_modules' || entry.name === '.next') continue
    if (entry.isDirectory()) {
      walkDir(fullPath)
      continue
    }
    if (!['.tsx','.ts','.jsx','.js'].includes(extname(entry.name))) continue
    // 排除 shadcn UI 组件（路径分隔符归一为正斜杠，兼容 Windows join 产生的反斜杠）
    if (fullPath.replace(/\\/g, '/').includes(EXCLUDE_DIR)) continue

    const relPath = relative(root, fullPath)
    const content = readFileSync(fullPath, 'utf-8')
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      checkLine(relPath, i, lines[i])
    }
    // 11b/11c：跨行判定，故在文件层做（逐行版只看得到字面量）
    const rel = relPath.split(sep).join('/')
    for (const hit of findToneTintOverlaps(content)) {
      const lineNum = content.slice(0, hit.offset).split('\n').length
      console.log(`${relPath}:${lineNum}: 词表 tint（toneClasses/SEMANTIC_TONE_CLASSES）× 字面量 tint 同元素 → 同一元素只允许一个背景来源`)
      violations++
    }
    // 词表自身（它就是声明源）与测试（用例按定义就该断言类名三元组）除外
    if (!rel.endsWith('components/mcs/tone.ts') && !rel.includes('__tests__')) {
      const triadHits = findHandwrittenToneTriads(content)
      for (const hit of triadHits) {
        const lineNum = content.slice(0, hit.offset).split('\n').length
        console.log(`${relPath}:${lineNum}: 手写 ${hit.tone} 档三件套（border+bg-subtle+fg）→ 语义色声明源只有 components/mcs/tone.ts`)
        violations++
      }
      // 同一字面量里弱档、强档都写了时两条规则会各命中一次，只报三件套那条（同处不重复计数）
      const reported = new Set(triadHits.map((h) => h.offset))
      for (const hit of findHandwrittenSelectedShapes(content)) {
        if (reported.has(hit.offset)) continue
        const lineNum = content.slice(0, hit.offset).split('\n').length
        console.log(`${relPath}:${lineNum}: 手写 accent 选中强调形态（border-strong+bg-subtle）→ 声明源只有 components/mcs/tone.ts 的 TONE_SELECTED_* 常量`)
        violations++
      }
    }
  }
}

walkDir(srcDir)

// ── G9：未定义类 / 死类 / 死 token 双向检查 ─────────────────────
// 消费口径：token 存活 = ① 定义层/注册层之外出现 `--mcs-x` 字面量（含 cssVar('--mcs-x')），
//           或 ② 由 index.css 注册派生的工具类在源码被使用。
// 与逐行检查的区别：本段**不排除** src/components/ui/——基座里的失效类同样是缺陷
// （`--ease-mcs-spring` 曾在 ui/dialog.tsx 静默失效即因此逃检）。
/** 注册名 → 生成的工具类（如 color-mcs-bg-default → bg-mcs-bg-default/text-mcs-bg-default/…） */
const UTILITY_COLOR_PREFIXES = ['bg', 'text', 'border', 'ring', 'outline', 'fill', 'stroke', 'divide', 'decoration', 'caret', 'from', 'via', 'to']
const UTILITY_RADIUS_PREFIXES = ['rounded', 'rounded-t', 'rounded-b', 'rounded-l', 'rounded-r', 'rounded-tl', 'rounded-tr', 'rounded-bl', 'rounded-br', 'rounded-s', 'rounded-e', 'rounded-ss', 'rounded-se', 'rounded-es', 'rounded-ee']
function utilitiesOfRegistration(reg) {
  if (reg.startsWith('color-')) { const n = reg.slice(6); return UTILITY_COLOR_PREFIXES.map((p) => `${p}-${n}`) }
  if (reg.startsWith('radius-')) { const n = reg.slice(7); return UTILITY_RADIUS_PREFIXES.map((p) => `${p}-${n}`) }
  for (const [kind, prefix] of [['text-', 'text-'], ['duration-', 'duration-'], ['ease-', 'ease-'], ['shadow-', 'shadow-'], ['font-', 'font-'], ['animate-', 'animate-'], ['leading-', 'leading-'], ['tracking-', 'tracking-'], ['blur-', 'blur-']]) {
    if (reg.startsWith(kind)) return [`${prefix}${reg.slice(kind.length)}`]
  }
  return []
}

/** 收集 G9 扫描文件（含 ui/ 与 e2e/） */
function collectG9Files() {
  const out = []
  const walkAll = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { walkAll(full); continue }
      if (!['.tsx', '.ts', '.jsx', '.js', '.css'].includes(extname(entry.name))) continue
      out.push(full)
    }
  }
  walkAll(srcDir)
  const e2eDir = join(root, 'e2e')
  if (existsSync(e2eDir)) walkAll(e2eDir)
  return out
}

const G9_FILES = collectG9Files()
const semanticPath = join(srcDir, 'styles', 'tokens', 'semantic.css')
const indexPath = join(srcDir, 'index.css')

// 注册表：注册名 → token，及 token → 派生工具类
const tokenUtilities = new Map()
const registeredUtilities = new Set()
// Tailwind preflight 直接消费的注册名（作 html 默认字体，无类名），不算死 token
const IMPLICIT_CONSUMED_REGS = new Set(['font-sans'])
const implicitConsumedTokens = new Set()
for (const cssFile of [indexPath]) {
  for (const m of readFileSync(cssFile, 'utf-8').matchAll(/--([\w-]+)\s*:\s*var\((--mcs-[\w-]+)\)/g)) {
    const [, reg, token] = m
    const us = utilitiesOfRegistration(reg)
    for (const u of us) registeredUtilities.add(u)
    if (IMPLICIT_CONSUMED_REGS.has(reg)) implicitConsumedTokens.add(token)
    if (!tokenUtilities.has(token)) tokenUtilities.set(token, new Set())
    for (const u of us) tokenUtilities.get(token).add(u)
  }
}

// 项目 CSS 定义的自定义类（.mcs-* / .glass-* / .animate-mcs-*）
const definedClasses = new Map() // class → { file, line }
for (const f of G9_FILES) {
  if (!f.endsWith('.css')) continue
  const lines = readFileSync(f, 'utf-8').split('\n')
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/\.((?:mcs|glass|animate-mcs)-[\w-]+)/g)) {
      if (!definedClasses.has(m[1])) definedClasses.set(m[1], { file: relative(root, f), line: i, reserved: line.includes('@reserved') || (lines[i - 1] ?? '').includes('@reserved') })
    }
  })
}

// 源码类名（严格形状）
// classContext：该字面量所在行是否像类名上下文（className/cn/cva/clsx）——
// 用于把「形如 mcs-x 的存储键/事件名/测试夹具」与真正的裸类名区分开
// 测试文件（__tests__）不进消费面：它按定义就要写出待断言的类名，且断言把档名拼进模板串
// （`text-mcs-${tone}-fg`）会登记成通配前缀——曾让 text-mcs-*/bg-mcs-*/border-mcs-* 整族
// 恒判为「已消费」，第 14 条死 token 门禁对这族完全失效。测试要判定的产物是运行时代码的
// 消费面，测试自身不构成消费点。
// usedPrefixes 是「模板串动态拼接类名」的前缀面（`mcs-delay-${i}` 一类）：现网仅剩 `instance-cards.tsx`
// 的 `mcs-delay-${i}` 一处真实动态拼法（测试里的 `text-mcs-${…}` 已由 `__tests__` 排除）。
const CLASS_CONTEXT = /className|class=|\bcn\(|\bcva\(|\bclsx\(/
const usedClasses = new Map() // class → { file, classContext }
const usedPrefixes = new Set()
for (const f of G9_FILES) {
  if (f.endsWith('.css') || f.includes('__tests__')) continue
  const relFile = relative(root, f)
  for (const line of readFileSync(f, 'utf-8').split('\n')) {
    const classContext = CLASS_CONTEXT.test(line)
    for (const lit of line.matchAll(/(["'`])([^"'`\n]*)\1/g)) {
      for (const raw of lit[2].split(/\s+/)) {
        const body = raw.replace(/^.*:/, '').replace(/!$/, '').replace(/\/[\d[\].]+$/, '')
        if (!body) continue
        const dyn = body.match(/^((?:mcs|glass|animate-mcs|[a-z-]*-mcs)-[a-z0-9-]*)\$\{/)
        if (dyn) { usedPrefixes.add(dyn[1]); continue }
        if (!/^(?:[a-z-]*-)?(?:mcs|glass)-[a-z0-9-]+$/.test(body)) continue
        const info = usedClasses.get(body)
        if (!info) usedClasses.set(body, { file: relFile, classContext })
        else if (classContext) info.classContext = true
      }
    }
  }
}
const isUsed = (cls) => usedClasses.has(cls) || [...usedPrefixes].some((p) => cls.startsWith(p))

// 12. 未定义类（含 ui/）：既未定义也未注册 → Tailwind 静默不生成
for (const [cls, info] of usedClasses) {
  if (definedClasses.has(cls) || registeredUtilities.has(cls)) continue
  if (/^[a-z-]+-mcs-/.test(cls)) {
    // 非 ui/ 的 *-mcs-* 工具类已由逐行检查（G2）覆盖，避免重复报
    if (!info.file.replace(/\\/g, '/').includes(EXCLUDE_DIR)) continue
  } else if (!info.classContext) {
    // 裸 mcs-*/glass-* 标识符（localStorage 键、事件名、测试夹具）不是类名，不进判定
    continue
  }
  console.log(`${info.file}: ${cls} 未定义/未注册 → 项目 CSS 无此选择器且 @theme 无此注册，类名静默无效果`)
  violations++
}
for (const p of usedPrefixes) {
  if ([...definedClasses.keys(), ...registeredUtilities].some((c) => c.startsWith(p))) continue
  console.log(`动态类名前缀 ${p}${'${…}'} 无任何定义/注册 → 模板串拼出的类名静默无效果`)
  violations++
}

// 13. 死类：项目 CSS 定义但 0 使用（@reserved 豁免）
const deadClasses = [...definedClasses.entries()].filter(([cls, info]) => !info.reserved && !isUsed(cls))
for (const [cls, info] of deadClasses) {
  console.log(`${info.file}:${info.line + 1}: ${cls} 定义但全仓 0 使用 → 删除或加 @reserved 注释说明预留原因`)
  violations++
}

// 14. 死 token：semantic.css 定义但 0 消费 → 报错（@reserved 是唯一豁免口径）
const semanticLines = readFileSync(semanticPath, 'utf-8').split('\n')
const tokenNames = [...new Set([...semanticLines.join('\n').matchAll(/(--mcs-[\w-]+)\s*:/g)].map((m) => m[1]))]
// 定义层/注册层之外的全文（用于 ① 字面量引用判定）
// index.css 只剔除 @theme 注册行，保留 base 层的真实消费（如 line-height: var(--mcs-line-height-body)）
const REGISTRATION_LINE = /^\s*--[\w-]+\s*:\s*var\(--mcs-[\w-]+\);\s*$/gm
let outsideText = ''
for (const f of G9_FILES) {
  if (f === semanticPath) continue
  const text = readFileSync(f, 'utf-8')
  outsideText += (f === indexPath ? text.replace(REGISTRATION_LINE, '') : text) + '\n'
}
const deadTokens = []
for (const token of tokenNames) {
  const defLine = semanticLines.findIndex((l) => l.includes(`${token}:`))
  const reserved = defLine >= 0 && (semanticLines[defLine].includes('@reserved') || (semanticLines[defLine - 1] ?? '').includes('@reserved'))
  if (reserved || implicitConsumedTokens.has(token)) continue
  const literalRef = outsideText.includes(token)
  const classRef = [...(tokenUtilities.get(token) ?? [])].some(isUsed)
  if (!literalRef && !classRef) deadTokens.push(token)
}
if (deadTokens.length > 0) {
  console.log(`\n✗ 死 token ${deadTokens.length} 个（semantic.css 定义但全仓 0 消费）→ 删除，或加 @reserved 注释说明预留原因：`)
  for (const t of deadTokens) console.log(`   ${t}`)
  violations += deadTokens.length
}

// 16. Z 轴阶梯：禁裸 z-<数字>（须走 z-(--mcs-z-*) 语义阶梯，否则靠 DOM 顺序决胜）
//     覆盖：类名（含 -z- 负值、z-[n]）、内联 style 的 zIndex、CSS 的 z-index（注释行剥除）
const RAW_Z = /^-?z-(?:\d+|\[\d+\])$/
const Z_HINT = 'z-(--mcs-z-{local|overlay|modal|dropdown|tooltip|toast})'
/** 剥掉单行块注释，并跳过整行注释（避免注释里的示例被当成违规） */
function codeOnly(line) {
  const out = line.replace(/\/\*.*?\*\//g, '')
  return /^\s*(\/\/|\*)/.test(out) ? '' : out
}
for (const f of G9_FILES) {
  const lines = readFileSync(f, 'utf-8').split('\n')
  if (f.endsWith('.css')) {
    lines.forEach((line, i) => {
      if (/z-index:\s*\d+/.test(codeOnly(line))) {
        console.log(`${relative(root, f)}:${i + 1}: 裸 z-index 数值 → 改用 var(--mcs-z-*)`)
        violations++
      }
    })
    continue
  }
  lines.forEach((line, i) => {
    const code = codeOnly(line)
    if (!code) return
    if (/zIndex:\s*\d+/.test(code)) {
      console.log(`${relative(root, f)}:${i + 1}: 内联 zIndex 数值 → 改用 var(--mcs-z-*)`)
      violations++
    }
    for (const lit of code.matchAll(/(["'`])([^"'`\n]*)\1/g)) {
      for (const raw of lit[2].split(/\s+/)) {
        const body = raw.replace(/^.*:/, '').replace(/!$/, '')
        if (RAW_Z.test(body)) {
          console.log(`${relative(root, f)}:${i + 1}: ${body} 裸 z 轴数值 → 改用 ${Z_HINT}`)
          violations++
        }
      }
    }
  })
}

// 17. 玻璃预算：全站各 1 处（顶栏 chrome + 覆盖层 overlay）——「同屏 ≤2 层」的静态口径，
//     运行时同屏无法静态判定，故收紧为「全站各 1 处」，见 src/styles/glass.css
//     计数口径：非注释的类名引用次数（.ts/.tsx 均计，跳过 __tests__ 与 .css）
const GLASS_BUDGET = { chrome: 1, overlay: 1, toast: 0 }
const glassCount = new Map()
for (const f of G9_FILES) {
  if (f.endsWith('.css') || f.includes('__tests__')) continue
  for (const line of readFileSync(f, 'utf-8').split('\n')) {
    const code = codeOnly(line)
    if (!code) continue
    for (const m of code.matchAll(/\bglass-(chrome|overlay|toast)\b/g)) {
      glassCount.set(m[1], (glassCount.get(m[1]) ?? 0) + 1)
    }
  }
}
for (const [kind, count] of glassCount) {
  const budget = GLASS_BUDGET[kind] ?? 0
  if (count > budget) {
    console.log(`玻璃预算超标：glass-${kind} ${count} 处（预算 ${budget}）→ 预算说明见 src/styles/glass.css`)
    violations += count - budget
  }
}

// 18. 危险语义色禁止半透明底：bg-destructive/NN 与 bg-destructive/[N] 承载文字，暗色最亮面上 3.39–4.44:1
for (const f of G9_FILES) {
  if (f.endsWith('.css')) continue
  const lines = readFileSync(f, 'utf-8').split('\n')
  lines.forEach((line, i) => {
    if (/\bbg-destructive\/(?:[\d.]+|\[[\d.]+\])/.test(codeOnly(line))) {
      console.log(`${relative(root, f)}:${i + 1}: bg-destructive/<alpha> 半透明危险底 → 改用不透明 bg-mcs-error-bg-subtle + border-mcs-error-border-strong`)
      violations++
    }
  })
}

// 19. 内容面 tint 必须不透明：--mcs-*-bg-subtle 承载文字/图标，半透明会随宿主面漂移
//     判定用「含 alpha 语法」黑名单（transparent / rgba / hsla / 8 位 hex / oklch 斜杠 alpha）
const hasAlphaSyntax = (value) =>
  /\btransparent\b|\brgba?\(|\bhsla?\(|#[0-9a-fA-F]{8}\b|\/\s*[\d.]+%?\s*\)/.test(value)
for (const [i, line] of semanticLines.entries()) {
  const m = line.match(/(--mcs-[\w-]+-bg-subtle)\s*:\s*([^;]+);/)
  if (m && hasAlphaSyntax(m[2])) {
    console.log(`${relative(root, semanticPath)}:${i + 1}: ${m[1]} 含半透明值 → 内容面 tint 必须不透明（color-mix(色 N%, 基面)）`)
    violations++
  }
}

// 20. 布局属性动画与数字时长档（仅 ui/ 基座：非 ui/ 已由第 3/4 条逐行覆盖，此处不重复报）
//     transition-all 会连带 width/height/margin 逐帧重排；时长一律走 --mcs-motion-*（fast 150 / base 300）
for (const f of G9_FILES) {
  if (!f.replace(/\\/g, '/').includes(EXCLUDE_DIR)) continue
  const lines = readFileSync(f, 'utf-8').split('\n')
  lines.forEach((line, i) => {
    const code = codeOnly(line)
    if (!code) return
    for (const lit of code.matchAll(/(["'`])([^"'`\n]*)\1/g)) {
      for (const raw of lit[2].split(/\s+/)) {
        const body = raw.replace(/^.*:/, '').replace(/!$/, '')
        if (body === 'transition-all') {
          console.log(`${relative(root, f)}:${i + 1}: transition-all → 改用 transition / transition-colors（避免布局属性参与过渡）`)
          violations++
        } else if (/^duration-\d+$/.test(body)) {
          console.log(`${relative(root, f)}:${i + 1}: ${body} 数字时长档 → 改用 duration-mcs-fast/base/slow`)
          violations++
        }
      }
    }
  })
}

// ── G21–G27（J23 门禁 + t27 第 27 条）：src/ 全量静态防线 ────────────────────────
// 前 20 条按各自的扫描集（逐行 1–11 排除 ui/；12–20 含 ui/ 与 e2e/），这些条统一扫 src/ 全量。
const GATE_FILES = G9_FILES.filter((f) => f.startsWith(srcDir))
const GATE_REL = (f) => relative(root, f).split(sep).join('/')
/** 用例按定义就要断言类名/文案（同 11b/11c 的豁免口径），不进判定面 */
const isTestFile = (f) => f.includes('__tests__')

// 27. 原生 text-base（16px，体系外第 7 个字号）：唯一豁免现场是移动端输入控件。
//     扫描面含 ui/（豁免现场就在 ui/，逐行检查排除它），故用不含排除项的 G9_FILES；
//     额度按现场登记（同第 21 条卡片面额度口径）——每个豁免文件放行前 N 处、第 N+1 处
//     即报，未登记文件一处即报。采集口径见 lib/design-token-rules.mjs。
for (const f of G9_FILES) {
  if (f.endsWith('.css') || isTestFile(f)) continue
  const rel = GATE_REL(f)
  const budget = TEXT_BASE_ALLOWLIST.get(rel) ?? 0
  for (const hit of overQuota(collectTextBaseHits(readFileSync(f, 'utf-8')), budget)) {
    console.log(`${rel}:${hit.line}: text-base 是体系外第 7 个字号（16px）→ 改用 text-mcs-*；仅移动端输入控件可豁免（ui/input、ui/textarea 各 1 处，额度见本文件 TEXT_BASE_ALLOWLIST）`)
    violations++
  }
}

// 21. 卡片面类名只在 components/mcs/card.tsx 声明：配方 = rounded-mcs-md + border-mcs-border-muted
//     + bg-mcs-bg-muted + shadow-mcs-card，以 `shadow-mcs-card`（卡阴影无第二用途）为判定标记；
//     非卡片面但共用该标记的现场按「登记额度」豁免——额度外的第 N 处即报（豁免的是现场，不豁免
//     整个文件）。额度是裁定结果而非白名单：7 处里只有「同配方」与「仅共用卡阴影」两种来源，
//     逐条理由见下表；新写一处卡面会被额度拒收，不因同文件已豁免而放过。
const CARD_DECLARATION_SOURCE = 'src/components/mcs/card.tsx'
const CARD_SURFACE_ALLOWLIST = new Map([
  ['src/components/mcs/empty-state.tsx', 1],                    // 空态插画底座：ring-1 ring-mcs-border-muted 代 border，非卡片面配方
  ['src/layouts/app-sidebar.tsx', 1],                           // 侧栏实例摘要条：导航区部件，不是页面内容卡片
  ['src/features/dashboard/components/server-terminal.tsx', 1], // 终端深底面：底色走 --mcs-terminal-*（主题无关），无卡底色
  ['src/features/instances/components/instance-cards.tsx', 1],  // 卡内数值栅格：rounded-mcs-sm + bg-mcs-bg-default，档位不同
  ['src/features/settings/settings-page.tsx', 1],               // 设置页子导航轨道：侧向导航，不是内容卡片
  ['src/features/tasks/components/cron-editor.tsx', 1],         // 表单内嵌块 p-2（非内容分组）
  ['src/features/tasks/components/task-dialog.tsx', 1],         // 表单内嵌块 p-2（同上）
])
for (const f of GATE_FILES) {
  if (f.endsWith('.css') || isTestFile(f)) continue
  const rel = GATE_REL(f)
  if (rel === CARD_DECLARATION_SOURCE) continue
  const code = stripComments(readFileSync(f, 'utf-8'))
  for (const offset of overQuota(collectCardSurfaceOffsets(code), CARD_SURFACE_ALLOWLIST.get(rel))) {
    console.log(`${rel}:${lineAt(code, offset)}: 卡片面类名配方（shadow-mcs-card）→ 卡片面只在 components/mcs/card.tsx 声明（AGENTS.md「卡片容器」）；非卡片面的同配方现场须登记豁免额度`)
    violations++
  }
}

// 22. 标签组件唯一性：只读状态 = StatusPill、可交互/通用 = Chip、计数 = CountBadge，
//     禁第四套标签组件。三条判定面：①除三件基座外新导出 Badge/Pill/Tag 命名的组件或精确的
//     Chip；②引用已删除的 shadcn ui/badge（模块路径或 `<Badge` 用法，`\b` 保证不误收图标
//     `BadgeCheck`）；③ui/badge.tsx 文件本身被重建（零引用也算重蹈覆辙）。
//     `*Chip` 不判：本仓它是领域复合部件名（如快捷传送点 QuickChip：双行内容 + 编辑/删除
//     按钮，不是标签胶囊）。行内胶囊着色点（通知未读浮标、状态点、更新按钮）形状各异且多为
//     局部叠加，静态判定会误报，不判。
const LABEL_COMPONENT_SOURCES = new Set([
  'src/components/mcs/chip.tsx',
  'src/components/mcs/status-pill.tsx',
  'src/components/mcs/count-badge.tsx',
])
const LABEL_COMPONENT_DECL = /export\s+(?:function|const)\s+([A-Z]\w*(?:Badge|Pill|Tag)|Chip)\b/g
const BADGE_MODULE_REF = /(?:components\/ui\/badge|@\/components\/badge)\b|<Badge\b/g
const RETIRED_BADGE_FILE = join(srcDir, 'components', 'ui', 'badge.tsx')
if (existsSync(RETIRED_BADGE_FILE)) {
  console.log(`${GATE_REL(RETIRED_BADGE_FILE)}: 已删除的 shadcn badge 基座被重建 → 状态标签走 StatusPill / Chip / CountBadge`)
  violations++
}
for (const f of GATE_FILES) {
  if (f.endsWith('.css') || isTestFile(f)) continue
  const rel = GATE_REL(f)
  const code = stripComments(readFileSync(f, 'utf-8'))
  if (!LABEL_COMPONENT_SOURCES.has(rel)) {
    for (const m of code.matchAll(LABEL_COMPONENT_DECL)) {
      console.log(`${rel}:${lineAt(code, m.index)}: 新导出标签组件 ${m[1]} → 标签只有 Chip / StatusPill / CountBadge 三件（AGENTS.md「标签与状态展示」）`)
      violations++
    }
  }
  for (const m of code.matchAll(BADGE_MODULE_REF)) {
    console.log(`${rel}:${lineAt(code, m.index)}: 引用已删除的 badge 基座 → 状态标签走 StatusPill / Chip / CountBadge`)
    violations++
  }
}

// 23. 页面页头：AppShell 主页面必须有且仅有一个 PageHeader（页头是页面级唯一标题声明点），
//     且该页标题字号档 ≤3——口径＝页头基座 + 卡片标题基座 + 该页自己的标题标签显式档。
//     已知取舍：不辨识互斥渲染。设置页 6 个路由子页合计恰好 3 档、正贴上限，
//     将来任一子面板再加一档就会静默越界（静态近似看不见「同时只渲染其一」）。
//     判定面＝该页**实际渲染出的标题组件**（静态近似）：页文件 + 其直接引用的页内模块
//     （覆盖「页 → 卡片组件 → mcs/card 基座」这类标题都在子组件里的现场；再深一层会把
//     无关模块的标题算进同屏，宁漏不误报）。档位来源两类：
//       ① 标题标签（h1–h6）行的 text-mcs-*——同行判定，类名换行写看不见；
//       ② `<*Title/*Header>` 用法的基座档——从组件声明所在文件的组件体内读（体内承载标题的
//          元素的首个 text-mcs-*），不硬编码档名，基座换档时本条自动跟随。
//     同文件里的正文、角标、数字档不进判定面：KPI 数字档（lg/display）不是标题档，
//     收进来会把数字面板误判成「标题档位发散」。
//     标题组件的角色轴（`CardTitle` 的 heading/label）按**调用点**分类：基座文件声明
//     角色→档位的表（`const X = { role: 'text-mcs-xx' } as const`），元素行只写 `X[variant]`，
//     调用点上的字面量 `variant="..."` 选档、缺省时走参数默认角色——同一组件在不同页面上
//     可能落进不同档，故档位不能只按组件名记一个值。档位仍不硬编码：改基座的角色表即改口径。
//     边界（宁漏不误报）：variant 非字面量（表达式/跨行写）按**缺省角色**计档——调用点实际角色
//     静态不可判，按缺省角色落档；未登记角色不计档；
//     字面量的单双引号写法（`variant="label"` / `variant='label'`）语义相同，都按字面量计档
//     （只认双引号会把单引号调用点误判成缺省角色、静默丢掉另一档）；
//     基座元素行读不出档（如只有色类、无字号档的 SheetTitle/DialogTitle 一类）同样不计档。
//     登录页/引导页是全屏品牌入口，不在 AppShell 内、标题由自身 h1 承担，显式豁免。
//     引导页同屏的第二个标题（连接表单的「连接你的服务器」）由 ConnectionForm 的
//     `headingAs` 调用点参数降为 h2 —— 页面级唯一 h1 是硬约束，豁免的是「必须有 PageHeader」
//     这一条，不是「可以有多个 h1」。基座默认仍是 h1（设置子页里它就是该页主标题）。
//     边界：全站 AppShell 页的主标题是 PageHeader 渲染的 h2，页面级唯一 h1 这条只约束
//     品牌入口页（登录 / 引导）自己的 h1，不是「全站每页都要有一个 h1」。
//     档位采集（角色档位表解析、调用点取档）见 lib/design-token-rules.mjs。
const APP_SHELL_PAGE_EXEMPT = new Set([
  'src/features/auth/login-page.tsx',
  'src/features/onboarding/onboarding-page.tsx',
])
/** 页内模块路径（`@/x` 走 src/，相对路径按引用文件所在目录解析）；外部包与测试返回 null */
function resolveLocalModule(fromFile, spec) {
  const base = spec.startsWith('@/')
    ? join(srcDir, spec.slice(2))
    : spec.startsWith('.')
      ? join(fromFile, '..', spec)
      : null
  if (!base) return null
  for (const candidate of [`${base}.tsx`, `${base}.ts`, join(base, 'index.tsx')]) {
    if (existsSync(candidate) && !isTestFile(candidate)) return candidate
  }
  return null
}
/** 该文件引用的页内模块 */
function localImportsOf(code, fromFile) {
  const out = []
  for (const m of code.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    const resolved = resolveLocalModule(fromFile, m[1])
    if (resolved) out.push(resolved)
  }
  return out
}
for (const f of GATE_FILES) {
  if (f.endsWith('.css') || isTestFile(f)) continue
  const rel = GATE_REL(f)
  if (!/-page\.tsx$/.test(rel) || APP_SHELL_PAGE_EXEMPT.has(rel)) continue
  const code = stripComments(readFileSync(f, 'utf-8'))
  const headerCount = [...code.matchAll(/<PageHeader\b/g)].length
  if (headerCount !== 1) {
    console.log(`${rel}: 页面必须有且仅一个 PageHeader（当前 ${headerCount} 个）→ 标题与描述只在页头声明`)
    violations++
  }
  // 判定面：页文件 + 其直接引用的页内模块
  const scoped = [f]
  for (const imported of localImportsOf(code, f)) scoped.push(imported)
  const moduleCodes = new Map(scoped.map((p) => [p, p === f ? code : stripComments(readFileSync(p, 'utf-8'))]))
  // 基座名表：判定面内的标题组件声明 + 这些模块再引用的基座（`<CardTitle>` 的档在 mcs/card）
  for (const p of [...scoped, ...scoped.flatMap((m) => localImportsOf(moduleCodes.get(m), m))]) {
    if (!moduleCodes.has(p)) moduleCodes.set(p, stripComments(readFileSync(p, 'utf-8')))
  }
  const tiers = collectHeadingTiers(
    scoped.map((p) => moduleCodes.get(p)),
    moduleCodes.values(),
  )
  if (tiers.size > 3) {
    console.log(`${rel}: 页内标题字号档 ${tiers.size} 档（${[...tiers].sort().join('/')}）→ 同屏标题最多 3 档`)
    violations++
  }
}

// 24. 全屏覆盖层必须来自 ui/sheet 或 ui/dialog：modal 档（z-modal）的全屏容器（fixed/inset-0）
//     或 aside 不得在 feature/layout 里裸搭。overlay 档（抽屉背板、移动端全屏编辑器）是遮罩与
//     局部覆盖、不承担弹窗语义，不在判定面；同行判定，跨行写法看不见（宁漏不误报）。
const OVERLAY_SOURCES = new Set(['src/components/ui/sheet.tsx', 'src/components/ui/dialog.tsx'])
for (const f of GATE_FILES) {
  if (f.endsWith('.css')) continue
  const rel = GATE_REL(f)
  if (OVERLAY_SOURCES.has(rel)) continue
  readFileSync(f, 'utf-8').split('\n').forEach((line, i) => {
    const code = codeOnly(line)
    if (!code) return
    if (
      /z-\(--mcs-z-modal\)/.test(code) &&
      (/fixed/.test(code) || /inset-0/.test(code) || /<aside\b/.test(code))
    ) {
      console.log(`${rel}:${i + 1}: 裸 z-modal 全屏覆盖层 → 全屏面板走 ui/sheet / ui/dialog`)
      violations++
    }
  })
}

// 25. 行内 onKeyDown 抢键：对空格/回车调 preventDefault 的处理器必须先判落点
//     （`e.target !== e.currentTarget` 等），否则容器会吞掉行内控件自己的激活键——
//     落点写在 preventDefault 的最近外层 if 条件里，故按「preventDefault 的分支条件」判定，
//     同一次处理器里另有按键分支不误伤（如输入框只对方向键 preventDefault）。
//     宿主是 input/textarea 时其 Space/Enter 默认行为属控件自身（无冒泡抢键面），不判；
//     `onKeyDown={handleKeyDown}` 这类具名引用不在「行内」判定面。
const KEYBOARD_HOST_EXEMPT = /^<(?:input|textarea|Input|Textarea|Select|Combobox)\b/
const SPACE_ENTER_KEY = /(?:^|[^\w])(?:Enter|Space|Spacebar)(?:[^\w]|$)|['"`] ['"`]/
/** preventDefault 的最近外层 if 条件里出现空格/回车键名 → 该次拦截属抢键
 *  （`if (...) {` 与单语句 `if (...) ` 两种写法都认；`e.` 接收者前缀不算条件内容） */
function interceptsSpaceOrEnter(body) {
  for (const m of body.matchAll(/preventDefault\s*\(/g)) {
    const before = body.slice(0, m.index)
    const cond = /if\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*\{?\s*[\w$.\s]*$/.exec(before)
    if (cond && SPACE_ENTER_KEY.test(cond[1])) return true
  }
  return false
}
/** 该 onKeyDown 属性所在的 JSX 起始标签名（最近的前一个 `<`） */
function hostTagBefore(content, offset) {
  const start = content.lastIndexOf('<', offset)
  const m = start < 0 ? null : content.slice(start, offset).match(/^<\/?[A-Za-z][\w.]*/)
  return m ? m[0] : ''
}
for (const f of GATE_FILES) {
  if (f.endsWith('.css')) continue
  const rel = GATE_REL(f)
  const content = readFileSync(f, 'utf-8')
  for (const m of content.matchAll(/onKeyDown=/g)) {
    const brace = content.indexOf('{', m.index)
    if (brace < 0) continue
    let depth = 1
    let i = brace + 1
    while (i < content.length && depth > 0) {
      if (content[i] === '{') depth++
      else if (content[i] === '}') depth--
      i++
    }
    if (depth > 0) continue
    const body = content.slice(brace + 1, i - 1)
    if (!interceptsSpaceOrEnter(body)) continue
    if (/\.target\b/.test(body)) continue
    if (KEYBOARD_HOST_EXEMPT.test(hostTagBefore(content, m.index))) continue
    console.log(`${rel}:${lineAt(content, m.index)}: 行内 onKeyDown 对空格/回车 preventDefault 却未判落点 → 先判 e.target（容器会吞掉行内控件自己的激活键）`)
    violations++
  }
}

// 26. 内联 style 的 width/height 必须是数值或含单位字符串：传 Tailwind 类名会被浏览器当非法
//     CSS 丢弃（骨架列宽曾整片失效）。数值字面量/变量/表达式静态不可判，不判（宁漏不误报）；
//     模板插值的动态值单位在运行时拼出，同样不判。
const SIZE_STYLE_KEY = /\b(?:min|max)?(?:width|height)\s*:\s*/gi
/** 单位必须紧跟数值（`100%` / `2rem`）；裸关键词与无单位零值都是合法 CSS */
const CSS_LENGTH_OK = /[\d.](?:px|rem|em|%|vh|vw|vmin|vmax|ch|ex|pt|pc|cm|mm|in|q)(?![\w])/i
const CSS_SIZE_KEYWORD_OK = /^(?:0|auto|fit-content|max-content|min-content|stretch|inherit|initial|unset|revert|none)$/i
for (const f of GATE_FILES) {
  if (f.endsWith('.css')) continue
  const rel = GATE_REL(f)
  const content = readFileSync(f, 'utf-8')
  for (const m of content.matchAll(/style=\{\{/g)) {
    const start = m.index + m[0].length - 1
    let depth = 1
    let i = start + 1
    while (i < content.length && depth > 0) {
      if (content[i] === '{') depth++
      else if (content[i] === '}') depth--
      i++
    }
    if (depth > 0) continue
    const object = content.slice(start + 1, i - 1)
    for (const k of object.matchAll(SIZE_STYLE_KEY)) {
      const value = object.slice(k.index + k[0].length).split(/[,}]/)[0].trim()
      const literal = /^(['"`])([\s\S]*)\1$/.exec(value)
      if (!literal) continue
      const inner = literal[2]
      if (inner.includes('${')) continue
      if (CSS_SIZE_KEYWORD_OK.test(inner)) continue
      if (CSS_LENGTH_OK.test(inner)) continue
      if (/\b(?:calc|var|clamp|min|max)\(/.test(inner)) continue
      console.log(`${rel}:${lineAt(content, m.index)}: 内联 style 的 ${k[0].trim()} 值「${inner}」不含单位 → 必须是数值或含单位字符串（传类名会被浏览器忽略）`)
      violations++
    }
  }
}

if (violations > 0) {
  console.error(`\n✗ 发现 ${violations} 处设计 token 违规（设计规范 §4.5）`)
  process.exit(1)
}
console.log('✓ 设计 token 完整性检查通过（色板类/dark:/transition-all/duration-数字/rounded-任意值/字号上限/焦点可见性/未注册 token 类/token 角色矩阵/alpha 白名单/未定义类/死类/死 token/内容面 tint 叠加/语义色三件套与选中强调形态声明源/Z 轴阶梯/text-base 额度/玻璃预算/危险半透明底/内容面 tint 不透明/布局属性动画/卡片面声明源/标签组件唯一性/页面页头与标题档/全屏覆盖层来源/行内抢键落点/内联尺寸单位）')
