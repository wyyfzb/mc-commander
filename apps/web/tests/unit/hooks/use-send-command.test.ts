import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { useSendCommand } from '@/hooks/use-send-command'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'
import { useTerminalStore } from '@/stores/terminal'

/** apiSendCommand mock：受控延迟（模拟命令飞行中连点第二条） */
const sendCommandMock = vi.hoisted(() => vi.fn())

vi.mock('@/api/players', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/players')>()),
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
      status: { id: 'inst-1', isRunning: true } as never,
    })
  })

  it('第一条命令飞行中连点第二条：两条都被发送（isPending 不静默丢弃）', async () => {
    let resolveFirst: (v: unknown) => void = () => {}
    sendCommandMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve
        }),
    )
    sendCommandMock.mockResolvedValueOnce('ok')

    const { result } = renderHook(() => useSendCommand(), { wrapper: setupWrapper() })

    // 第一条：飞行中（不 resolve）
    expect(result.current.send('weather rain')).toBe(true)
    // 第二条：立即连点（此时 mutation.isPending === true）
    expect(result.current.send('time set night')).toBe(true)

    await act(async () => {
      resolveFirst('ok')
    })
    await waitFor(() => {
      expect(sendCommandMock).toHaveBeenCalledTimes(2)
    })
    expect(sendCommandMock).toHaveBeenNthCalledWith(1, expect.anything(), 'inst-1', 'weather rain')
    expect(sendCommandMock).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'inst-1',
      'time set night',
    )
  })

  it.each([
    { response: null, message: '命令已投递，未确认游戏执行', confirmed: false },
    { response: '', message: '游戏已响应，未返回文字', confirmed: true },
  ])('响应为 $response 时区分命令反馈与读数更新', async ({ response, message, confirmed }) => {
    sendCommandMock.mockResolvedValueOnce(response)
    const onResponse = vi.fn()
    const pushEntry = vi.spyOn(useTerminalStore.getState(), 'pushEntry')
    try {
      const { result } = renderHook(() => useSendCommand(), { wrapper: setupWrapper() })
      act(() => {
        result.current.send('time set night', onResponse)
      })
      await waitFor(() => expect(pushEntry).toHaveBeenCalledWith('inst-1', message, 'stdout'))
      expect(sendCommandMock).toHaveBeenCalledWith(
        expect.anything(),
        'inst-1',
        'time set night',
        undefined,
        { requireResponse: true },
      )
      expect(onResponse).toHaveBeenCalledTimes(confirmed ? 1 : 0)
    } finally {
      pushEntry.mockRestore()
    }
  })

  it('未运行时 send 返回 false 且不发起请求', () => {
    useServerStore.setState({ status: { isRunning: false } as never })
    const { result } = renderHook(() => useSendCommand(), { wrapper: setupWrapper() })
    expect(result.current.send('say hi')).toBe(false)
    expect(sendCommandMock).not.toHaveBeenCalled()
  })
})
