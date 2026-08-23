import { Construction } from 'lucide-react'

/**
 * PagePlaceholder —— 占位页（骨架）
 * 显示目标标注，待替换为真实实现
 */
interface PagePlaceholderProps {
  title: string
  description: string
  milestone: string
}

export function PagePlaceholder({ title, description, milestone }: PagePlaceholderProps) {
  return (
    <div className="flex flex-col gap-3 p-8">
      <h1 className="text-mcs-xl font-semibold">{title}</h1>
      <p className="max-w-xl text-mcs-text-muted">{description}</p>
      <p className="mt-4 inline-flex w-fit items-center gap-2 rounded-mcs-sm bg-mcs-info-bg-subtle px-3 py-1.5 text-mcs-xs text-mcs-info-fg">
        <Construction className="size-3.5" aria-hidden />
        {milestone} 实现
      </p>
    </div>
  )
}
