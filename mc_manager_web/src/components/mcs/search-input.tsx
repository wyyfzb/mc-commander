import { useEffect, useRef, useCallback, type ChangeEvent } from 'react'
import { Search, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/**
 * SearchInput —— 统一搜索框（全站收编，消灭散装实现）
 * - 左侧 Search 图标 + 可选右侧清除按钮
 * - 可选内置防抖（onDebouncedChange）
 * - 支持 default / sm 两种尺寸
 * - 全部 --mcs-* token
 */
interface SearchInputProps {
  value: string
  onValueChange: (value: string) => void
  placeholder?: string
  'aria-label'?: string
  /** 防抖延迟（ms）；提供后启用 onDebouncedChange 回调 */
  debounceMs?: number
  /** 防抖后的值变化回调（用于 API 搜索等） */
  onDebouncedChange?: (debouncedValue: string) => void
  /** 是否显示清除按钮（默认 true） */
  clearable?: boolean
  className?: string
  inputClassName?: string
  size?: 'default' | 'sm'
  testId?: string
}

const SIZE_STYLES = {
  default: { input: 'h-10 pl-8', icon: 'size-3.5', iconPos: 'left-2.5', clear: 'right-2' },
  sm: { input: 'h-7 pl-7 text-mcs-xs', icon: 'size-3', iconPos: 'left-2', clear: 'right-2' },
} as const

export function SearchInput({
  value,
  onValueChange,
  placeholder,
  'aria-label': ariaLabel = '搜索',
  debounceMs,
  onDebouncedChange,
  clearable = true,
  className,
  inputClassName,
  size = 'default',
  testId,
}: SearchInputProps) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const s = SIZE_STYLES[size]

  const handleChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const next = e.target.value
      onValueChange(next)
      if (debounceMs != null && onDebouncedChange) {
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => onDebouncedChange(next.trim()), debounceMs)
      }
    },
    [onValueChange, debounceMs, onDebouncedChange],
  )

  const handleClear = useCallback(() => {
    onValueChange('')
    if (debounceMs != null && onDebouncedChange) {
      if (timerRef.current) clearTimeout(timerRef.current)
      onDebouncedChange('')
    }
  }, [onValueChange, debounceMs, onDebouncedChange])

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const prClass = value && clearable ? 'pr-8' : ''

  return (
    <div className={cn('relative', className)}>
      <Search
        className={cn(
          'pointer-events-none absolute top-1/2 -translate-y-1/2 text-mcs-text-muted',
          s.icon,
          s.iconPos,
        )}
        aria-hidden
      />
      <Input
        value={value}
        onChange={handleChange}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className={cn(s.input, prClass, inputClassName)}
        data-testid={testId}
      />
      {value && clearable && (
        <button
          type="button"
          onClick={handleClear}
          aria-label="清空搜索"
          className={cn(
            'absolute top-1/2 -translate-y-1/2 rounded-mcs-xs p-0.5 text-mcs-text-muted hover:bg-mcs-state-hover hover:text-mcs-text-default',
            s.clear,
          )}
        >
          <X className="size-3.5" aria-hidden />
        </button>
      )}
    </div>
  )
}
