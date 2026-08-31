/**
 * token 对比度批量校验（设计文档 §4.8-1，M1 出口二重审查）
 * 用法：node scripts/check-contrast.mjs
 * 标准：正文 ≥4.5:1 / 边框与焦点 ≥3:1 / 状态色对容器底 ≥3:1（WCAG 实测不取整）
 *      明暗主题独立验证；任一组合不达标 → exit 1（阻止合并）
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse, wcagContrast, rgb as toRgb } from 'culori'

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
  // color-mix(in oklch, <color> <pct>%, transparent) → alpha 合成用
  const mixMatch = value.match(/color-mix\(in oklch,\s*(.+?)\s+([\d.]+)%,\s*transparent\)/)
  if (mixMatch) {
    return { color: parse(mixMatch[1]), alpha: Number(mixMatch[2]) / 100 }
  }
  const c = parse(value)
  if (!c) throw new Error(`无法解析颜色: ${raw} -> ${value}`)
  return { color: c, alpha: 1 }
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
  return wcagContrast(a.color, b.color)
}

for (const [scopeName, vars] of [
  ['暗色', semanticScopes.root],
  ['亮色', semanticScopes.light],
]) {
  console.log(`\n════ ${scopeName}主题 ════`)
  void refVars

  // 1. 文字 × 背景（全层 ≥4.5:1，含 subtle）
  for (const textKey of ['text-default', 'text-muted', 'text-subtle']) {
    for (const bgKey of BG_KEYS) {
      const ratio = contrastVarPair(`--mcs-${textKey}`, `--mcs-${bgKey}`, vars)
      check(`${textKey} on ${bgKey}`, ratio, 4.5)
    }
  }

  // 2. 状态六色 fg × 背景（文字/描边场景全层 ≥4.5）
  for (const status of STATUS_KEYS) {
    for (const bgKey of BG_KEYS) {
      const ratio = contrastVarPair(`--mcs-${status}-fg`, `--mcs-${bgKey}`, vars)
      check(`${status}-fg on ${bgKey}`, ratio, 4.5)
    }
  }

  // 3. 状态色 fg × 自身容器底（合成后 ≥3:1，描边/图形最低标准）
  for (const status of STATUS_KEYS) {
    const fgRaw = vars.get(`--mcs-${status}-fg`)
    const bgSubRaw = vars.get(`--mcs-${status}-bg-subtle`)
    const fg = parseColor(fgRaw, vars, refVars)
    const bgSub = parseColor(bgSubRaw, vars, refVars)
    // 容器底本身是 alpha 色，叠在页面底上
    const bg = parseColor(vars.get('--mcs-bg-default'), vars, refVars)
    const effective = composite(fg.color, bg.color, bgSub.alpha)
    const ratio = wcagContrast(fg.color, effective)
    check(`${status}-fg on ${status}-bg-subtle`, ratio, 3.0)
  }

  // 4. on-accent × accent（CTA 按钮文字 ≥4.5）
  check('on-accent on accent', contrastVarPair('--mcs-on-accent', '--mcs-accent', vars), 4.5)

  // 5. accent-fg × 背景（accent 做文字/图标 ≥4.5）
  for (const bgKey of ['bg-default', 'bg-muted']) {
    const ratio = contrastVarPair('--mcs-accent-fg', `--mcs-${bgKey}`, vars)
    check(`accent-fg on ${bgKey}`, ratio, 4.5)
  }

  // 6. 边框 × 背景（交互边框 ≥3:1）
  for (const bgKey of ['bg-default', 'bg-muted']) {
    const ratio = contrastVarPair('--mcs-border-default', `--mcs-${bgKey}`, vars)
    check(`border-default on ${bgKey}`, ratio, 3.0)
  }

  // 7. 焦点环 × 背景（≥3:1，不透明；组件用 ring-ring 不透明焦点环，见 ui/* 组件）
  for (const bgKey of ['bg-default', 'bg-muted']) {
    const ratio = contrastVarPair('--mcs-focus-ring', `--mcs-${bgKey}`, vars)
    check(`focus-ring on ${bgKey}`, ratio, 3.0)
  }

  // 8. 维度三色 × 背景（8px 色点小图形 ≥3:1，WCAG 1.4.11 非文字图形标准）
  for (const dim of ['overworld', 'nether', 'end']) {
    for (const bgKey of ['bg-default', 'bg-muted', 'bg-subtle']) {
      const ratio = contrastVarPair(`--mcs-dimension-${dim}`, `--mcs-${bgKey}`, vars)
      check(`dimension-${dim} on ${bgKey}`, ratio, 3.0)
    }
  }
}

console.log(`\n──────────────────────────────`)
console.log(`共校验 ${checks} 组合，失败 ${failures}`)
if (failures > 0) {
  console.error('✗ 存在对比度不达标的 token 组合，禁止合并（设计规范 §4.8-1）')
  process.exit(1)
}
console.log('✓ 全部组合达标（明暗主题独立验证）')
