import type { ComponentProps } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * LoadingButton —— 统一加载态按钮（全站收编，消灭散装 spinner/处理中）
 * - loading=true: 自动禁用 + 显示 Loader2 旋转图标
 * - loadingText: 加载时替换 children 文本（用于「处理中…」「备份中...」等）
 * - 不传 loadingText: Loader2 前缀 + 保留原 children（操作图标 + 文案不变）
 * - 继承 Button 全部 props（variant/size/className 等）
 * - 全部 --mcs-* token
 */
interface LoadingButtonProps extends ComponentProps<typeof Button> {
  loading?: boolean
  /** 加载时显示的文案；提供后替换全部 children，否则在 children 前插入 spinner */
  loadingText?: string
}

export function LoadingButton({ loading = false, loadingText, children, disabled, ...rest }: LoadingButtonProps) {
  return (
    <Button disabled={disabled || loading} {...rest}>
      {loading && <Loader2 className="mr-1.5 size-3.5 animate-spin" aria-hidden />}
      {loading && loadingText ? loadingText : children}
    </Button>
  )
}
