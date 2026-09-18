import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AppShell } from '../app-shell'
import { useUiStore } from '@/stores/ui'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'

/** Escape 关闭行为验证 */
function renderShell(initialPath = '/dashboard') {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        Component: AppShell,
        children: [{ path: 'dashboard', element: <div>仪表盘占位</div> }],
      },
    ],
    { initialEntries: [initialPath] },
  )
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>,
  )
}

describe('命令面板 Escape 关闭', () => {
  beforeEach(() => {
    localStorage.clear()
    useUiStore.setState({ theme: 'dark', sidebarCollapsed: false, commandPaletteOpen: false })
    useConnectionStore.setState({ baseUrl: '', apiKey: '', status: 'unconfigured' })
    useServerStore.setState({ status: null, systemStats: null, instanceId: null, socketConnected: false, lastStatusEvent: null })
  })

  it('Escape 关闭已打开的命令面板', async () => {
    renderShell()
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    const input = await screen.findByPlaceholderText('输入页面名称或命令…')
    expect(input).toBeInTheDocument()

    // 面板内 input 上按 Escape（真实用户场景：焦点在搜索框）
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(useUiStore.getState().commandPaletteOpen).toBe(false)
  })
})
