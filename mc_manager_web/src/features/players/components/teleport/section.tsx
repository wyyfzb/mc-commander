import type { ReactNode } from 'react'

/** Tab 内分区容器：小标题 + 内容列 */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h4 className="text-mcs-xs font-medium text-mcs-text-muted">{title}</h4>
      {children}
    </div>
  )
}
