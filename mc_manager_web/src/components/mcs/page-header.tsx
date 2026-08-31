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
}

export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <header
      className={cn(
        'flex shrink-0 items-center justify-between gap-3',
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="text-mcs-xl font-semibold text-mcs-text-default">{title}</h2>
        {description != null && (
          <p className="text-mcs-xs text-mcs-text-subtle">{description}</p>
        )}
      </div>
      {actions != null && <div className="shrink-0">{actions}</div>}
    </header>
  )
}
