/**
 * token 色彩生成脚本
 * 用法：node tools/dev/gen-token-colors.mjs
 * 职责：hex → OKLCH 精确值；暗色中性阶梯按定值 L/C 输出对照表；
 *      状态色容器底 12% 混合对照。只打印，不写文件；人工核对后写入
 *      apps/web/src/styles/tokens/reference.css。
 */
import { oklch, wcagLuminance, wcagContrast } from 'culori'

// ── 色值定值 ────────────────────────────────────────────────
const DARK_BASE = '#050A1C' // 暗色基面（状态 tint 锚点）
const DARK_H = 269.37
// 暗色中性阶梯：L 逐档上行，C 随明度同步略升（低色度在暗部会读成灰）
const DARK_TIERS = {
  inset: { l: 0.09, c: 0.035 },
  canvas: { l: 0.13, c: 0.038 },
  base: { l: 0.15, c: 0.04 },
  card: { l: 0.205, c: 0.042 },
  secondary: { l: 0.245, c: 0.044 },
  popover: { l: 0.285, c: 0.046 },
}
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

const fmt = (c) => {
  const { l, c: cc, h } = oklch(c)
  const hh = h === undefined || Number.isNaN(h) ? 'none' : h.toFixed(2)
  return `oklch(${l.toFixed(4)} ${cc.toFixed(4)} ${hh})`
}

// ── 暗色中性阶梯 ────────────────────────────────────────────
console.log('\n== 暗色中性阶梯（H=269.37，C 随 L 上行）==')
for (const [key, { l, c }] of Object.entries(DARK_TIERS)) {
  const color = { mode: 'oklch', l, c, h: DARK_H }
  console.log(
    `${key.padEnd(10)} ${fmt(color)}  L=${l} C=${c} 相对亮度=${wcagLuminance(color).toFixed(4)}`,
  )
}

// ── 文字三级（暗底对比度实测）─────────────────────────────────
console.log(`\n== 文字三级（相对暗底 ${DARK_BASE} 对比度）==`)
for (const [i, hex] of TEXT_DARK.entries()) {
  const name = ['default', 'muted', 'subtle(禁用/占位)'][i]
  console.log(
    `text-${name.padEnd(16)} ${hex} -> ${fmt(hex)}  对比度=${wcagContrast(hex, DARK_BASE).toFixed(2)}:1`,
  )
}

// ── 状态六色 ────────────────────────────────────────────────
console.log('\n== 状态六色（相对暗底对比度 + 12% 容器底）==')
const base = oklch(DARK_BASE)
for (const [name, hex] of Object.entries(STATUS)) {
  const s = oklch(hex)
  const contrast = wcagContrast(hex, DARK_BASE)
  const dh = ((s.h - base.h + 540) % 360) - 180
  const tint = {
    mode: 'oklch',
    l: 0.12 * s.l + 0.88 * base.l,
    c: 0.12 * s.c + 0.88 * base.c,
    h: (base.h + dh * 0.12 + 360) % 360,
  }
  console.log(`${name.padEnd(10)} ${hex} -> ${fmt(hex)}  对比度=${contrast.toFixed(2)}:1`)
  console.log(`          容器底 ${fmt(tint)}（色 12% 混基面）`)
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
