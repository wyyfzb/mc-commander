/**
 * 设计 token 完整性守门脚本（设计文档 §4.5 token 纪律）
 * 用法：node scripts/check-design-tokens.mjs
 * 检测范围（排除 src/components/ui/ shadcn 组件）：
 *   1. Tailwind 原始色板类（text-{color}/bg-{color}/border-{color}/ring-{color}）
 *   2. dark: 前缀类
 *   3. transition-all
 *   4. duration-{数字}（非 token 的硬编码时长）
 *   5. rounded-[ 任意值圆角
 *   6. Tailwind 原生字号 3xl 及以上（原生字号上限 2xl；数字面板可走 --mcs-font-size-display（30px），须与 .mcs-num 同用）
 *   7. 紧急页（src/features/emergency/）字重 bold 及以上（触控页字重限定 400-600）
 *   8. 焦点可见性：outline-none 与 focus-visible:outline-* 同处 utilities 层会互相抵消
 *      （outline-style 恒为 none，焦点环零绘制），未补 ring 兜底即报错
 *   9. 未注册的 mcs-* 工具类：@theme 未注册 → Tailwind 静默不生成任何规则（语义丢失）
 *  10. token 角色越界：填充档（tint/brand）作边框或文字 → 边界不可见（1.00-1.40:1）
 *  11. alpha 修饰符越界：文字/边界档叠加 /NN → 跌破实测对比度下限（3.32:1）
 *  12. 未定义类：源码使用但项目 CSS 未定义、@theme 未注册 → Tailwind 不生成规则（静默无效果）；
 *      本项含 src/components/ui/（shadcn 基座里的失效类同样是缺陷）
 *  13. 死类：项目 CSS 定义但全仓 0 使用 → 报错（`@reserved` 注释可豁免）
 *  14. 死 token：semantic.css 定义但全仓 0 消费 → 报错（删除，或加 `@reserved` 注释说明预留原因）
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
  if (name.startsWith('dimension-')) return 'graphic'
  if (name === 'terminal-bg') return 'surface'
  if (name.endsWith('-bg-subtle') || name.startsWith('state-') || name.startsWith('scrim')) return 'tint'
  if (name.startsWith('bg-')) return 'surface'
  if (name === 'accent' || name === 'accent-hover') return 'brand'
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
 * 文字/边界档禁止（text-mcs-text-subtle/80 实测 3.32:1）；已 alpha 的 tint 档禁止二次叠加。
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
}

/** 在单行中提取类名串并逐条检测（覆盖 cn(...)/模板串/对象值，不限 className= 字面属性） */
function checkLine(filePath, lineNum, line, isEmergencyPage) {
  for (const literal of extractLiterals(line)) {
    if (!literal.includes('-') && !literal.includes(':')) continue
    checkClasses(filePath, lineNum, literal, isEmergencyPage)
  }
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
    const lines = readFileSync(fullPath, 'utf-8').split('\n')
    for (let i = 0; i < lines.length; i++) {
      checkLine(relPath, i, lines[i], isEmergencyPage)
    }
  }
}

walkDir(srcDir)

// ── G9：未定义类 / 死类 / 死 token 双向检查 ─────────────────────
// 消费口径：token 存活 = ① 定义层/注册层之外出现 `--mcs-x` 字面量（含 cssVar('--mcs-x')），
//           或 ② 由 index.css 注册派生的工具类在源码被使用。
// 与逐行检查的区别：本段**不排除** src/components/ui/——基座里的失效类同样是缺陷
// （`--ease-mcs-spring` 曾在 ui/dialog.tsx 静默失效即因此逃检）。
/** 非类名同形标识符：localStorage 键 / 自定义事件名 / Monaco 主题 id */
const NON_CLASS_MCS_IDENTIFIERS = new Set([
  'mcs-session', 'mcs-connection', 'mcs-ui-preferences', 'mcs-theme', 'mcs-notifications',
  'mcs-notification-preferences', 'mcs-command-presets', 'mcs-command-history',
  'mcs-command-history-status', 'mcs-announcement-presets', 'mcs-terminal-autoscroll',
  'mcs-confirm-commands', 'mcs-ws-last-event', 'mcs-dark',
])

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
const usedClasses = new Map() // class → 首个出现文件
const usedPrefixes = new Set()
for (const f of G9_FILES) {
  if (f.endsWith('.css')) continue
  const text = readFileSync(f, 'utf-8')
  for (const lit of text.matchAll(/(["'`])([^"'`\n]*)\1/g)) {
    for (const raw of lit[2].split(/\s+/)) {
      const body = raw.replace(/^.*:/, '').replace(/!$/, '').replace(/\/[\d[\].]+$/, '')
      if (!body) continue
      const dyn = body.match(/^((?:mcs|glass|animate-mcs|[a-z-]*-mcs)-[a-z0-9-]*)\$\{/)
      if (dyn) { usedPrefixes.add(dyn[1]); continue }
      if (!/^(?:[a-z-]*-)?(?:mcs|glass)-[a-z0-9-]+$/.test(body)) continue
      if (!usedClasses.has(body)) usedClasses.set(body, relative(root, f))
    }
  }
}
const isUsed = (cls) => usedClasses.has(cls) || [...usedPrefixes].some((p) => cls.startsWith(p))

// 12. 未定义类（含 ui/）：既未定义也未注册 → Tailwind 静默不生成
for (const [cls, file] of usedClasses) {
  if (definedClasses.has(cls) || registeredUtilities.has(cls)) continue
  if (NON_CLASS_MCS_IDENTIFIERS.has(cls)) continue
  // 非 ui/ 的 *-mcs-* 工具类已由逐行检查（G2）覆盖，避免重复报
  if (/^[a-z-]+-mcs-/.test(cls) && !file.replace(/\\/g, '/').includes(EXCLUDE_DIR)) continue
  console.log(`${file}: ${cls} 未定义/未注册 → 项目 CSS 无此选择器且 @theme 无此注册，类名静默无效果`)
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

// 14. 死 token：semantic.css 定义但 0 消费（警告，不阻塞）
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

if (violations > 0) {
  console.error(`\n✗ 发现 ${violations} 处设计 token 违规（设计规范 §4.5）`)
  process.exit(1)
}
console.log('✓ 设计 token 完整性检查通过（色板类/dark:/transition-all/duration-数字/rounded-任意值/字号上限/紧急页字重/焦点可见性/未注册 token 类/token 角色矩阵/alpha 白名单/未定义类/死类/死 token）')
