import { Loader2 } from 'lucide-react'

/**
 * PageLoader —— 路由懒加载 Suspense fallback
 * 居中转圈占位（实底，玻璃禁区）
 */
export function PageLoader() {
  return (
    <div
      className="flex h-dvh items-center justify-center bg-mcs-bg-default"
      role="status"
      aria-label="页面加载中"
    >
      <Loader2 className="size-6 animate-spin text-mcs-text-muted" aria-hidden />
    </div>
  )
}
