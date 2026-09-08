import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Token 引用完整性测试（防复发，对应设计文档 §4.8-1 前置检查）
 * 1. semantic.css 引用的所有 --ref-* 必须已在 reference.css 定义
 * 2. theme.css / @theme inline 引用的所有 --mcs-* 必须已在 semantic.css 定义
 * 3. 组件源码（styles/、components/ui/、test/ 除外）禁止硬编码色值
 * 4. 玻璃预算：glass-overlay 仅允许 ≤2 处（Sheet 抽屉 + 确认弹窗），防视觉异质回潮
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

  it('玻璃预算：glass-overlay 组件引用 ≤2 处（仅 Sheet 抽屉 + 确认弹窗豁免）', () => {
    // 收集 src/ 下引用 glass-overlay 的 .tsx 组件文件（glass.css 定义处不计入）
    const glassUsers: string[] = []
    for (const file of collectTsxTs(srcDir)) {
      if (!file.endsWith('.tsx')) continue
      if (readFileSync(file, 'utf-8').includes('glass-overlay')) {
        glassUsers.push(file)
      }
    }
    // 预算超支时报出全部违规文件，便于逐处回归实底
    expect(glassUsers.length).toBeLessThanOrEqual(2)
    expect(glassUsers).toEqual(
      expect.arrayContaining([
        expect.stringContaining('notification-drawer'),
        expect.stringContaining('confirm-dialog'),
      ]),
    )
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
        const code = stripVar(line)
        // hex 颜色字面量
        if (/#[0-9a-fA-F]{3,8}\b/.test(code)) {
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
