import { Component, type ReactNode, type ErrorInfo } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface ErrorBoundaryProps {
  children: ReactNode
  /** 路由级使用时提供重置回调，避免整页刷新 */
  onReset?: () => void
}

interface ErrorBoundaryState {
  hasError: boolean
}

/**
 * ErrorBoundary —— 渲染异常兜底
 * 捕获子组件树渲染期间的同步/异步异常，展示降级 UI 替代白屏。
 * 路由级包裹 <Outlet /> 时通过 onReset 重置路由状态；
 * 顶层兜底仅提供刷新按钮。
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  private handleReset = () => {
    this.setState({ hasError: false })
    this.props.onReset?.()
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-full min-h-50 flex-col items-center justify-center gap-4 p-8">
          <AlertTriangle className="size-8 text-mcs-error-fg" aria-hidden="true" />
          <p className="text-center text-mcs-sm text-mcs-text-muted">
            页面渲染出现异常，请尝试重新加载
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={this.handleReset}
          >
            重新加载
          </Button>
        </div>
      )
    }

    return this.props.children
  }
}
