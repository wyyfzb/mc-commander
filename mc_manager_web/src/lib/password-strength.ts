/**
 * 密码强度评估（纯逻辑，登录页/账号面板共用，vitest 可测）
 * 服务端硬性规则仅长度 8–128（routes/auth.js PASSWORD_MIN/MAX）；
 * 前端强度条为引导性提示（鼓励混合字符），不阻塞提交——最终校验在服务端
 */

export type StrengthScore = 0 | 1 | 2 | 3 | 4

export interface PasswordStrength {
  score: StrengthScore
  /** 中文强度标签（0=未满足最低长度） */
  label: string
}

/** 常见弱口令片段黑名单（子串命中即降级，覆盖 top 常见密码词根） */
const WEAK_FRAGMENTS = [
  'password',
  '123456',
  'qwerty',
  'admin',
  'minecraft',
  'letmein',
  'welcome',
  'iloveyou',
  '111111',
  '88888888',
  'abc123',
]

/**
 * 评估密码强度（0–4 分）：
 * - 0：低于 8 位（服务端会拒绝）
 * - 1：长度达标但过于简单（纯单一字符类 / 命中弱口令词根）
 * - 2：两类字符组合
 * - 3：三类字符组合，或长度 ≥12 的两类组合
 * - 4：三类以上组合且长度 ≥12
 */
export function assessPasswordStrength(pw: string): PasswordStrength {
  if (pw.length < 8) return { score: 0, label: '至少 8 位' }

  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((r) => r.test(pw)).length
  const hasWeakFragment = WEAK_FRAGMENTS.some((frag) => pw.toLowerCase().includes(frag))

  // 重复模式降级：单一字符重复 ≥6（如 aaaaaaaa、88888888）
  const isRepetitive = /^(.)\1{5,}$/.test(pw) || /(.)\1\1\1/.test(pw)

  let score: StrengthScore
  if (classes <= 1 || hasWeakFragment || isRepetitive) {
    score = 1
  } else if (classes === 2) {
    score = pw.length >= 12 ? 3 : 2
  } else {
    score = pw.length >= 12 ? 4 : 3
  }

  const labels = ['', '过弱', '一般', '良好', '很强'] as const
  return { score, label: labels[score] }
}

/** 强度条配色（4 段；score 决定填充段数与色阶） */
export const STRENGTH_BAR_STYLES: string[] = [
  'bg-mcs-border-muted',
  'bg-red-500',
  'bg-amber-500',
  'bg-emerald-500',
  'bg-emerald-600',
]

/** 强度标签配色 */
export const STRENGTH_TEXT_STYLES: string[] = [
  'text-mcs-text-subtle',
  'text-red-600 dark:text-red-400',
  'text-amber-600 dark:text-amber-400',
  'text-emerald-600 dark:text-emerald-400',
  'text-emerald-700 dark:text-emerald-400',
]
