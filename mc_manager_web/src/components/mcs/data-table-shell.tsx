/**
 * DataTableShell —— 统一表格外壳
 * 提供容器、加载态、空态、错误态；表头始终可见。
 * 三态视觉复用 data-states 共享组件（与列表页一致）。
 * header: <thead>（始终渲染）
 * children: <tbody>（仅数据就绪时渲染）
 */
import type { ReactNode } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyStateVisual, ErrorStateVisual } from '@/components/mcs/data-states'
import { Pagination, type PaginationProps } from '@/components/mcs/pagination'

export interface DataTableShellProps {
  /** 表头（<thead>），始终渲染 */
  header: ReactNode
  /** 表体（<tbody>），仅数据就绪时渲染 */
  children: ReactNode
  /** 列数（用于 skeleton/空/错误行的 colSpan） */
  columns: number
  /** 加载中（显示骨架，表头保留） */
  isLoading?: boolean
  /** 错误对象（显示错误行） */
  error?: unknown
  /** 数据为空（显示空态行） */
  isEmpty?: boolean
  /** 空态文案 */
  emptyText?: string
  /** 骨架行数量 */
  skeletonRows?: number
  /** 骨架列宽度 class 数组 */
  skeletonWidths?: string[]
  /** 分页配置（不传则不显示分页） */
  pagination?: PaginationProps
  /** 自定义容器类名 */
  className?: string
}

function ErrorRow({ colSpan, error }: { colSpan: number; error: unknown }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-8">
        <ErrorStateVisual error={error} />
      </td>
    </tr>
  )
}

function EmptyRow({ colSpan, text }: { colSpan: number; text: string }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-8">
        <EmptyStateVisual text={text} />
      </td>
    </tr>
  )
}

function SkeletonRow({ colSpan, widths }: { colSpan: number; widths: string[] }) {
  return (
    <tr className="border-b border-mcs-border-muted last:border-b-0" aria-hidden>
      {Array.from({ length: colSpan }, (_, i) => (
        <td key={i} className="px-3 py-2">
          <Skeleton className="h-3.5" style={{ width: widths[i] ?? 'w-24' }} />
        </td>
      ))}
    </tr>
  )
}

export function DataTableShell({
  header,
  children,
  columns,
  isLoading = false,
  error,
  isEmpty = false,
  emptyText = '暂无记录',
  skeletonRows = 5,
  skeletonWidths,
  pagination,
  className,
}: DataTableShellProps) {
  const widths = skeletonWidths ?? Array(columns).fill('w-24')

  return (
    <div className={className ?? 'flex min-h-0 flex-1 flex-col'}>
      <div className="min-h-0 flex-1 overflow-auto rounded-mcs-md border border-mcs-border-muted">
        <table className="w-full text-mcs-sm">
          {header}
          {isLoading
            ? (<tbody>{Array.from({ length: skeletonRows }, (_, i) => (
                <SkeletonRow key={i} colSpan={columns} widths={widths} />
              ))}</tbody>)
            : error
              ? (<tbody><ErrorRow colSpan={columns} error={error} /></tbody>)
              : isEmpty
                ? (<tbody><EmptyRow colSpan={columns} text={emptyText} /></tbody>)
              : children}
        </table>
      </div>
      {pagination && <Pagination {...pagination} />}
    </div>
  )
}
