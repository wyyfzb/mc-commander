import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Token 引用完整性测试（防复发，对应设计文档 §4.8-1 前置检查）
 * 1. semantic.css 引用的所有 --ref-* 必须已在 reference.css 定义
 * 2. theme.css / @theme inline 引用的所有 --mcs-* 必须已在 semantic.css 定义
 * 3. 组件源码（styles/、components/ui/、test/ 除外）禁止硬编码色值
 * 4. 玻璃预算：全站各 1 处（顶栏 chrome + 确认弹窗 overlay），防视觉异质回潮
 */

const srcDir = join(import.meta.dirname, '..')

function readCss(rel: string): string {
  return readFileSync(join(srcDir, rel), 'utf-8')
}

function definedVars(css: string): Set<string> {
  const names = new Set<string>()
  for (const m of css.matchAll(/(--[\w-]+)\s*:/g)) {
    names.add(m[1]!)
  }
  return names
}

function referencedVars(css: string): Set<string> {
  const names = new Set<string>()
  for (const m of css.matchAll(/var\(\s*(--[\w-]+)/g)) {
    names.add(m[1]!)
  }
  return names
}

/** hex 色值字面量（扫描、剥离的正反用例共用同一常量，避免改一处漏一处） */
const HEX_LITERAL_RE = /#[0-9a-fA-F]{3,8}\b/

/**
 * 剥离注释里的 issue/PR 引用编号（`issue #383`、`fixes #412`、`PR #473`）。
 *
 * 3~8 位十六进制字符（含纯数字）恰好也可能构成合法 hex 写法，不剥离就会被下面的
 * 色值规则误报——分页注释里的 `issue #383` 已误报过一次。只剥离带引用关键词的形态：
 * `#383abc` 这类带字母的仍按色值报出；无关键词的裸 `#123` 也仍报（宁可误报不漏报——
 * 误报的代价是补个关键词，漏报的代价是硬编码色值进了仓库）。
 */
function stripIssueRefs(line: string): string {
  return line.replace(
    /\b(?:issues?|pr|pull request|fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s*#\d+(?![0-9a-fA-F])/gi,
    '',
  )
}

describe('色值扫描的引用编号剥离', () => {
  it('引用编号被剥离（不再被当成 hex 色值）', () => {
    // 编号须 ≥3 位：1~2 位本就匹配不到 HEX_LITERAL_RE，那样断不出剥离是否生效
    for (const line of [
      '// 回归锁（issue #472 / PR #473 沉淀缺口）',
      '// fixes #412',
      '// 详见 issue #383 同源',
      '// Closes #419',
    ]) {
      expect(stripIssueRefs(line), line).not.toMatch(HEX_LITERAL_RE)
    }
  })

  it('真色值一字不动（剥离不得放宽色值判定）', () => {
    for (const line of ["const c = '#fff'", 'color: #000000', '`#ff0000`', '#383a0f', 'issue #383abc']) {
      expect(stripIssueRefs(line), line).toMatch(HEX_LITERAL_RE)
    }
  })
})

describe('token 引用完整性', () => {
  const reference = readCss('styles/tokens/reference.css')
  const semantic = readCss('styles/tokens/semantic.css')
  const theme = readCss('styles/tokens/theme.css')
  const index = readCss('index.css')

  it('semantic 层引用的 --ref-* 全部在 reference 层定义', () => {
    const refDefined = definedVars(reference)
    const dangling = [...referencedVars(semantic)]
      .filter((v) => v.startsWith('--ref-') && !refDefined.has(v))
    expect(dangling).toEqual([])
  })

  it('theme 层与 @theme inline 引用的 --mcs-* 全部在 semantic 层定义', () => {
    const mcsDefined = definedVars(semantic)
    const dangling = [
      ...referencedVars(theme),
      ...[...referencedVars(index)].filter((v) => v.startsWith('--mcs-')),
    ].filter((v) => v.startsWith('--mcs-') && !mcsDefined.has(v))
    expect(dangling).toEqual([])
  })

  it('theme 层只引用 --mcs-* 语义 token（禁止越层直取 --ref-*）', () => {
    const refVars = [...referencedVars(theme)].filter((v) => v.startsWith('--ref-'))
    expect(refVars).toEqual([])
  })

  it('语义层不允许直接写色值字面量（全部经 reference 层）', () => {
    const colorLiterals = semantic.match(/(#[0-9a-fA-F]{3,8}|rgba?\(|oklch\(|hsl\()/g) ?? []
    // color-mix(in oklch, ...) 允许（基于 reference 变量的混合表达式）
    const violations = colorLiterals.filter((l) => l !== 'oklch(' && l !== 'color-mix(in oklch,')
    // semantic 中 oklch( 出现仅可能来自 color-mix(in oklch, ...)；其余均为违规
    expect(semantic.includes('color-mix(in oklch,')).toBe(true)
    expect(violations).toEqual([])
  })
})

describe('组件源码禁硬编码色值', () => {
  const SKIP_DIRS = new Set(['node_modules', 'dist', 'styles', 'test', '__tests__', 'components/ui'])
  // 根级配置文件豁免：vite.config.ts 的 PWA manifest 色为浏览器元数据
  // （Web App Manifest 规范要求 CSS 色格式，无法引用 CSS 变量），非组件样式硬编码
  const SKIP_FILES = new Set(['vite.config.ts'])

  function collectTsxTs(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name) || SKIP_FILES.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...collectTsxTs(full))
      else if (/\.(tsx?|css)$/.test(entry.name)) out.push(full)
    }
    return out
  }

  it('玻璃预算：全站各 1 处（顶栏 chrome + 确认弹窗 overlay）', () => {
    // 审计 S26 收尾：侧栏/通知抽屉/toast 一律实底。
    // 计数口径与 check-design-tokens.mjs 第 17 条一致：按「类名引用次数」而非文件数
    // （同一文件出现两次同样超标；该脚本的扫描范围更宽，含 .ts 与 e2e/）
    const refsOf = (cls: string): string[] =>
      collectTsxTs(srcDir)
        .filter((f) => /\.tsx?$/.test(f))
        .flatMap((f) => Array<string>(readFileSync(f, 'utf-8').match(new RegExp(cls, 'g'))?.length ?? 0).fill(f))
    const chrome = refsOf('glass-chrome')
    const overlay = refsOf('glass-overlay')
    expect(chrome).toHaveLength(1)
    expect(chrome[0]).toContain('app-topbar')
    expect(overlay).toHaveLength(1)
    expect(overlay[0]).toContain('confirm-dialog')
  })

  it('业务/布局组件与 mcs 组件无 hex/rgb/oklch 硬编码（允许 var(--mcs-*) 与 shadcn 组件变量）', () => {
    const violations: string[] = []
    // 先剥离 var(...) 表达式（含 fallback 嵌套）再判定颜色上下文：
    // 整行含 var(-- 就跳过会让「token 与字面量同行」的写法逃检
    const stripVar = (line: string): string => {
      let out = line
      for (let i = 0; i < 10 && out.includes('var('); i++) {
        const next = out.replace(/var\([^()]*\)/g, '')
        if (next === out) break
        out = next
      }
      return out
    }
    for (const file of collectTsxTs(join(srcDir, '..'))) {
      const content = readFileSync(file, 'utf-8')
      content.split('\n').forEach((line, i) => {
        const code = stripIssueRefs(stripVar(line))
        // hex 颜色字面量
        if (HEX_LITERAL_RE.test(code)) {
          violations.push(`${file}:${i + 1}: ${line.trim()}`)
        }
        // rgb()/hsl() 字面量
        if (/\b(rgba?|hsla?)\(/.test(code)) {
          violations.push(`${file}:${i + 1}: ${line.trim()}`)
        }
        // oklch 字面量（color-mix(in oklch, var(--mcs-*) …) 基于 token 的混合表达式豁免）
        if (/\boklch\(/.test(code) && !/color-mix\(in oklch/.test(code)) {
          violations.push(`${file}:${i + 1}: ${line.trim()}`)
        }
      })
    }
    expect(violations).toEqual([])
  })
})
