/**
 * Pagination —— 统一分页组件
 * 支持两种模式：
 * - "numbers"：页码按钮 + 省略号 + 每页条数选择（客户端分页场景）
 * - "prev-next"：上一页/下一页按钮（服务端分页场景）
 */
import { useMemo } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/mcs/icon-button'

const DEFAULT_PAGE_SIZES = [10, 20, 50] as const

/** 生成带省略号的页码数组 */
function buildPageNumbers(current: number, total: number): Array<number | '…'> {
  const set = new Set([1, total, current - 1, current, current + 1])
  const sorted = [...set].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b)
  const withGaps: Array<number | '…'> = []
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i]! - sorted[i - 1]! > 1) withGaps.push('…')
    withGaps.push(sorted[i]!)
  }
  return withGaps
}

export interface PaginationProps {
  /** 当前页（1-based） */
  page: number
  /** 总页数 */
  totalPages: number
  /** 总条数（用于展示信息） */
  totalItems?: number
  /** 切换页码 */
  onPageChange: (page: number) => void
  /** 分页模式 */
  variant?: 'numbers' | 'prev-next'
  /** 翻页期间是否禁用按钮 */
  disabled?: boolean
  /** 每页条数选择（仅 numbers 模式） */
  pageSize?: number
  pageSizeOptions?: number[]
  onPageSizeChange?: (size: number) => void
  /** 显示「全部」选项（仅 numbers 模式） */
  showAllOption?: boolean
  /** 是否显示每页条数选择器（仅 numbers 模式） */
  showPageSizeSelector?: boolean
}

export function Pagination({
  page,
  totalPages,
  totalItems,
  onPageChange,
  variant = 'prev-next',
  disabled = false,
  pageSize,
  pageSizeOptions = DEFAULT_PAGE_SIZES as unknown as number[],
  onPageSizeChange,
  showAllOption = false,
  showPageSizeSelector = false,
}: PaginationProps) {
  const safePage = Math.max(1, Math.min(page, totalPages || 1))
  // 单页（含「全部」档、空结果）没有可翻的页：页码组与方向箭头只会暗示「还有别的页」，
  // 两种模式一并省略；左侧的条数/每页选择器保留——那是「全部」档切回分页的唯一入口
  const showPager = totalPages > 1

  // 页码模式：生成带省略号的页码
  const pageNumbers = useMemo(
    () => (variant === 'numbers' ? buildPageNumbers(safePage, totalPages) : []),
    [variant, safePage, totalPages],
  )

  return (
    <div className="flex flex-wrap items-center justify-between gap-y-2 border-t border-mcs-border-muted px-4 py-2">
      {/* flex-wrap（外层与左组各一层）与下方文案的 whitespace-nowrap 是一对：条数/页码的
          CJK 断行点落在任意字符间，不锁 nowrap 会在 375 下被逐字压成竖排；只锁 nowrap
          则 min-content 变成整行文案宽，把分页栏撑出横向溢出 */}
      {/* 左侧：信息 + 可选的每页条数 */}
      <div className="flex flex-wrap items-center gap-2 text-mcs-xs text-mcs-text-muted">
        {variant === 'numbers' && showPageSizeSelector && (
          <>
            每页
            <select
              value={String(pageSize)}
              onChange={(e) => onPageSizeChange?.(Number(e.target.value))}
              disabled={disabled}
              className="rounded-mcs-xs border border-mcs-border-default bg-mcs-bg-muted px-1.5 py-0.5 text-mcs-xs text-mcs-text-default"
              aria-label="每页行数"
            >
              {pageSizeOptions.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
              {showAllOption && <option value={-1}>全部</option>}
            </select>
          </>
        )}
        {totalItems != null ? (
          <span className="whitespace-nowrap">
            {showPager
              ? `共 ${totalItems} 条 · 第 ${safePage}/${totalPages} 页`
              : `共 ${totalItems} 条`}
          </span>
        ) : showPager ? (
          <span className="whitespace-nowrap">
            第 {safePage} / {totalPages} 页
          </span>
        ) : null}
      </div>

      {/* 右侧：翻页按钮 */}
      <div className="flex items-center gap-1.5">
        {variant === 'numbers' && showPager ? (
          <>
            <IconButton
              disabled={disabled || safePage <= 1}
              onClick={() => onPageChange(safePage - 1)}
              aria-label="上一页"
            >
              <ChevronLeft aria-hidden />
            </IconButton>
            {pageNumbers.map((n, i) =>
              n === '…' ? (
                <span key={`gap${i}`} className="px-1 text-mcs-xs text-mcs-text-muted">
                  …
                </span>
              ) : (
                <Button
                  key={n}
                  variant={safePage === n ? 'default' : 'ghost'}
                  size="icon-sm"
                  disabled={disabled}
                  onClick={() => onPageChange(n)}
                  // 当前页要有可编程判定的语义：底色只是视觉线索，读屏与弱视用户都拿不到
                  aria-current={safePage === n ? 'page' : undefined}
                  aria-label={`第 ${n} 页`}
                >
                  {n}
                </Button>
              ),
            )}
            <IconButton
              disabled={disabled || safePage >= totalPages}
              onClick={() => onPageChange(safePage + 1)}
              aria-label="下一页"
            >
              <ChevronRight aria-hidden />
            </IconButton>
          </>
        ) : variant !== 'numbers' && showPager ? (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={disabled || safePage <= 1}
              onClick={() => onPageChange(safePage - 1)}
            >
              上一页
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={disabled || safePage >= totalPages}
              onClick={() => onPageChange(safePage + 1)}
            >
              下一页
            </Button>
          </>
        ) : null}
      </div>
    </div>
  )
}
