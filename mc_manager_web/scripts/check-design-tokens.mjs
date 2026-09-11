/**
 * 设计 token 完整性守门脚本（设计文档 §4.5 token 纪律）
 * 用法：node scripts/check-design-tokens.mjs
 * 逐行检查（第 1–11 条，排除 src/components/ui/）：
 *   1. Tailwind 原始色板类（text-{color}/bg-{color}/border-{color}/ring-{color}）
 *   2. dark: 前缀类
 *   3. transition-all（ui/ 由第 20 条覆盖）
 *   4. duration-{数字}（非 token 的硬编码时长；ui/ 由第 20 条覆盖）
 *   5. rounded-[ 任意值圆角
 *   6. Tailwind 原生字号 3xl 及以上（原生字号上限 2xl；数字面板可走 --mcs-font-size-display（30px），须与 .mcs-num 同用）
 *   7. 紧急页（src/features/emergency/）字重 bold 及以上（触控页字重限定 400-600）
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
 *      border+bg-subtle+fg 即又抄了一份词表；测试与 tone.ts 自身除外）。
 *      注：11b/11c 走 walkDir(srcDir)，即**只扫 src/ 且不含 components/ui/**，不覆盖 e2e/ 与
 *      scripts/；判定面限「同一字面量内整串写全」，容器 border+bg 与子元素 fg 拆写不判
 *  16. Z 轴阶梯：禁裸 z-<数字>（类名 / 内联 zIndex / CSS z-index）
 *  17. 玻璃预算：全站各 1 处（顶栏 glass-chrome + 覆盖层 glass-overlay）
 *  18. 危险语义色禁半透明底：bg-destructive/<alpha>
 *  19. 内容面 tint 必须不透明
 *  20. 布局属性动画（transition-all）与数字时长档（duration-<数字>），含 ui/ 基座
 * 类名提取覆盖 className="..."、className={cn(...)}、模板字面量、对象映射值（如 tone: 'bg-...'），
 * 不留「只在 className 字面属性里才检查」的盲区。
 * 发现违规 → 输出 文件:行号 → 非零退出码（阻止合并）
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, extname, relative, sep } from 'node:path'

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
  const collect = (css, re) => new Set([...css.matchAll(re)].map((m) => m[1]))
  return {
    color: collect(indexCss, /--color-mcs-([\w-]+)\s*:/g),
    radius: collect(indexCss, /--radius-mcs-([\w-]+)\s*:/g),
    text: collect(indexCss, /--text-mcs-([\w-]+)\s*:/g),
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

/** 在单条类名串中检测违规模式 */
function checkClasses(filePath, lineNum, classes, isEmergencyPage) {
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
    console.log(`${filePath}:${lineNum + 1}: text-${oversize[1]} 超出字号 token 体系 → 请使用 text-mcs-* token（≤ 2xl）或 text-mcs-display（配 .mcs-num）`)
    violations++
  }
  // 8. 紧急页字重限定 400-600
  if (isEmergencyPage) {
    const heavy = classes.match(/\bfont-(bold|extrabold|black)\b/)
    if (heavy) {
      console.log(`${filePath}:${lineNum + 1}: font-${heavy[1]} 紧急页字重超限 → 字重限定 400-600（font-normal/medium/semibold）`)
      violations++
    }
  }
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
function checkLine(filePath, lineNum, line, isEmergencyPage) {
  for (const literal of extractLiterals(line)) {
    if (!literal.includes('-') && !literal.includes(':')) continue
    checkClasses(filePath, lineNum, literal, isEmergencyPage)
  }
}

/** 剥掉注释后的正文（一律等长空白替换，保证偏移量↔行号仍与原文对齐）。
 *  只供本节 11b/11c 使用：1–11 条按原始行判定，注释里的示例仍会命中（既有取舍，未改） */
function stripComments(content) {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    // 行注释同样抹成等长空白：会把 https:// 这类串连同其后内容一并吃掉，属「宁漏不误报」的取舍
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
}

/**
 * 内容面 tint 叠加（词表侧）：`toneClasses()` / `SEMANTIC_TONE_CLASSES[...].bg` 的产出也是
 * 内容面 tint，与字面量 tint 落在同一处着色（同一次 cn/clsx 调用，或同一个模板串）即叠加。
 * 逐行数字面量的那条看不见这种间接写法，而语义色收归词表后恰是常见形态。
 * 启发式边界：跨行按括号配平取实参表；未配平、以及「先赋值再传入」的变量中转过都不判
 * （宁漏不误报）；同一处嵌套（cn 里套 cn/clsx）只计一次。返回 [{ offset, end }]。
 */
function findToneTintOverlaps(content) {
  const code = stripComments(content)
  // 80 是属性访问写法（SEMANTIC_TONE_CLASSES[tone].bg）的向后搜索窗口，现网最长约 40 字符
  const TINT_SOURCE = /toneClasses\(|SEMANTIC_TONE_CLASSES[\s\S]{0,80}?\.bg\b/
  const TINT_LITERAL = /bg-mcs-[\w-]+-bg-subtle/
  const hits = []
  const covered = (offset) => hits.some((h) => offset > h.offset && offset < h.end)
  /** 已被命中区间整段包住（模板串里套 cn 的情形）→ 同处不再重复计数 */
  const wraps = (start, end) => hits.some((h) => start <= h.offset && end >= h.end)

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
    const args = code.slice(start, i - 1)
    if (TINT_SOURCE.test(args) && TINT_LITERAL.test(args)) hits.push({ offset: m.index, end: i })
  }

  // 模板串：同一个串里两种来源并存（cn 之外的常见写法）
  for (const m of code.matchAll(/`(?:[^`\\]|\\.)*`/g)) {
    const end = m.index + m[0].length
    if (covered(m.index) || wraps(m.index, end)) continue
    if (TINT_SOURCE.test(m[0]) && TINT_LITERAL.test(m[0])) hits.push({ offset: m.index, end })
  }
  return hits
}

/**
 * 六档语义色的「静态三件套」声明源只有 mcs/tone.ts。
 * 按空白切词做**整词**比对（不用子串包含）：`border-mcs-accent-border-strong` 是另一档
 * 描边（选中强调，词表未覆盖的独立形状）、`hover:bg-mcs-*-bg-subtle` 是交互覆盖层而非
 * 内容面 tint，两者都不算手写三件套，不能被误报。
 */
const TONE_TRIAD_NAMES = ['accent', 'success', 'warning', 'error', 'info', 'purple']
const STRING_LITERAL = /'[^'\n]*'|"[^"\n]*"|`(?:[^`\\]|\\.)*`/g

function findHandwrittenToneTriads(content) {
  const code = stripComments(content)
  const hits = []
  for (const m of code.matchAll(STRING_LITERAL)) {
    const tokens = new Set(m[0].slice(1, -1).split(/\s+/).filter(Boolean))
    const tone = TONE_TRIAD_NAMES.find(
      (t) =>
        tokens.has(`border-mcs-${t}-border`) &&
        tokens.has(`bg-mcs-${t}-bg-subtle`) &&
        tokens.has(`text-mcs-${t}-fg`),
    )
    if (tone) hits.push({ offset: m.index, tone })
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
    // 紧急页目录：字重 400-600 断言仅约束该目录（触控页视觉纪律）
    const isEmergencyPage = relPath.split(sep).includes('emergency')
    const content = readFileSync(fullPath, 'utf-8')
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      checkLine(relPath, i, lines[i], isEmergencyPage)
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
      for (const hit of findHandwrittenToneTriads(content)) {
        const lineNum = content.slice(0, hit.offset).split('\n').length
        console.log(`${relPath}:${lineNum}: 手写 ${hit.tone} 档三件套（border+bg-subtle+fg）→ 语义色声明源只有 components/mcs/tone.ts`)
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

// 源码类名（严格形状；动态模板取前缀，如 mcs-delay-${i} → mcs-delay-）
// classContext：该字面量所在行是否像类名上下文（className/cn/cva/clsx）——
// 用于把「形如 mcs-x 的存储键/事件名/测试夹具」与真正的裸类名区分开
const CLASS_CONTEXT = /className|class=|\bcn\(|\bcva\(|\bclsx\(/
const usedClasses = new Map() // class → { file, classContext }
const usedPrefixes = new Set()
for (const f of G9_FILES) {
  if (f.endsWith('.css')) continue
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

if (violations > 0) {
  console.error(`\n✗ 发现 ${violations} 处设计 token 违规（设计规范 §4.5）`)
  process.exit(1)
}
console.log('✓ 设计 token 完整性检查通过（色板类/dark:/transition-all/duration-数字/rounded-任意值/字号上限/紧急页字重/焦点可见性/未注册 token 类/token 角色矩阵/alpha 白名单/未定义类/死类/死 token/内容面 tint 叠加/Z 轴阶梯/玻璃预算/危险半透明底/内容面 tint 不透明/布局属性动画）')
