import { StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from 'react-router/dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from 'sonner'
import { PageLoader } from '@/components/mcs/page-loader'
import { startNotificationCleanupTimer } from '@/stores/notifications'
import './index.css'
import { router } from './routes'

// 通知内存 5 分钟周期裁剪（长会话内存收敛，M2 差异 #3）
startNotificationCleanupTimer()

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,           // 网络抖动只重试一次，避免请求风暴
      refetchOnWindowFocus: false, // 管理面板不因切窗口打扰
      staleTime: 10_000,  // 10s 内视为新鲜（与 WS 事件互补失效）
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={300}>
        <Suspense fallback={<PageLoader />}>
          <RouterProvider router={router} />
        </Suspense>
        <Toaster
          position="top-center"
          toastOptions={{
            classNames: {
              toast: 'glass-toast! border-mcs-border-default!',
            },
          }}
        />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
)
