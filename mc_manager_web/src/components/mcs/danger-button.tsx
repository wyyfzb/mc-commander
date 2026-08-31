import type { ComponentProps } from 'react'

import { Button } from '@/components/ui/button'

type DangerButtonProps = ComponentProps<typeof Button>

/**
 * DangerButton —— 破坏性操作按钮统一入口（roadmap A2 四件套收编）
 * - 固定 destructive variant，调用点不再散写 variant 字符串
 * - 危险按钮的语义扩展（确认前置、图标规范等）只需改此组件
 */
export function DangerButton({ className, ...props }: DangerButtonProps) {
  return <Button variant="destructive" className={className} {...props} />
}
