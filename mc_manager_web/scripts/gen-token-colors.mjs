/**
 * token 色彩生成脚本（设计文档 2026-08-14-web-app-design.md §4.1）
 * 用法：node scripts/gen-token-colors.mjs
 * 职责：hex → OKLCH 精确值；暗色中性层级以 WCAG 相对亮度区间二分生成
 *      （固定 H/C 只步进 L）；状态色容器底 12% alpha 混合；全部输出对照表。
 * 结果人工核对后写入 src/styles/tokens/reference.css（本脚本为生成器，非运行时依赖）。
 */
import { oklch, wcagLuminance, wcagContrast } from 'culori'

// ── 设计文档 §4.1 定值 ────────────────────────────────────────
const DARK_BASE = '#0A0E1A' // 暗色基面（H≈220，偏蓝非纯黑）
// 文字三级（2026-08-14 对比度校验驱动修正：default 提亮保弹窗 ≥4.5；muted 提亮保全层 ≥3:1）
const TEXT_DARK = ['#EDF2F7', '#B8C4D4', '#64748B'] // default / muted / subtle
const STATUS = {
  success: '#4ADE80',
  warning: '#FBBF24',
  error: '#F87171',
  info: '#38BDF8',
  purple: '#A78BFA',
  orange: '#FB923C',
}
// 中性台阶：OKLCH L 步进（设计文档"明度 5-6% 基面"指 OKLCH L，非 WCAG 相对亮度）
// 基面 L=0.166 → 背景 0.19 → 卡片 0.235 → 悬浮 0.28 → 弹窗 0.325（固定 H/C，等距上行）
const TIER_L = {
  background: 0.19,
  card: 0.235,
  hover: 0.28,
  popover: 0.325,
}
// 装饰线参考 L 0.37（在卡片与弹窗之外，供 border 弱对比参考）
const BORDER_L = 0.37

const fmt = (c) => {
  const { l, c: cc, h } = oklch(c)
  const hh = h === undefined || Number.isNaN(h) ? 'none' : h.toFixed(2)
  return `oklch(${l.toFixed(4)} ${cc.toFixed(4)} ${hh})`
}

// ── 暗色中性层级（OKLCH L 步进）───────────────────────────────
const base = oklch(DARK_BASE)
console.log('== 暗色中性层级（H/C 固定 =', base.h.toFixed(2), base.c.toFixed(4), '）==')
console.log(
  `base       ${DARK_BASE} -> ${fmt(DARK_BASE)}  相对亮度=${wcagLuminance(DARK_BASE).toFixed(4)}`,
)
const tierOklch = {}
for (const [key, l] of Object.entries(TIER_L)) {
  const color = { mode: 'oklch', l, c: base.c, h: base.h }
  tierOklch[key] = color
  console.log(`${key.padEnd(10)} ${fmt(color)}  L=${l} 相对亮度=${wcagLuminance(color).toFixed(4)}`)
}
const border = { mode: 'oklch', l: BORDER_L, c: base.c, h: base.h }
console.log(
  `border      ${fmt(border)}  相对亮度=${wcagLuminance(border).toFixed(4)}（装饰线参考）`,
)

// ── 文字三级（暗底对比度实测）─────────────────────────────────
console.log('\n== 文字三级（相对暗底 #0A0E1A 对比度）==')
for (const [i, hex] of TEXT_DARK.entries()) {
  const name = ['default', 'muted', 'subtle(禁用/占位)'][i]
  console.log(
    `text-${name.padEnd(16)} ${hex} -> ${fmt(hex)}  对比度=${wcagContrast(hex, DARK_BASE).toFixed(2)}:1`,
  )
}

// ── 状态六色 ────────────────────────────────────────────────
console.log('\n== 状态六色（相对暗底对比度 + 12% 容器底）==')
for (const [name, hex] of Object.entries(STATUS)) {
  const contrast = wcagContrast(hex, DARK_BASE)
  const mix = { mode: 'oklch', ...oklch(hex), alpha: 0.12 }
  // 12% alpha 叠在基面上的等效实色（用于参考）
  const layered = {
    mode: 'oklch',
    l: base.l * (1 - 0.12) + oklch(hex).l * 0.12 * 0.12,
    c: oklch(hex).c * 0.12 * 0.4,
    h: oklch(hex).h,
  }
  console.log(`${name.padEnd(10)} ${hex} -> ${fmt(hex)}  对比度=${contrast.toFixed(2)}:1`)
  console.log(
    `          容器底 oklch(${mix.l.toFixed(4)} ${mix.c.toFixed(4)} ${mix.h.toFixed(2)} / 0.12)`,
  )
  void layered
}

// ── 亮色主题（独立映射，H=220 同色系）─────────────────────────
console.log('\n== 亮色主题（独立映射）==')
const LIGHT = {
  background: '#F7F9FC', // 极浅蓝白
  card: '#FFFFFF',
  popover: '#FFFFFF',
  'text-default': '#1E293B',
  'text-muted': '#475569',
  'accent-fg': '#16A34A', // 亮色模式品牌色降饱和 10-30%、提明度 5-10%（对比度验证用）
}
for (const [name, hex] of Object.entries(LIGHT)) {
  const bg = name.startsWith('text') ? '#FFFFFF' : LIGHT.background
  console.log(
    `${name.padEnd(14)} ${hex} -> ${fmt(hex)}  对白底对比度=${wcagContrast(hex, '#FFFFFF').toFixed(2)}:1`,
  )
  void bg
}
// 状态六色在亮色模式：换档不换色——保持色相、加深明度（社区实测 700 档），
// 白底 ≥4.5:1；暗色模式的高亮度色在白底无法达标（如 warning 1.9:1），必须独立映射
console.log('-- 状态色亮色变体（换档不换色：同色相加深，白底对比度 ≥4.5:1）--')
const STATUS_LIGHT_FG = {
  success: '#15803D', // green-700
  warning: '#B45309', // amber-700
  error: '#B91C1C', // red-700
  info: '#0369A1', // sky-700
  purple: '#6D28D9', // violet-700
  orange: '#C2410C', // orange-700
}
for (const [name, hex] of Object.entries(STATUS_LIGHT_FG)) {
  console.log(
    `${name.padEnd(10)} ${hex} -> ${fmt(hex)}  白底对比度=${wcagContrast(hex, '#FFFFFF').toFixed(2)}:1`,
  )
}
// 亮色 accent（品牌绿）：提明度降饱和做底色，深绿黑文字（on-accent 对比度验证）
console.log('-- 亮色 accent（品牌绿提明度降饱和做底 + 深绿黑文字）--')
const accentLight = '#86EFAC' // #4ADE80 提明度降饱和（green-300 系）
const onAccentLight = '#052E16'
console.log(`accent     ${accentLight} -> ${fmt(accentLight)}`)
console.log(
  `on-accent  ${onAccentLight} -> ${fmt(onAccentLight)}  对比度=${wcagContrast(onAccentLight, accentLight).toFixed(2)}:1`,
)
