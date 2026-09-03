/**
 * 设计 token 完整性守门脚本（设计文档 §4.5 token 纪律）
 * 用法：node scripts/check-design-tokens.mjs
 * 检测范围（排除 src/components/ui/ shadcn 组件）：
 *   1. Tailwind 原始色板类（text-{color}/bg-{color}/border-{color}/ring-{color}）
 *   2. dark: 前缀类
 *   3. transition-all
 *   4. duration-{数字}（非 token 的硬编码时长）
 *   5. rounded-[ 任意值圆角
 *   6. Tailwind 原生字号 3xl 及以上（字号 token 体系上限 --mcs-font-size-2xl，KPI/大字一律 ≤ 2xl）
 *   7. 紧急页（src/features/emergency/）字重 bold 及以上（触控页字重限定 400-600）
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

let violations = 0

/** 在单行 className 字符串中检测违规模式 */
function checkLine(filePath, lineNum, line, isEmergencyPage) {
  // 提取 className 内容（单引号、双引号、模板字面量）
  const classMatches = [...line.matchAll(/(?:className|class)=["'`]([^"'`]*)["'`]/g)]
  if (classMatches.length === 0) return

  for (const m of classMatches) {
    const classes = m[1]
    // 1. 检测 dark: 前缀
    if (/\bdark:\w/.test(classes)) {
      console.log(`${filePath}:${lineNum + 1}: dark: 前缀类 → ${extractViolatingClass(classes, 'dark:')}`)
      violations++
    }
    // 2. 检测 transition-all
    if (/\btransition-all\b/.test(classes)) {
      console.log(`${filePath}:${lineNum + 1}: transition-all → 请改用具体属性如 transition-[property]`)
      violations++
    }
    // 3. 检测 duration-{纯数字}
    if (/\bduration-(\d+)\b/.test(classes)) {
      console.log(`${filePath}:${lineNum + 1}: duration-${classes.match(/\bduration-(\d+)\b/)[1]} → 请使用 duration-mcs-fast/base/slow token`)
      violations++
    }
    // 4. 检测 rounded-[ 任意值
    if (/\brounded-\[/.test(classes)) {
      console.log(`${filePath}:${lineNum + 1}: rounded-[...] 任意值 → 请使用 rounded-mcs-* token`)
      violations++
    }
    // 5. 检测原始色板类 (text-{color}, bg-{color}, border-{color}, ring-{color})
    const colorPrefixes = ['text-','bg-','border-','ring-']
    for (const prefix of colorPrefixes) {
      const colorMatches = [...classes.matchAll(new RegExp(`\\b${prefix}([a-zA-Z][\\w-]*)`, 'g'))]
      for (const cm of colorMatches) {
        const colorName = cm[1].split('/')[0] // 去掉 /50 等透明度后缀
        if (PALETTE_COLORS.has(colorName)) {
          // 排除 mcs-* token 和已注册的语义色
          const fullClass = prefix + cm[1]
          if (!fullClass.includes('mcs-')) {
            console.log(`${filePath}:${lineNum + 1}: ${prefix}${colorName} 原始色板类 → 请使用 --mcs-* token`)
            violations++
          }
        }
      }
    }
    // 6. 检测 bg-black（特殊情况，不含后缀）
    if (/\bbg-black\b/.test(classes)) {
      console.log(`${filePath}:${lineNum + 1}: bg-black → 请使用 --mcs-* token`)
      violations++
    }
    // 7. 检测 Tailwind 原生超大字号（3xl+；--mcs-font-size-* 上限 2xl=24px，
    //    KPI 大数字/页面大标题一律走 token，防审计 P2-22 类字号膨胀复发）
    const oversize = classes.match(/\btext-(3xl|4xl|5xl|6xl|7xl|8xl|9xl)\b/)
    if (oversize) {
      console.log(`${filePath}:${lineNum + 1}: text-${oversize[1]} 超出字号 token 体系 → 请使用 text-mcs-* token（≤ 2xl）`)
      violations++
    }
    // 8. 紧急页字重限定 400-600（触控页视觉纪律，防审计 P2-12 类字重加重复发；
    //    仅约束紧急页，其余页面标题字重不受限）
    if (isEmergencyPage) {
      const heavy = classes.match(/\bfont-(bold|extrabold|black)\b/)
      if (heavy) {
        console.log(`${filePath}:${lineNum + 1}: font-${heavy[1]} 紧急页字重超限 → 字重限定 400-600（font-normal/medium/semibold）`)
        violations++
      }
    }
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
console.log('✓ 设计 token 完整性检查通过（色板类/dark:/transition-all/duration-数字/rounded-任意值/字号上限/紧急页字重）')
