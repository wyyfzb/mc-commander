/**
 * DataTableShell —— 统一表格外壳
 * 提供容器、加载态、空态、错误态；表头始终可见。
 * 三态视觉复用 data-states 共享组件（与列表页一致）。
 * header: <thead>（始终渲染）
 * children: <tbody>（仅数据就绪时渲染）
 */
import type { ReactNode, Ref } from 'react'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'
import { Card } from '@/components/mcs/card'
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
  /** 空态操作区（如「清空筛选」；渲染在文案下方） */
  emptyActions?: ReactNode
  /** 骨架行数量 */
  skeletonRows?: number
  /** 骨架列宽度 class 数组 */
  skeletonWidths?: string[]
  /** 分页配置（不传则不显示分页） */
  pagination?: PaginationProps
  /** 滚动容器（壳内卡片面）引用；虚滚动等需要拿到滚动元素的调用点使用 */
  scrollRef?: Ref<HTMLElement>
  /** 表格元素附加类（如 table-fixed），合并到壳的 w-full text-mcs-sm 基础配方上 */
  tableClassName?: string
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

function EmptyRow({
  colSpan,
  text,
  actions,
}: {
  colSpan: number
  text: string
  actions?: ReactNode
}) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-8">
        <EmptyStateVisual text={text} actions={actions} />
      </td>
    </tr>
  )
}

function SkeletonRow({ colSpan, widths }: { colSpan: number; widths: string[] }) {
  return (
    <tr className="border-b border-mcs-border-muted last:border-b-0" aria-hidden>
      {Array.from({ length: colSpan }, (_, i) => (
        <td key={i} className="px-3 py-2">
          {/* 宽度按类名下发（props 契约即「宽度 class 数组」）；塞进 style 会被浏览器当非法值丢弃 */}
          <Skeleton className={cn('h-3.5', widths[i] ?? 'w-24')} />
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
  emptyActions,
  skeletonRows = 5,
  skeletonWidths,
  pagination,
  scrollRef,
  tableClassName,
  className,
}: DataTableShellProps) {
  const widths = skeletonWidths ?? Array(columns).fill('w-24')

  return (
    /* 壳根保留 flex-1：它给下面的 `min()` 下限与 `max-h-full` 提供确定的高度参照
       （父级由页面给满高），同时让行数多时（pageSize=-1 走虚拟滚动）表格仍能被
       约束在可用高度内滚动。收缩的是**内层卡片**——见下面 Card 的注释。 */
    <div className={className ?? 'flex min-h-0 flex-1 flex-col'}>
      {/* 表格外壳即卡片面：走 Card 基座，滚动与伸缩留给调用点。
          按内容收缩：行数少时（2-10 人服的默认形态）卡片不再吃满剩余高度。
          实测 1440x900 下玩家表内容 237px / 壳 606px、审计页 235px / 618px，
          即约 370-383px 是纯空面板，会被读成「还没加载完」。
          不写 flex-1 ⇒ flex-basis auto 按内容定高（空间充裕时即收缩到内容高）。

          下限取 `min(160px, 100%)` 而非固定 `min-h-40`：固定下限在**短视口**下
          （实测 667x375 手机横屏、1440x400/430）不肯退让，卡片会溢出 flex 父级并盖住
          其后的兄弟节点——玩家页的分页器与「显示全部列」开关实测由可点变点击失败。
          取 min() 后下限随可用高收缩，既不挤掉兄弟也不会把表格压成一条线。
          **overflow-auto 必须保留**：摘掉会让 sticky 表头改为对 main 吸顶
          （滚动容器变了），行为变更。 */}
      <Card
        as="div"
        ref={scrollRef}
        size="flush"
        className="min-h-[min(10rem,100%)] max-h-full overflow-auto"
      >
        <table className={cn('w-full text-mcs-sm', tableClassName)}>
          {header}
          {isLoading ? (
            <tbody>
              {Array.from({ length: skeletonRows }, (_, i) => (
                <SkeletonRow key={i} colSpan={columns} widths={widths} />
              ))}
            </tbody>
          ) : error ? (
            <tbody>
              <ErrorRow colSpan={columns} error={error} />
            </tbody>
          ) : isEmpty ? (
            <tbody>
              <EmptyRow colSpan={columns} text={emptyText} actions={emptyActions} />
            </tbody>
          ) : (
            children
          )}
        </table>
      </Card>
      {pagination && <Pagination {...pagination} />}
    </div>
  )
}
