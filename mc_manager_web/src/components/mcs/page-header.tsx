import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * PageHeader —— 全站统一页头（标题 + 可选描述 + 可选操作区）
 * 收敛各页面手写 h2/description/actions 配方，保证间距、语义、布局一致。
 */

interface PageHeaderProps {
  /** 页面标题（纯文本或含动态内容的 ReactNode） */
  title: ReactNode
  /** 标题下方辅助说明行，省略则不渲染 */
  description?: ReactNode
  /** 右侧操作区（按钮组等），省略则不渲染 */
  actions?: ReactNode
  className?: string
  /**
   * 描述与标题同行的紧凑版式（截稿页用，如仪表盘——首屏高度要还给终端）。
   * 仅改排布不改字号档：标题仍 `xl`、描述仍 `xs`，信息不减少。
   * 窄屏（<640px）保持上下堆叠：标题+描述一行会挤压长描述的可读性。
   */
  inlineDescription?: boolean
}

export function PageHeader({
  title,
  description,
  actions,
  className,
  inlineDescription,
}: PageHeaderProps) {
  return (
    <header className={cn('flex shrink-0 items-center justify-between gap-3', className)}>
      <div
        className={cn(
          'min-w-0 flex flex-col',
          inlineDescription && 'sm:flex-row sm:items-baseline sm:gap-3',
        )}
      >
        <h2 className="text-mcs-xl font-semibold text-mcs-text-default">{title}</h2>
        {description != null && <p className="text-mcs-xs text-mcs-text-muted">{description}</p>}
      </div>
      {actions != null && <div className="shrink-0">{actions}</div>}
    </header>
  )
}
