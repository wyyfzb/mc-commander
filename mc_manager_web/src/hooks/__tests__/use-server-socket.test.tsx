import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useServerSocket, getSocketSingleton } from '../use-server-socket'
import { useConnectionStore } from '@/stores/connection'
import { useAuthStore, type StoredSession } from '@/stores/auth'
import { useNotificationStore } from '@/stores/notifications'
import { queryKeys } from '@/api/queries'
import type { WebSocketLike, WebSocketCtor } from '@/api/ws'

/**
 * WS 单例治理（issue #311）hook 层测试：
 * - 凭据变更（换 token）→ 旧连接 close、新连接携带新凭据 subprotocol
 * - 登出（session 清空）→ 单例关闭置空、重连定时器清空
 * - 实例切换/effect 重跑 → connect 幂等不产生双 WebSocket
 * - 断线补齐游标（lastEventId）存 localStorage，重建后订阅仍携带
 *
 * hook 内 McSocket 默认用全局 WebSocket → vi.stubGlobal 注入 FakeWebSocket
 */

/** 测试用会话凭据（虚构 token，杜绝真实凭据入库） */
function makeSession(token: string): StoredSession {
  return { token, sessionId: `sid-${token}`, expiresAt: '2030-01-01T00:00:00.000Z' }
}

class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = []
  static CONNECTING = 0
  static OPEN = 1

  readyState = FakeWebSocket.CONNECTING
  sent: string[] = []
  url: string
  protocols?: string | string[]
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: ((ev: { code: number; reason: string }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null

  constructor(url: string, protocols?: string | string[]) {
    this.url = url
    this.protocols = protocols
    FakeWebSocket.instances.push(this)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.readyState = 3
  }

  /** 测试辅助：模拟握手成功 */
  open() {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.(null)
  }

  /** 测试辅助：模拟收到服务端消息 */
  receive(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
}

const FakeCtor = FakeWebSocket as unknown as WebSocketCtor

function createWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const wrapper = function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  }
  // 暴露 qc：断言事件分支的 query 失效行为用
  return Object.assign(wrapper, { qc })
}

/** 读取某个 FakeWebSocket 已发送的 subscribe 消息 */
function sentSubscribe(ws: FakeWebSocket): Array<{ type: string; instanceId?: string; lastEventId?: number }> {
  return ws.sent
    .map((m) => JSON.parse(m) as { type: string; instanceId?: string; lastEventId?: number })
    .filter((m) => m.type === 'subscribe')
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('useServerSocket（WS 单例治理，issue #311）', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    localStorage.clear()
    vi.stubGlobal('WebSocket', FakeCtor)
    // 清理跨测试遗留的单例：无凭据跑一次 hook 触发「关闭置空」分支
    useConnectionStore.setState({ baseUrl: '', apiKey: '', status: 'unconfigured' })
    useAuthStore.setState({ session: null })
    const { unmount } = renderHook(() => useServerSocket(null), { wrapper: createWrapper() })
    unmount()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('凭据变更（换 token）：旧连接 close、新连接携带新凭据 subprotocol', async () => {
    useConnectionStore.setState({ baseUrl: '', apiKey: 'k1', status: 'ready' })
    useAuthStore.setState({ session: makeSession('token-old') })

    renderHook(() => useServerSocket('i-1'), { wrapper: createWrapper() })

    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1))
    const ws1 = FakeWebSocket.instances[0]!
    expect(ws1.protocols).toEqual(['mc-commander-session.token-old'])
    act(() => {
      ws1.open()
    })
    await flushMicrotasks()

    // 改密/踢单设备 → session token 变更（zustand setState 触发 effect 重跑）
    act(() => {
      useAuthStore.setState({ session: makeSession('token-new') })
    })

    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(2))
    expect(ws1.readyState).toBe(3) // 旧连接已 close，不再占用通道

    const ws2 = FakeWebSocket.instances[1]!
    expect(ws2.protocols).toEqual(['mc-commander-session.token-new'])

    const singleton = getSocketSingleton()
    expect(singleton).not.toBeNull()
    expect(singleton!.credentialsMatch({ apiKey: 'k1', sessionToken: 'token-new' })).toBe(true)
    expect(singleton!.credentialsMatch({ apiKey: 'k1', sessionToken: 'token-old' })).toBe(false)
  })

  it('登出（session 清空且无 apiKey）：单例关闭置空、重连定时器清空，定时到点不重建', async () => {
    vi.useFakeTimers()
    useConnectionStore.setState({ baseUrl: '', apiKey: '', status: 'ready' })
    useAuthStore.setState({ session: makeSession('token-a') })

    renderHook(() => useServerSocket('i-1'), { wrapper: createWrapper() })
    await flushMicrotasks()
    expect(FakeWebSocket.instances.length).toBe(1)
    act(() => {
      FakeWebSocket.instances[0]!.open()
    })
    await flushMicrotasks()

    // 断线 → McSocket 安排重连定时器（1s 后）
    act(() => {
      FakeWebSocket.instances[0]!.onclose?.({ code: 1006, reason: '' })
    })

    // 登出：session 清空 + 连接状态回退 unconfigured
    act(() => {
      useAuthStore.setState({ session: null })
      useConnectionStore.setState({ status: 'unconfigured' })
    })

    // 重连定时器到点也不得重建（已被 close() 清空）
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(FakeWebSocket.instances.length).toBe(1)
    expect(getSocketSingleton()).toBeNull()

    // 重新登录可再建
    useConnectionStore.setState({ status: 'ready' })
    useAuthStore.setState({ session: makeSession('token-b') })
    await flushMicrotasks()
    expect(FakeWebSocket.instances.length).toBe(2)
    expect(FakeWebSocket.instances[1]!.protocols).toEqual(['mc-commander-session.token-b'])
  })

  it('登出回退：session 清空但 apiKey 存在时，凭据比对触发重建为 apiKey 通道', async () => {
    useConnectionStore.setState({ baseUrl: '', apiKey: 'k1', status: 'ready' })
    useAuthStore.setState({ session: makeSession('token-a') })

    renderHook(() => useServerSocket('i-1'), { wrapper: createWrapper() })
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1))
    act(() => {
      FakeWebSocket.instances[0]!.open()
    })
    await flushMicrotasks()
    expect(FakeWebSocket.instances[0]!.protocols).toEqual(['mc-commander-session.token-a'])

    // session 失效（服务端踢出/改密全踢）：sessionToken 变 null，apiKey 仍可用
    act(() => {
      useAuthStore.setState({ session: null })
    })

    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(2))
    expect(FakeWebSocket.instances[0]!.readyState).toBe(3)
    expect(FakeWebSocket.instances[1]!.protocols).toEqual(['mc-commander-apikey.k1'])
  })

  it('会话属于别的面板：WS 回落 API Key 通道（不拿 A 的令牌连 B 的实时通道）', async () => {
    useConnectionStore.setState({ baseUrl: '', apiKey: 'k1', status: 'ready' })
    useAuthStore.setState({
      session: { ...makeSession('token-foreign'), issuedFor: 'https://panel-a.example.com' },
    })

    renderHook(() => useServerSocket('i-1'), { wrapper: createWrapper() })

    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1))
    expect(FakeWebSocket.instances[0]!.protocols).toEqual(['mc-commander-apikey.k1'])
  })

  it('effect 重跑（实例切换）不产生双 WebSocket：connect 幂等复用同一连接', async () => {
    useConnectionStore.setState({ baseUrl: '', apiKey: 'k1', status: 'ready' })
    useAuthStore.setState({ session: null })

    const { rerender } = renderHook(({ id }) => useServerSocket(id), {
      wrapper: createWrapper(),
      initialProps: { id: 'i-1' },
    })
    await flushMicrotasks()
    act(() => {
      FakeWebSocket.instances[0]!.open()
    })
    await flushMicrotasks()
    expect(FakeWebSocket.instances.length).toBe(1)
    expect(sentSubscribe(FakeWebSocket.instances[0]!)).toEqual([
      { type: 'subscribe', instanceId: 'i-1' },
    ])

    // 实例切换：订阅更新，连接复用（无第二次构造）
    rerender({ id: 'i-2' })
    await flushMicrotasks()
    expect(FakeWebSocket.instances.length).toBe(1)
    const subs = sentSubscribe(FakeWebSocket.instances[0]!)
    expect(subs.some((m) => m.instanceId === 'i-2')).toBe(true)
  })

  it('凭据重建后断线补齐游标保持有效（lastEventId 存 localStorage，不随单例丢失）', async () => {
    useConnectionStore.setState({ baseUrl: '', apiKey: 'k1', status: 'ready' })
    useAuthStore.setState({ session: makeSession('token-old') })

    renderHook(() => useServerSocket('i-1'), { wrapper: createWrapper() })
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1))
    const ws1 = FakeWebSocket.instances[0]!
    act(() => {
      ws1.open()
    })
    await flushMicrotasks()

    // 连接1 收到带 eventId 的通知事件 → 游标写入 localStorage
    act(() => {
      ws1.receive({ type: 'playerJoin', eventId: 42, instanceId: 'i-1', data: {} })
    })

    // 凭据变更重建
    act(() => {
      useAuthStore.setState({ session: makeSession('token-new') })
    })
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(2))
    const ws2 = FakeWebSocket.instances[1]!
    act(() => {
      ws2.open()
    })
    await flushMicrotasks()

    // 新连接的 subscribe 携带 lastEventId=42（断线补齐锚点不丢失）
    const subs = sentSubscribe(ws2)
    expect(subs).toEqual([{ type: 'subscribe', instanceId: 'i-1', lastEventId: 42 }])
  })
})

describe('useServerSocket（状态跃迁通知接线）', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    localStorage.clear()
    vi.stubGlobal('WebSocket', FakeCtor)
    useConnectionStore.setState({ baseUrl: '', apiKey: '', status: 'unconfigured' })
    useAuthStore.setState({ session: null })
    // notifications store 为全局单例：清内存态防跨用例残留（items/告警状态机）
    useNotificationStore.setState({ items: [], unreadCount: 0, activeAlerts: new Set() })
    const { unmount } = renderHook(() => useServerSocket(null), { wrapper: createWrapper() })
    unmount()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  /** 建立已连接的 socket，返回 FakeWebSocket */
  async function connectReady(instanceId: string) {
    useConnectionStore.setState({ baseUrl: '', apiKey: 'k1', status: 'ready' })
    renderHook(() => useServerSocket(instanceId), { wrapper: createWrapper() })
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1))
    const ws = FakeWebSocket.instances[0]!
    act(() => {
      ws.open()
    })
    await flushMicrotasks()
    return ws
  }

  it('started/stopped 跃迁入通知中心（回归：此前仅 crash/熔断接线）', async () => {
    const ws = await connectReady('i-1')

    act(() => {
      ws.receive({ type: 'status', instanceId: 'i-1', data: { event: 'started' } })
    })
    const afterStart = useNotificationStore.getState().items
    expect(afterStart[0]?.type).toBe('serverStart')
    expect(afterStart[0]?.content).toBe('服务器已启动')
    expect(afterStart[0]?.instanceId).toBe('i-1')

    act(() => {
      ws.receive({ type: 'status', instanceId: 'i-1', data: { event: 'stopped' } })
    })
    const afterStop = useNotificationStore.getState().items
    expect(afterStop[0]?.type).toBe('serverStop')
    expect(afterStop[0]?.content).toBe('服务器已停止')
    // 持久化同步写入（通知面板数据源）
    expect(localStorage.getItem('mcs-notifications')).not.toBeNull()
  })

  it('非当前实例的常规跃迁不入通知中心（维持 issue #334 的 critical-only 取舍）', async () => {
    const ws = await connectReady('i-1')

    act(() => {
      ws.receive({ type: 'status', instanceId: 'i-other', data: { event: 'started' } })
    })
    expect(useNotificationStore.getState().items.length).toBe(0)

    act(() => {
      ws.receive({ type: 'status', instanceId: 'i-other', data: { event: 'crash' } })
    })
    const items = useNotificationStore.getState().items
    expect(items[0]?.type).toBe('serverCrash')
  })

  it('status 跃迁同步失效当前实例详情 query（isRunning 源头；只刷列表会让停止状态条滞后到 30s 轮询）', async () => {
    useConnectionStore.setState({ baseUrl: '', apiKey: 'k1', status: 'ready' })
    const wrapper = createWrapper()
    const { qc } = wrapper
    // 预置详情/列表缓存，模拟面板已加载态
    qc.setQueryData(queryKeys.instance('i-1'), { isRunning: true })
    qc.setQueryData(queryKeys.instances(), [])
    renderHook(() => useServerSocket('i-1'), { wrapper })
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1))
    const ws = FakeWebSocket.instances[0]!
    act(() => {
      ws.open()
    })
    await flushMicrotasks()

    act(() => {
      ws.receive({ type: 'status', instanceId: 'i-1', data: { event: 'stopped' } })
    })

    // 详情与列表都进入失效态：详情 refetch 后 isRunning 翻转，停止状态条即时出现
    expect(qc.getQueryState(queryKeys.instance('i-1'))?.isInvalidated).toBe(true)
    expect(qc.getQueryState(queryKeys.instances())?.isInvalidated).toBe(true)
  })
})
