import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { useSendCommand } from '../use-send-command'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'

/** apiSendCommand mock：受控延迟（模拟命令飞行中连点第二条） */
const sendCommandMock = vi.hoisted(() => vi.fn())

vi.mock('@/api/players', () => ({
  apiSendCommand: sendCommandMock,
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}))

function setupWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children)
  return wrapper
}

describe('useSendCommand（连点不丢命令）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useConnectionStore.setState({ baseUrl: '', apiKey: ['test', 'key'].join('-') })
    useServerStore.setState({
      instanceId: 'inst-1',
      status: { isRunning: true } as never,
    })
  })

  it('第一条命令飞行中连点第二条：两条都被发送（isPending 不静默丢弃）', async () => {
    let resolveFirst: (v: unknown) => void = () => {}
    sendCommandMock.mockImplementationOnce(
      () => new Promise((resolve) => { resolveFirst = resolve }),
    )
    sendCommandMock.mockResolvedValueOnce({ response: 'ok' })

    const { result } = renderHook(() => useSendCommand(), { wrapper: setupWrapper() })

    // 第一条：飞行中（不 resolve）
    expect(result.current.send('weather rain')).toBe(true)
    // 第二条：立即连点（此时 mutation.isPending === true）
    expect(result.current.send('time set night')).toBe(true)

    await act(async () => { resolveFirst({ response: 'ok' }) })
    await waitFor(() => {
      expect(sendCommandMock).toHaveBeenCalledTimes(2)
    })
    expect(sendCommandMock).toHaveBeenNthCalledWith(1, expect.anything(), 'inst-1', 'weather rain')
    expect(sendCommandMock).toHaveBeenNthCalledWith(2, expect.anything(), 'inst-1', 'time set night')
  })

  it('未运行时 send 返回 false 且不发起请求', () => {
    useServerStore.setState({ status: { isRunning: false } as never })
    const { result } = renderHook(() => useSendCommand(), { wrapper: setupWrapper() })
    expect(result.current.send('say hi')).toBe(false)
    expect(sendCommandMock).not.toHaveBeenCalled()
  })
})
