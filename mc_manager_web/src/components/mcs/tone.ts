/**
 * 语义色三件套的单一词表（全 `--mcs-*` token）。
 *
 * 标签类组件的口径：只读状态用 `StatusPill`、可交互/通用标签用 `Chip`
 * （见 AGENTS.md「标签与状态展示」）。图标底块、提示条、通知气泡、徽章这类
 * 「不套组件、直接着色」的地方也必须从这里取色，不得就地在 feature 里手写。
 *
 * 中性档（default/muted）**不在此表**：各站的「无状态」底分别是
 * `bg-mcs-bg-default` / `bg-mcs-bg-subtle` / `bg-mcs-bg-secondary`，
 * 是刻意的视觉层级差异，统一属设计决策，不由本模块代劳。
 *
 * 注意 `toneClasses()` 的输出含 `text-mcs-*-fg`，而本仓 `cn` 走 twMerge，
 * 会把未知 `text-*` 归入字号档——与 `text-mcs-xs` 等尺寸类同元素混用会互相吞掉
 * （见 chip.tsx 顶部注释）。**新增着色点请用 `clsx`**，或保证同一 `cn` 里没有其它
 * `text-*`。存量仍有多处 `cn` 与尺寸档同串：修它会让字号恢复为设计值（可见变化），
 * 需单独一批配视觉复核，故未混入本次收编。
 */

/** 语义档（六色）：有明确成败/告警含义，需要底+边+前景三者同色系 */
export const SEMANTIC_TONES = ['accent', 'success', 'warning', 'error', 'info', 'purple'] as const

export type SemanticTone = (typeof SEMANTIC_TONES)[number]

export interface ToneClasses {
  /** 前景（文字/图标） */
  text: string
  /** 不透明内容面 tint（承载文字，禁用半透明） */
  bg: string
  /** 同色系描边 */
  border: string
}

export const SEMANTIC_TONE_CLASSES: Record<SemanticTone, ToneClasses> = {
  accent: {
    text: 'text-mcs-accent-fg',
    bg: 'bg-mcs-accent-bg-subtle',
    border: 'border-mcs-accent-border',
  },
  success: {
    text: 'text-mcs-success-fg',
    bg: 'bg-mcs-success-bg-subtle',
    border: 'border-mcs-success-border',
  },
  warning: {
    text: 'text-mcs-warning-fg',
    bg: 'bg-mcs-warning-bg-subtle',
    border: 'border-mcs-warning-border',
  },
  error: {
    text: 'text-mcs-error-fg',
    bg: 'bg-mcs-error-bg-subtle',
    border: 'border-mcs-error-border',
  },
  info: {
    text: 'text-mcs-info-fg',
    bg: 'bg-mcs-info-bg-subtle',
    border: 'border-mcs-info-border',
  },
  purple: {
    text: 'text-mcs-purple-fg',
    bg: 'bg-mcs-purple-bg-subtle',
    border: 'border-mcs-purple-border',
  },
}

/**
 * 三件套拼接串（图标底块、徽章等整体着色处）。
 * 类名仍是字面量（本文件静态可见），Tailwind 能扫到，不是运行时拼类名。
 */
export function toneClasses(tone: SemanticTone): string {
  const c = SEMANTIC_TONE_CLASSES[tone]
  return `${c.border} ${c.bg} ${c.text}`
}

/** 只要描边+前景、不要填充的形状（StatusPill outline 变体） */
export function toneOutlineClasses(tone: SemanticTone): string {
  const c = SEMANTIC_TONE_CLASSES[tone]
  return `${c.border} ${c.text}`
}
