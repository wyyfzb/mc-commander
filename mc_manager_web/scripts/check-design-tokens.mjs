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
 * 类名提取覆盖 className="..."、className={cn(...)}、模板字面量、对象映射值（如 tone: 'bg-...'），
 * 不留「只在 className 字面属性里才检查」的盲区。
 * 发现违规 → 输出 文件:行号 → 非零退出码（阻止合并）
 */
import { readFileSync, readdirSync } from 'node:fs'
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

/** 未注册 token 类：prefix-mcs-name 必须能在 @theme/effects 注册集里找到同名条目 */
function checkTokenRegistration(classes, filePath, lineNum) {
  for (const raw of classes.split(/\s+/)) {
    if (!raw.includes('-mcs-')) continue
    if (raw.includes('(') || raw.includes('--')) continue // var(--mcs-*) 等非类名
    const body = raw.replace(/\/\d+$/, '').slice(raw.replace(/\/\d+$/, '').lastIndexOf(':') + 1)
    const m = body.match(/^([a-z-]+)-mcs-([a-z0-9-]+)$/)
    if (!m) continue
    const [, prefix, name] = m
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
  // 10. 未注册 token 类（语义静默丢失）
  checkTokenRegistration(classes, filePath, lineNum)
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

if (violations > 0) {
  console.error(`\n✗ 发现 ${violations} 处设计 token 违规（设计规范 §4.5）`)
  process.exit(1)
}
console.log('✓ 设计 token 完整性检查通过（色板类/dark:/transition-all/duration-数字/rounded-任意值/字号上限/紧急页字重/焦点可见性/未注册 token 类）')
