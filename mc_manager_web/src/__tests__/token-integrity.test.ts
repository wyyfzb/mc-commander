import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

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

/**
 * 产物 CSS 读取（dist 是构建产物、本地可能未构建）：dist 或 assets 缺失时返回空数组，
 * 调用方按「无产物」跳过。两道守卫都要——只判 dist 时，assets 被清理/半构建会 ENOENT 崩，
 * 与「缺失时跳过」的口径不符。
 */
function builtCssOf(distDir: string): string[] {
  const assetsDir = join(distDir, 'assets')
  if (!existsSync(assetsDir)) return []
  return readdirSync(assetsDir)
    .filter((name) => name.endsWith('.css'))
    .map((name) => readFileSync(join(assetsDir, name), 'utf-8'))
}

/**
 * 字号档位与配对行高：档位清单以 semantic.css 为事实源、@theme 注册以
 * index.css 为事实源，两处必须一一对应——漏一处就退回「小档吃正文 1.6 / 行高被字号类吞掉」
 * 的老毛病。行高值本身也断言（只断言「有配对」挡不住把 md 的 1.5 改成 1.9 这类静默漂移）。
 * 16px（旧 md）与 24px（旧 2xl）两档已删，末条的零消费断言是该决定的静态防线：
 * 档名拼接写出（避免自身的字面量被算成消费点），并覆盖产物 CSS——只查源码挡不住
 * 构建产物里残留的 `.text-mcs-2xl` 规则。
 */
describe('字号档位与配对行高', () => {
  const indexCss = readCss('index.css')
  const semanticCss = readCss('styles/tokens/semantic.css')
  const FONT_SIZE_DECL = /--mcs-font-size-([\w-]+)\s*:\s*([^;]+);/g
  const tierPx = new Map([...semanticCss.matchAll(FONT_SIZE_DECL)].map((m) => [m[1]!, m[2]!.trim()]))
  /** 6 个文字档；display 是非文字数字档，不占文字档位 */
  const TEXT_TIERS = ['2xs', 'xs', 'sm', 'md', 'lg', 'xl']
  /** 逐档期望行高：sm 是唯一走正文基准 1.6 的档（同尺寸的 md 靠收紧到 1.5 作强调正文） */
  const EXPECTED_LINE_HEIGHT: Record<string, number> = { '2xs': 1.5, xs: 1.5, sm: 1.6, md: 1.5, lg: 1.4, xl: 1.3 }
  /** semantic.css 的数值型 token（行高可能声明成 var(--mcs-line-height-body)） */
  const semanticNumber = (name: string): number | null => {
    const m = semanticCss.match(new RegExp(`${name}\\s*:\\s*([\\d.]+)\\s*;`))
    return m ? Number(m[1]) : null
  }
  /** 该档在 @theme 里注册的配对行高值（变量引用就地解析成数值） */
  const declaredLineHeight = (tier: string): number | null => {
    const decl = `--text-mcs-${tier}`
    // 档名拼接写出：模板串会被门禁的动态类名前缀规则拦下
    const m = indexCss.match(new RegExp(decl + '--line-height\\s*:\\s*([^;]+);'))
    if (!m) return null
    const value = m[1]!.trim()
    const varRef = value.match(/var\((--mcs-[\w-]+)\)/)
    return varRef ? semanticNumber(varRef[1]!) : Number(value)
  }

  it('文字档 6 档 + 数字档 1 档，6 个文字档逐一配对行高', () => {
    expect([...tierPx.keys()]).toEqual([...TEXT_TIERS, 'display'])
    for (const tier of TEXT_TIERS) {
      // 类名拼出来断言：写成模板串会被门禁的动态类名前缀规则（模板串拼类名静默无效果）拦下
      const decl = '--text-mcs-' + tier
      expect(indexCss, decl + ' 未配对行高').toContain(decl + '--line-height:')
    }
    // 数字档不配对行高：其唯一消费点自带 leading-none（KPI 数字无版式行高需求）
    expect(indexCss).not.toContain('--text-mcs-display--line-height')
  })

  it('逐档行高值符合期望表（数值漂移即红）', () => {
    for (const tier of TEXT_TIERS) {
      expect(declaredLineHeight(tier), `--text-mcs-${tier} 行高`).toBe(EXPECTED_LINE_HEIGHT[tier])
    }
    // sm 必须仍引用正文基准变量（换回硬编码数字即脱离单一事实源）
    expect(indexCss).toContain('--text-mcs-sm--line-height: var(--mcs-line-height-body)')
    expect(semanticNumber('--mcs-line-height-body')).toBe(EXPECTED_LINE_HEIGHT.sm)
  })

  it('16px / 24px 两档已删，两个 14px 档同尺寸不同语义', () => {
    expect([...tierPx.keys()]).not.toContain('2xl')
    expect([...tierPx.values()]).not.toContain('16px')
    expect([...tierPx.values()]).not.toContain('24px')
    expect(tierPx.get('sm')).toBe('14px')
    expect(tierPx.get('md')).toBe('14px')
    expect(tierPx.get('xl')).toBe('22px')
    expect(tierPx.get('display')).toBe('30px')
  })

  it('已删档位在全仓零消费（src / e2e / scripts 与产物 CSS）', () => {
    const needles = ['mcs-' + '2xl', 'font-size-' + '2xl']
    const hits: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', 'dist', '__tests__'].includes(entry.name)) continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full)
          continue
        }
        if (!/\.(tsx?|mjs|css)$/.test(entry.name)) continue
        const content = readFileSync(full, 'utf-8')
        if (needles.some((n) => content.includes(n))) hits.push(relative(srcDir, full))
      }
    }
    walk(join(srcDir, '..'))
    expect(hits).toEqual([])

    // 产物 CSS：源码零引用挡不住构建产物里残留的 `.text-mcs-2xl` 规则（Tailwind 只生成用到的类，
    // 残留即等价于源码曾有引用）。dist 是构建产物、本地可能未构建，缺失时跳过（CI 先 build）
    const builtCss = builtCssOf(join(srcDir, '..', 'dist'))
    if (builtCss.length > 0) {
      const deletedClass = '.' + 'text-mcs-' + '2xl'
      expect(builtCss.some((css) => css.includes(deletedClass)), '产物 CSS 残留 ' + deletedClass).toBe(false)
      expect(builtCss.some((css) => css.includes('.text-mcs-xl')), '产物 CSS 未见字号档（检查失效）').toBe(true)
    }
  })

  it('dist 存在而 assets 缺失（清理/半构建）时不崩，按无产物跳过', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcs-dist-'))
    const fakeDist = join(root, 'dist')
    const fakeAssets = join(fakeDist, 'assets')
    try {
      mkdirSync(fakeDist, { recursive: true })
      expect(() => builtCssOf(fakeDist), 'dist 在而 assets 缺失 → 不得 ENOENT').not.toThrow()
      expect(builtCssOf(fakeDist)).toEqual([])

      // 半构建：assets 在但为空、或只有非 CSS 文件，同样是「无产物」
      mkdirSync(fakeAssets, { recursive: true })
      expect(builtCssOf(fakeDist)).toEqual([])
      writeFileSync(join(fakeAssets, 'index.js'), '// 无 CSS 产物', 'utf-8')
      expect(builtCssOf(fakeDist)).toEqual([])

      // 正例：assets 里有 CSS 时必须读到（守卫不得把正常产物一并跳过）
      writeFileSync(join(fakeAssets, 'index.css'), '.text-mcs-xl{font-size:22px}', 'utf-8')
      expect(builtCssOf(fakeDist)).toHaveLength(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('本机已构建时产物 CSS 被真实读到（守卫不空转）', () => {
    const realCss = builtCssOf(join(srcDir, '..', 'dist'))
    if (realCss.length > 0) {
      expect(realCss.some((css) => css.includes('.text-mcs-xl'))).toBe(true)
    }
  })
})
