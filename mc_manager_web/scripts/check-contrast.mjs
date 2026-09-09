/**
 * token 对比度批量校验（设计文档 §4.8-1，M1 出口二重审查）
 * 用法：node scripts/check-contrast.mjs
 * 标准：正文 ≥4.5:1 / 边框与焦点 ≥3:1 / 图形 ≥3:1（WCAG 实测不取整）
 *       明暗主题独立验证；任一组合不达标 → exit 1（阻止合并）
 * 面口径（G3）：5 个语义底色 + 3 个玻璃面近似（按 glass.css alpha 叠在卡片/弹窗底上取最差合成）
 *       内容面 tint（*-bg-subtle）必须不透明，否则有效色随宿主面漂移
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse, wcagContrast, rgb as toRgb, converter } from 'culori'

const toOklch = converter('oklch')

const root = join(import.meta.dirname, '..')

// ── CSS 变量解析 ───────────────────────────────────────────────
function extractVars(cssText) {
  const vars = new Map()
  for (const m of cssText.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    vars.set(m[1], m[2].trim())
  }
  return vars
}

/** 按作用域解析：:root（暗色）+ .light（亮色），各自独立（不镜像） */
function resolveScopes(cssText) {
  const scopes = { root: new Map(), light: new Map() }
  for (const m of cssText.matchAll(/(:root|\.light)\s*\{([^}]+)\}/g)) {
    const scopeName = m[1] === ':root' ? 'root' : 'light'
    for (const [k, v] of extractVars(m[2])) {
      scopes[scopeName].set(k, v)
    }
  }
  // 亮色未定义的变量继承暗色定义（设计文档：独立映射，但允许共享非颜色 token）
  for (const [k, v] of scopes.root) {
    if (!scopes.light.has(k)) scopes.light.set(k, v)
  }
  return scopes
}

/** 解析颜色字符串（支持 oklch()/hex/rgba()/var() 引用；var 先查语义作用域再查 reference 层） */
function parseColor(raw, vars, refVars) {
  let value = raw
  let depth = 0
  while (value.includes('var(') && depth < 10) {
    const m = value.match(/var\((--[\w-]+)\)/)
    if (!m) break
    const resolved = vars.get(m[1]) ?? refVars.get(m[1])
    if (!resolved) throw new Error(`未定义变量 ${m[1]}`)
    value = value.replace(m[0], resolved)
    depth++
  }
  // color-mix(in oklch, <color> <pct>%, transparent) → 该色带 alpha，交给 composite 合成
  const mixTransparent = value.match(/color-mix\(in oklch,\s*(.+?)\s+([\d.]+)%,\s*transparent\)/)
  if (mixTransparent) {
    return { color: parse(mixTransparent[1]), alpha: Number(mixTransparent[2]) / 100 }
  }
  // color-mix(in oklch, <colorA> <pct>%, <colorB>) → 两色均不透明，按 oklch 坐标插值（同 CSS 语义）
  const mixOpaque = value.match(/color-mix\(in oklch,\s*(.+?)\s+([\d.]+)%,\s*(.+?)\)$/)
  if (mixOpaque) {
    const [, rawA, pctA, rawB] = mixOpaque
    const a = toOklch(parseColor(rawA, vars, refVars).color)
    const b = toOklch(parseColor(rawB, vars, refVars).color)
    const p = Number(pctA) / 100
    const h1 = a.h ?? 0
    const h2 = b.h ?? 0
    const dh = ((h2 - h1 + 540) % 360) - 180 // 短弧插值
    return {
      color: { mode: 'oklch', l: p * a.l + (1 - p) * b.l, c: p * a.c + (1 - p) * b.c, h: (h1 + dh * (1 - p) + 360) % 360 },
      alpha: 1,
    }
  }
  const c = parse(value)
  if (!c) throw new Error(`无法解析颜色: ${raw} -> ${value}`)
  // rgba()/带 alpha 的色值：把自带 alpha 提到包装层（前景须按合成后颜色参与对比度计算）
  const alpha = c.alpha ?? 1
  return { color: alpha === 1 ? c : { mode: c.mode, ...Object.fromEntries(Object.entries(c).filter(([k]) => k !== 'alpha')) }, alpha }
}

/** alpha 容器底与背景的合成色（先转 sRGB 再线性合成，WCAG 亮度计算域） */
function composite(fgColor, bgColor, alpha) {
  const f = toRgb(fgColor)
  const b = toRgb(bgColor)
  return {
    mode: 'rgb',
    r: f.r * alpha + b.r * (1 - alpha),
    g: f.g * alpha + b.g * (1 - alpha),
    b: f.b * alpha + b.b * (1 - alpha),
  }
}

// ── 校验矩阵 ──────────────────────────────────────────────────
const reference = readFileSync(join(root, 'src/styles/tokens/reference.css'), 'utf-8')
const semantic = readFileSync(join(root, 'src/styles/tokens/semantic.css'), 'utf-8')

const refVars = extractVars(reference)
const semanticScopes = resolveScopes(semantic)

const STATUS_KEYS = ['success', 'warning', 'error', 'info', 'purple', 'orange']
const BG_KEYS = ['bg-default', 'bg-muted', 'bg-subtle', 'bg-emphasis', 'bg-hover']

/**
 * 玻璃面规格直接从 glass.css 读取（单一事实源）：{ name, token, alpha }
 * .light 规则覆盖同名基础规则；模态玻璃（overlay/toast）的底是「scrim 之后的背景」
 */
const MODAL_GLASS = new Set(['glass-overlay', 'glass-toast'])
function readGlassSpecs(isLight) {
  const css = readFileSync(join(root, 'src/styles/glass.css'), 'utf-8')
  const base = new Map()
  const light = new Map()
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selector = m[1].trim()
    const name = selector.match(/\.glass-([\w-]+)/)?.[1]
    if (!name) continue
    const bg = m[2].match(/background:\s*color-mix\(in oklch,\s*var\((--mcs-[\w-]+)\)\s+([\d.]+)%/)
    if (!bg) continue
    const spec = { name: `glass-${name}`, token: bg[1], alpha: Number(bg[2]) / 100 }
    if (selector.includes('.light')) light.set(spec.name, spec)
    else if (!base.has(spec.name)) base.set(spec.name, spec)
  }
  const merged = new Map(base)
  if (isLight) for (const [k, v] of light) merged.set(k, v)
  return [...merged.values()]
}

let failures = 0
let checks = 0

function check(label, ratio, required, exempt = false) {
  checks++
  const ok = ratio >= required
  if (!ok && !exempt) failures++
  const mark = ok ? '✓' : exempt ? '·' : '✗'
  const note = exempt ? '（豁免：禁用/占位语义）' : ''
  console.log(
    `${mark} ${label.padEnd(52)} ${ratio.toFixed(2).padStart(6)}:1  需 ≥${required}:1${note}`,
  )
}

function contrastVarPair(varNameA, varNameB, vars) {
  const a = parseColor(vars.get(varNameA), vars, refVars)
  const b = parseColor(vars.get(varNameB), vars, refVars)
  // 前景自带 alpha（如 rgba 边框）时按合成后颜色参与计算
  const fg = a.alpha === 1 ? a.color : composite(a.color, b.color, a.alpha)
  return wcagContrast(fg, b.color)
}

for (const [scopeName, vars] of [
  ['暗色', semanticScopes.root],
  ['亮色', semanticScopes.light],
]) {
  console.log(`\n════ ${scopeName}主题 ════`)

  // 面集合：5 个语义底色 + 玻璃面（glass.css 规格 × scrim 后的卡片/弹窗底，取最差合成）
  const pageBg = parseColor(vars.get('--mcs-bg-default'), vars, refVars)
  const scrim = parseColor(vars.get('--mcs-scrim'), vars, refVars)
  const glassSurfaces = readGlassSpecs(scopeName === '亮色').map((spec) => {
    const glass = parseColor(vars.get(spec.token), vars, refVars)
    const candidates = ['bg-muted', 'bg-emphasis'].map((bk) => {
      const backdrop = parseColor(vars.get(`--mcs-${bk}`), vars, refVars)
      const behind = MODAL_GLASS.has(spec.name) ? composite(scrim.color, backdrop.color, scrim.alpha) : backdrop.color
      return composite(glass.color, behind, spec.alpha)
    })
    return [spec.name, candidates]
  })
  const surfaces = [
    ...BG_KEYS.map((k) => [`${k}`, [parseColor(vars.get(`--mcs-${k}`), vars, refVars).color]]),
    ...glassSurfaces,
  ]
  // 面 × 前景：取该面上所有候选底的最差对比度
  const worstOn = (fgColor, candidates) => Math.min(...candidates.map((bg) => wcagContrast(fgColor, bg)))
  void pageBg

  // 1. 文字三级 × 面（正文 ≥4.5:1，含 subtle）
  for (const textKey of ['text-default', 'text-muted', 'text-subtle']) {
    const fg = parseColor(vars.get(`--mcs-${textKey}`), vars, refVars)
    for (const [name, candidates] of surfaces) check(`${textKey} on ${name}`, worstOn(fg.color, candidates), 4.5)
  }

  // 2. 状态六色 fg × 面（文字/图标 ≥4.5）
  for (const status of STATUS_KEYS) {
    const fg = parseColor(vars.get(`--mcs-${status}-fg`), vars, refVars)
    for (const [name, candidates] of surfaces) check(`${status}-fg on ${name}`, worstOn(fg.color, candidates), 4.5)
  }

  // 3. 状态色 fg × 自身容器底（容器底承载文字 → 文字口径 4.5）
  //    容器底必须不透明：半透明 tint 的有效色随宿主面变化，最亮浮层上会跌破（审计 G3 根因）
  for (const status of STATUS_KEYS) {
    const bgSubRaw = vars.get(`--mcs-${status}-bg-subtle`)
    if (bgSubRaw === undefined) {
      console.log(`· ${status}-fg on ${status}-bg-subtle`.padEnd(53) + `  跳过（该色族无 -bg-subtle 档）`)
      continue
    }
    const fg = parseColor(vars.get(`--mcs-${status}-fg`), vars, refVars)
    const bgSub = parseColor(bgSubRaw, vars, refVars)
    if (bgSub.alpha !== 1) {
      console.log(`✗ ${status}-bg-subtle 为半透明（alpha ${bgSub.alpha}）→ 内容面 tint 必须不透明，否则对比度随宿主面漂移`)
      failures++
      checks++
      continue
    }
    check(`${status}-fg on ${status}-bg-subtle`, wcagContrast(fg.color, bgSub.color), 4.5)
    // 容器底上的次级文字（muted 是 tint 面允许的最弱文字档）
    const muted = parseColor(vars.get('--mcs-text-muted'), vars, refVars)
    check(`text-muted on ${status}-bg-subtle`, wcagContrast(muted.color, bgSub.color), 4.5)
  }

  // 4. on-accent × accent（CTA 按钮文字 ≥4.5）
  check('on-accent on accent', contrastVarPair('--mcs-on-accent', '--mcs-accent', vars), 4.5)

  // 5. accent-fg × 面（accent 做文字/图标 ≥4.5）
  {
    const fg = parseColor(vars.get('--mcs-accent-fg'), vars, refVars)
    for (const [name, candidates] of surfaces) check(`accent-fg on ${name}`, worstOn(fg.color, candidates), 4.5)
    const accTint = parseColor(vars.get('--mcs-accent-bg-subtle'), vars, refVars)
    if (accTint.alpha !== 1) {
      console.log(`✗ accent-bg-subtle 为半透明（alpha ${accTint.alpha}）→ 内容面 tint 必须不透明`)
      failures++
      checks++
    } else {
      check('accent-fg on accent-bg-subtle', wcagContrast(fg.color, accTint.color), 4.5)
    }
  }

  // 6. 边框 × 面（交互边框 ≥3:1；边框自带 alpha 时按合成后颜色算）
  {
    const fg = parseColor(vars.get('--mcs-border-default'), vars, refVars)
    for (const [name, candidates] of surfaces) {
      const worst = Math.min(...candidates.map((bg) => wcagContrast(composite(fg.color, bg, fg.alpha), bg)))
      check(`border-default on ${name}`, worst, 3.0)
    }
  }

  // 7. 焦点环 × 面（≥3:1，不透明；组件用 ring-ring 不透明焦点环，见 ui/* 组件）
  {
    const fg = parseColor(vars.get('--mcs-focus-ring'), vars, refVars)
    for (const [name, candidates] of surfaces) check(`focus-ring on ${name}`, worstOn(fg.color, candidates), 3.0)
  }

  // 8. 维度三色 × 面（8px 色点小图形 ≥3:1，WCAG 1.4.11 非文字图形标准）
  for (const dim of ['overworld', 'nether', 'end']) {
    const fg = parseColor(vars.get(`--mcs-dimension-${dim}`), vars, refVars)
    for (const [name, candidates] of surfaces) check(`dimension-${dim} on ${name}`, worstOn(fg.color, candidates), 3.0)
  }

  // 9. accent 强档边界 × 面（交互控件边界/状态描边 ≥3:1，须按合成后颜色算）
  //    弱档 --mcs-accent-border 仅作装饰（亮色 1.10:1 / 暗色 1.69:1），不得用于控件边界
  const strongBorder = parseColor(vars.get('--mcs-accent-border-strong'), vars, refVars)
  for (const [name, candidates] of surfaces) {
    const worst = Math.min(...candidates.map((bg) => wcagContrast(composite(strongBorder.color, bg, strongBorder.alpha), bg)))
    check(`accent-border-strong on ${name}`, worst, 3.0)
  }
  // 9b. 选中态内面（accent tint 叠页面底）：强档描边的实际落点（选中 chip/物品格/导航项）
  {
    const page = parseColor(vars.get('--mcs-bg-default'), vars, refVars)
    const tint = parseColor(vars.get('--mcs-accent-bg-subtle'), vars, refVars)
    const face = composite(tint.color, page.color, tint.alpha)
    const effective = composite(strongBorder.color, face, strongBorder.alpha)
    check('accent-border-strong on accent-bg-subtle', wcagContrast(effective, face), 3.0)
  }

  // 10. theme 层 slot 对（shadcn 组件真实用法：ui/ 里的 text-destructive / muted-foreground / ring / input）
  {
    const pairs = [
      ['error-fg on bg-default (text-destructive)', '--mcs-error-fg', '--mcs-bg-default', 4.5],
      ['error-fg on bg-muted (text-destructive)', '--mcs-error-fg', '--mcs-bg-muted', 4.5],
      ['error-fg on bg-emphasis (text-destructive)', '--mcs-error-fg', '--mcs-bg-emphasis', 4.5],
      ['text-muted on bg-emphasis (muted-foreground)', '--mcs-text-muted', '--mcs-bg-emphasis', 4.5],
      ['text-default on bg-hover (accent-foreground)', '--mcs-text-default', '--mcs-bg-hover', 4.5],
      ['focus-ring on bg-emphasis (ring)', '--mcs-focus-ring', '--mcs-bg-emphasis', 3.0],
      ['border-default on bg-emphasis (input)', '--mcs-border-default', '--mcs-bg-emphasis', 3.0],
    ]
    for (const [label, a, b, need] of pairs) check(label, contrastVarPair(a, b, vars), need)
  }
}

console.log(`\n──────────────────────────────`)
console.log(`共校验 ${checks} 组合，失败 ${failures}`)
if (failures > 0) {
  console.error('✗ 存在对比度不达标的 token 组合，禁止合并（设计规范 §4.8-1）')
  process.exit(1)
}
console.log('✓ 全部组合达标（明暗主题独立验证）')
