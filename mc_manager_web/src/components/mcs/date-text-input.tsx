/**
 * DateTextInput —— 日期文本输入（ISO yyyy-MM-dd）
 * 替代原生 <input type="date">：Chrome 等浏览器下原生控件的占位与日历面板
 * 语言跟随浏览器 UI 语言（zh-CN 页面出 mm/dd/yyyy 英文占位），中英混排无法本地化；
 * 且引入日历弹层组件违反「禁未 token 化第三方 UI」纪律。
 * 行为：数字输入自动分段（202697 → 2026-09-07 补零）；完整合法值即上抛，
 * 输入中/不完整仅本地草稿显示不通知父级，失焦回退到已提交值。
 */
import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** 数字串 → 自动分段日期草稿（最多 8 位数字；月/日段补零） */
export function normalizeDateDigits(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 8)
  if (digits.length === 0) return ''
  const y = digits.slice(0, 4)
  const m = (digits.slice(4, 6) || '').padEnd(digits.length > 4 ? 2 : 0, '0')
  const d = (digits.slice(6, 8) || '').padEnd(digits.length > 6 ? 2 : 0, '0')
  const parts = [y]
  if (digits.length > 4) parts.push(m)
  if (digits.length > 6) parts.push(d)
  return parts.join('-')
}

/** 完整且日历有效（Date.parse 兜月份越界，如 2026-02-31） */
export function isCompleteIsoDate(v: string): boolean {
  if (!ISO_DATE_RE.test(v)) return false
  const [y, m, d] = v.split('-').map(Number) as [number, number, number]
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

interface DateTextInputProps {
  /** '' 或 yyyy-MM-dd */
  value: string
  /** 仅在空串或完整合法日期时被调用 */
  onChange: (v: string) => void
  placeholder?: string
  ariaLabel: string
  className?: string
}

export function DateTextInput({ value, onChange, placeholder = '点击输入日期', ariaLabel, className }: DateTextInputProps) {
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? value
  const draftInvalid = draft != null && draft !== '' && !isCompleteIsoDate(draft)
  return (
    <Input
      type="text"
      inputMode="numeric"
      autoComplete="off"
      aria-label={ariaLabel}
      aria-invalid={draftInvalid || undefined}
      placeholder={placeholder}
      value={shown}
      onChange={(e) => {
        const next = e.target.value === '' ? '' : normalizeDateDigits(e.target.value)
        setDraft(next)
        if (next === '' || isCompleteIsoDate(next)) onChange(next)
      }}
      onBlur={() => {
        // 不完整草稿失焦：回退已提交值，避免 UI 与筛选状态不一致
        if (draft != null && draft !== '' && !isCompleteIsoDate(draft)) onChange(value)
        setDraft(null)
      }}
      className={cn('w-36 text-mcs-xs', className)}
    />
  )
}
