/**
 * GeneralPanel 测试：
 * - autoRestart 初始值（服务端值 / 无实例默认 true + 无实例提示）
 * - 切换成功：乐观翻转 + PUT {autoRestart} + 成功 toast + 值保持
 * - 失败回滚：错误 toast + 开关回到服务端值
 * - 序号守卫：陈旧失败不回滚不弹错（最新切换结果为准）
 * - 主题切换：Select 暗色/亮色 → ui store theme 更新
 * mock 数据为结构占位虚构，PUT 载荷为 {autoRestart} 白名单字段
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { Toaster, toast as sonnerToast } from 'sonner'
import { handlers, mockInstanceStatus } from '@/test/mocks/handlers'
import { GeneralPanel } from '../general-panel'
import { useServerStore } from '@/stores/server'
import { useConnectionStore } from '@/stores/connection'
import { useUiStore } from '@/stores/ui'

const server = setupServer(...handlers)
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())

// radix Select 依赖 Pointer Capture API（jsdom 未实现，缺失会崩溃；deploy-dialog 同款补丁）
if (typeof Element.prototype.hasPointerCapture !== 'function') {
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
}

function renderPanel() {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <GeneralPanel />
      <Toaster />
    </QueryClientProvider>,
  )
}

/** 成功信封（autoRestart 回显当前值） */
function okEnvelope(autoRestart: boolean) {
  return HttpResponse.json({
    status: 'ok',
    code: 0,
    message: 'Success',
    data: { ...mockInstanceStatus, autoRestart },
    timestamp: new Date().toISOString(),
  })
}

/** 失败信封（50000 服务器内部错误） */
function errorEnvelope() {
  return HttpResponse.json(
    {
      status: 'error',
      code: 50000,
      message: 'internal error',
      details: null,
      timestamp: new Date().toISOString(),
    },
    { status: 500 },
  )
}

beforeEach(() => {
  sonnerToast.dismiss()
  useUiStore.setState({ theme: 'dark' })
  useConnectionStore.setState({ baseUrl: '', apiKey: 'test-key', status: 'ready' })
  useServerStore.setState({
    status: null,
    systemStats: null,
    instanceId: 'demo',
    socketConnected: true,
    hasConnectedOnce: true,
    lastStatusEvent: null,
  })
})

// 每例重置 MSW handlers，防止 server.use 覆盖泄漏到后续测试（默认 handlers 为准）
afterEach(() => {
  server.resetHandlers()
  releaseGate?.()
})

/** 序号守卫测试的挂起闸门（afterEach 兜底释放，防止跨测试悬挂） */
let releaseGate: (() => void) | undefined

describe('GeneralPanel autoRestart 初始值', () => {
  it('实例 autoRestart=true（mock 默认）→ 开关开启', async () => {
    renderPanel()
    const sw = await screen.findByRole('switch', { name: '意外停止自动重启' })
    await waitFor(() => expect(sw).toHaveAttribute('data-state', 'checked'))
  })

  it('实例 autoRestart=false → 开关关闭', async () => {
    server.use(http.get('*/api/v1/instances/:id', () => okEnvelope(false)))
    renderPanel()
    const sw = await screen.findByRole('switch', { name: '意外停止自动重启' })
    // 默认 true 先渲染，服务端值到达后翻转关闭
    await waitFor(() => expect(sw).toHaveAttribute('data-state', 'unchecked'))
  })

  it('无实例：显示无实例提示，不渲染开关（不发请求）', () => {
    useServerStore.setState({ instanceId: null })
    renderPanel()
    expect(screen.queryByRole('switch', { name: '意外停止自动重启' })).not.toBeInTheDocument()
    expect(screen.getByText(/未选择实例 — 自动重启为服务器实例配置/)).toBeInTheDocument()
    // 主题行不受实例影响，仍可用
    expect(screen.getByRole('combobox', { name: '界面主题' })).toBeInTheDocument()
  })
})

describe('GeneralPanel autoRestart 切换', () => {
  it('切换成功：乐观翻转 → PUT {autoRestart:false} → 成功 toast → 值保持', async () => {
    const user = userEvent.setup()
    let putBody: unknown = null
    server.use(
      http.put('*/api/v1/instances/:id', async ({ request }) => {
        putBody = await request.json()
        return okEnvelope(false)
      }),
    )
    renderPanel()
    const sw = await screen.findByRole('switch', { name: '意外停止自动重启' })
    await waitFor(() => expect(sw).toHaveAttribute('data-state', 'checked'))

    await user.click(sw)
    // 乐观翻转立即生效（无需等服务端）
    await waitFor(() => expect(sw).toHaveAttribute('data-state', 'unchecked'))
    // PUT 载荷为白名单字段 autoRestart
    await waitFor(() => expect(putBody).toEqual({ autoRestart: false }))
    // 成功 toast + 值保持关闭
    expect(await screen.findByText('自动重启设置已保存')).toBeInTheDocument()
    expect(sw).toHaveAttribute('data-state', 'unchecked')
  })

  it('切换失败：错误 toast + 回滚到服务端值', async () => {
    const user = userEvent.setup()
    server.use(http.put('*/api/v1/instances/:id', () => errorEnvelope()))
    renderPanel()
    const sw = await screen.findByRole('switch', { name: '意外停止自动重启' })
    await waitFor(() => expect(sw).toHaveAttribute('data-state', 'checked'))

    await user.click(sw)
    // 失败 → 错误 toast（友好文案映射 50000）+ 回滚开启
    expect(await screen.findByText('自动重启设置保存失败：服务器内部错误，请稍后重试')).toBeInTheDocument()
    await waitFor(() => expect(sw).toHaveAttribute('data-state', 'checked'))
    // 无成功 toast
    expect(screen.queryByText('自动重启设置已保存')).not.toBeInTheDocument()
  })

  it('序号守卫：陈旧请求失败不回滚不弹错（最新切换成功为准）', async () => {
    const user = userEvent.setup()
    // 第一次切换（seq1）PUT 挂起，第二次（seq2）先完成；随后 seq1 失败返回
    let release: (() => void) | undefined
    const firstGate = new Promise<void>((resolve) => {
      release = resolve
    })
    releaseGate = release
    let putCalls = 0
    let firstProcessed = false
    server.use(
      http.put('*/api/v1/instances/:id', async () => {
        putCalls += 1
        if (putCalls === 1) {
          await firstGate
          firstProcessed = true
          return errorEnvelope()
        }
        return okEnvelope(true)
      }),
    )
    renderPanel()
    const sw = await screen.findByRole('switch', { name: '意外停止自动重启' })
    await waitFor(() => expect(sw).toHaveAttribute('data-state', 'checked'))

    await user.click(sw) // 开 → 关（seq1，挂起）
    await user.click(sw) // 关 → 开（seq2，成功）
    expect(await screen.findByText('自动重启设置已保存')).toBeInTheDocument()
    expect(sw).toHaveAttribute('data-state', 'checked')

    // 释放陈旧失败：处理完但不弹错、不回滚
    release?.()
    await waitFor(() => expect(firstProcessed).toBe(true))
    expect(screen.queryByText(/自动重启设置保存失败/)).not.toBeInTheDocument()
    expect(screen.getAllByText('自动重启设置已保存')).toHaveLength(1)
    expect(sw).toHaveAttribute('data-state', 'checked')
  })
})

describe('GeneralPanel 主题切换', () => {
  it('Select 暗色/亮色 → ui store theme 更新（本地偏好即时生效）', async () => {
    const user = userEvent.setup()
    renderPanel()
    expect(useUiStore.getState().theme).toBe('dark')
    // 当前主题回显在 Select trigger 上
    expect(screen.getByRole('combobox', { name: '界面主题' })).toHaveTextContent('暗色')

    await user.click(screen.getByRole('combobox', { name: '界面主题' }))
    await user.click(await screen.findByRole('option', { name: '亮色' }))
    expect(useUiStore.getState().theme).toBe('light')

    // 再切回暗色
    await user.click(screen.getByRole('combobox', { name: '界面主题' }))
    await user.click(await screen.findByRole('option', { name: '暗色' }))
    expect(useUiStore.getState().theme).toBe('dark')
  })
})
