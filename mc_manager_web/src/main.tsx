import { StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from 'react-router/dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster, toast } from 'sonner'
import { PageLoader } from '@/components/mcs/page-loader'
import { ErrorBoundary } from '@/components/mcs/error-boundary'
import { ThemeClassSync } from '@/layouts/theme-class-sync'
import { startNotificationCleanupTimer } from '@/stores/notifications'
import { useUiStore } from '@/stores/ui'
import './index.css'
import { router } from './routes'

// 通知内存 5 分钟周期裁剪（长会话内存收敛，M2 差异 #3）
startNotificationCleanupTimer()

// -- 全局运行时异常兜底（issue 333，audit F-P0-1 残留） --
// ErrorBoundary 仅捕获 React 组件树内的渲染异常；
// 以下兜底覆盖非 React 上下文的运行时错误（事件回调/定时器/异步代码），
// 在控制台记录详情的同时向用户展示中文提示与引导。
// toast 在事件触发时 React 已完成渲染，Toaster 组件已挂载，可安全调用。
window.addEventListener('error', (event) => {
  console.error('[Global onerror]', event.error)
  toast.error('页面发生未预期的错误，请尝试刷新页面或联系管理员')
})

window.addEventListener('unhandledrejection', (event) => {
  console.error('[Global unhandledrejection]', event.reason)
  toast.error('异步操作失败，请尝试刷新页面或联系管理员')
})

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,           // 网络抖动只重试一次，避免请求风暴
      refetchOnWindowFocus: false, // 管理面板不因切窗口打扰
      staleTime: 10_000,  // 10s 内视为新鲜（与 WS 事件互补失效）
    },
  },
})

/** Toaster 需跟随用户主题切换，提取为组件从 store 读取 theme */
function ThemedToaster() {
  const theme = useUiStore((s) => s.theme)
  return (
    <Toaster
      theme={theme}
      position="top-center"
      toastOptions={{
        classNames: {
          toast: 'bg-mcs-bg-emphasis! border-mcs-border-default! shadow-mcs-overlay!',
          // description 由调用方用 `\n` 拼多行明细（批量回执「• 目标：原因」、插件批量失败等），
          // 不给 pre-line 时 HTML 把换行折成空格，多条明细会挤成一行
          description: 'whitespace-pre-line',
        },
      }}
    />
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeClassSync />
      <TooltipProvider delayDuration={300}>
        <ErrorBoundary>
          <Suspense fallback={<PageLoader />}>
            <RouterProvider router={router} />
          </Suspense>
        </ErrorBoundary>
        <ThemedToaster />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
)
