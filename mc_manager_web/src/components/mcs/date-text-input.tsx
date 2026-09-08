/**
 * DateTextInput —— 日期输入（ISO yyyy-MM-dd，键入 + 日历双模）
 * 替代原生 <input type="date">：Chrome 等浏览器下原生控件的占位与日历面板
 * 语言跟随浏览器 UI 语言（zh-CN 页面出 mm/dd/yyyy 英文占位），中英混排无法本地化。
 * 日历走自建 token 化月历面板（DatePickerCalendar），不引第三方 UI 库。
 * 行为：数字输入自动分段（202697 → 2026-09-07 补零）；完整合法值即上抛
 * （末位日期只键入一位时延到键入完或失焦），输入中/不完整仅本地草稿显示不通知父级，
 * 失焦回退到已提交值。
 */
import { useState } from 'react'
import { CalendarDays } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { DatePickerCalendar } from '@/components/mcs/date-picker-calendar'
import { cn } from '@/lib/utils'

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** 数字串 → 自动分段日期草稿（最多 8 位数字；月/日段补零）
 *  已知歧义：两位月份优先（`2026115` 判为 11 月 5 日而非 1 月 15 日），日历弹层为无歧义路径 */
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
  const [open, setOpen] = useState(false)
  const shown = draftDigits != null ? normalizeDateDigits(draftDigits) : value
  // 仅「已输满 8 位但日历非法」算错误态：键入中途标红会把「未输完」误报为错误，且逐键闪红框
  const draftInvalid = draftDigits != null && draftDigits.length === 8 && !isCompleteIsoDate(shown)
  const active = value !== ''

  /** 日历选定/清除与键入共用同一上抛口径：清草稿、上抛、收起弹层 */
  function commit(iso: string) {
    setDraftDigits(null)
    onChange(iso)
    setOpen(false)
  }

  return (
    <div className="relative inline-flex">
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
          // 按「新值与当前显示的关系」分类，不能只比长度：粘贴/输入法会一次性送来整串，
          // 只看长度会把整串替换误判成末端追加或删除，静默保留旧值片段（2026-09-15 全选粘 2025 → 2026）
          let nextDigits: string
          if (rawInput.startsWith(shown) && inputDigits.length >= shownDigits.length) {
            // 末端追加：新增的数字才是用户键入的（显示里补出的 0 不属于输入）
            nextDigits = (base + inputDigits.slice(shownDigits.length)).slice(0, 8)
          } else if (shown.startsWith(rawInput) && inputDigits.length < shownDigits.length) {
            // 末端删除：从原始数字缓冲扣掉，避免把补零位当成用户输入
            nextDigits = base.slice(0, Math.max(0, base.length - (shownDigits.length - inputDigits.length)))
          } else {
            // 整串替换（全选重输/粘贴/输入法上屏）：以新数字串为准
            nextDigits = inputDigits.slice(0, 8)
          }
          const next = normalizeDateDigits(nextDigits)
          setDraftDigits(nextDigits)
          // 末位日期只键入一位时（7 位数字）补零显示可能还会被下一位改写，先不上抛，等键入完或失焦
          const pendingDayDigit =
            rawInput.startsWith(shown) && inputDigits.length === shownDigits.length + 1 && nextDigits.length === 7
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
        className={cn(
          'pr-8 w-36 text-mcs-xs',
          // 与 FilterSelect 同款「筛选生效可见」激活态；边界用强档 accent（弱档亮色仅 1.10:1，不达交互边界 ≥3:1）
          active && !draftInvalid && 'border-mcs-accent-border-strong bg-mcs-accent-bg-subtle text-mcs-accent-fg',
          className,
        )}
      />

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="打开日历"
            aria-expanded={open}
            aria-haspopup="dialog"
            className={cn(
              'absolute top-1/2 right-1 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-mcs-xs transition-colors hover:bg-mcs-bg-hover focus-visible:outline-2 focus-visible:outline-mcs-focus-ring',
              active ? 'text-mcs-accent-fg' : 'text-mcs-text-subtle hover:text-mcs-text-default',
            )}
          >
            <CalendarDays className="size-3.5" aria-hidden />
          </button>
        </PopoverTrigger>
        <PopoverContent
          className="w-auto p-2"
          // 焦点交给面板内部的日期格（roving tabindex），避免 Radix 默认落焦到弹层容器
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <DatePickerCalendar value={value} onSelect={commit} onClear={() => commit('')} />
        </PopoverContent>
      </Popover>
    </div>
  )
}
