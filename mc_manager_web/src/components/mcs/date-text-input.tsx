/**
 * DateTextInput —— 日期文本输入（ISO yyyy-MM-dd）
 * 替代原生 <input type="date">：Chrome 等浏览器下原生控件的占位与日历面板
 * 语言跟随浏览器 UI 语言（zh-CN 页面出 mm/dd/yyyy 英文占位），中英混排无法本地化；
 * 且引入日历弹层组件违反「禁未 token 化第三方 UI」纪律。
 * 行为：数字输入自动分段（202697 → 2026-09-07 补零）；完整合法值即上抛
 * （末位日期只键入一位时延到键入完或失焦），输入中/不完整仅本地草稿显示不通知父级，
 * 失焦回退到已提交值。
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
  const rest = digits.slice(4)
  // 年份之后的前两位超出 12 即判定为「省了前导零的一位月份 + 日期」（202697 = 2026-09-07），
  // 否则按两位月份解析（202609 = 2026-09）；不这样区分则 202697 会被当成非法月份 97
  const twoDigitMonth = rest.length >= 2 && Number(rest.slice(0, 2)) <= 12
  const m = twoDigitMonth ? rest.slice(0, 2) : rest.slice(0, 1)
  const d = rest.slice(m.length, m.length + 2)
  const parts = [y]
  if (m) parts.push(m.padStart(2, '0'))
  if (d) parts.push(d.padStart(2, '0'))
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
  // 草稿真源是「用户键入的原始数字」而非显示值：显示值会补零，若以显示值为下一次键入的基串，
  // 补出的 0 会被当成用户输入，两位月份/两位日期就永远输不进来（20261007 会落到 2026-01-00）
  const [draftDigits, setDraftDigits] = useState<string | null>(null)
  const shown = draftDigits != null ? normalizeDateDigits(draftDigits) : value
  const draftInvalid = draftDigits != null && draftDigits !== '' && !isCompleteIsoDate(shown)
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
        const rawInput = e.target.value
        if (rawInput === '') {
          setDraftDigits('')
          onChange('')
          return
        }
        const inputDigits = rawInput.replace(/\D/g, '')
        const shownDigits = shown.replace(/\D/g, '')
        const base = draftDigits ?? shownDigits
        const nextDigits =
          inputDigits.length > shownDigits.length
            ? (base + inputDigits.slice(shownDigits.length)).slice(0, 8)
            : inputDigits.length < shownDigits.length
              ? base.slice(0, Math.max(0, base.length - (shownDigits.length - inputDigits.length)))
              : inputDigits.slice(0, 8)
        const next = normalizeDateDigits(nextDigits)
        setDraftDigits(nextDigits)
        // 末位日期只键入一位时（7 位数字）补零显示可能还会被下一位改写，先不上抛，等键入完或失焦
        const pendingDayDigit = inputDigits.length === shownDigits.length + 1 && nextDigits.length === 7
        if (next === '' || (isCompleteIsoDate(next) && !pendingDayDigit)) onChange(next)
      }}
      onBlur={() => {
        if (draftDigits != null && draftDigits !== '') {
          // 补零后完整即上抛（含被 pendingDayDigit 压住的草稿）；不完整草稿回退已提交值
          if (isCompleteIsoDate(shown)) {
            if (shown !== value) onChange(shown)
          } else {
            onChange(value)
          }
        }
        setDraftDigits(null)
      }}
      className={cn('w-36 text-mcs-xs', className)}
    />
  )
}
