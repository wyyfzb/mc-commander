import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useServerSocket, getSocketSingleton } from '../use-server-socket'
import { useConnectionStore } from '@/stores/connection'
import { useAuthStore, type StoredSession } from '@/stores/auth'
import { useNotificationStore } from '@/stores/notifications'
import { useDeployStore } from '@/stores/deploy'
import { useBackupProgressStore, clearBackupProgress } from '@/stores/backup-progress'
import { useWorldUpgradeProgressStore } from '@/stores/world-upgrade-progress'
import { queryKeys } from '@/api/queries'
import type { WebSocketLike, WebSocketCtor } from '@/api/ws'

/**
 * WS 单例治理（issue #311）hook 层测试：
 * - 凭据变更（换 token）→ 旧连接 close、新连接首帧 auth 携带新凭据
 * - 登出（session 清空）→ 单例关闭置空、重连定时器清空
 * - 实例切换/effect 重跑 → connect 幂等不产生双 WebSocket
 * - 断线补齐游标（lastEventId）存 localStorage，重建后订阅仍携带
 *
 * 首帧鉴权：open 后客户端发 {type:'auth', ...}，服务端回
 * {type:'auth', ok:true} 后连接才可用（订阅在鉴权后发出）
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

/** 模拟握手 + 首帧鉴权完成（服务端回 auth-ok；首帧鉴权流程） */
function openAndAuth(ws: FakeWebSocket) {
  ws.open()
  ws.receive({ type: 'auth', ok: true })
}

/** 读取某个 FakeWebSocket 已发送的首帧 auth 消息 */
function sentAuth(ws: FakeWebSocket): Record<string, unknown> {
  return JSON.parse(ws.sent[0]!) as Record<string, unknown>
}

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
function sentSubscribe(
  ws: FakeWebSocket,
): Array<{ type: string; instanceId?: string; lastEventId?: number }> {
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
    // 世界格式升级进度是模块级瞬态 store：不清会把上一条用例的百分比漏给下一条
    useWorldUpgradeProgressStore.setState({ progress: {} })
    const { unmount } = renderHook(() => useServerSocket(null), { wrapper: createWrapper() })
    unmount()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('凭据变更（换 token）：旧连接 close、新连接首帧 auth 携带新凭据', async () => {
    useConnectionStore.setState({ baseUrl: '', apiKey: 'k1', status: 'ready' })
    useAuthStore.setState({ session: makeSession('token-old') })

    renderHook(() => useServerSocket('i-1'), { wrapper: createWrapper() })

    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1))
    const ws1 = FakeWebSocket.instances[0]!
    act(() => {
      openAndAuth(ws1)
    })
    await flushMicrotasks()
    expect(sentAuth(ws1)).toMatchObject({ type: 'auth', sessionToken: 'token-old' })

    // 改密/踢单设备 → session token 变更（zustand setState 触发 effect 重跑）
    act(() => {
      useAuthStore.setState({ session: makeSession('token-new') })
    })

    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(2))
    expect(ws1.readyState).toBe(3) // 旧连接已 close，不再占用通道

    const ws2 = FakeWebSocket.instances[1]!
    act(() => {
      openAndAuth(ws2)
    })
    expect(sentAuth(ws2)).toMatchObject({ type: 'auth', sessionToken: 'token-new' })

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
      openAndAuth(FakeWebSocket.instances[0]!)
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
    act(() => {
      openAndAuth(FakeWebSocket.instances[1]!)
    })
    expect(sentAuth(FakeWebSocket.instances[1]!)).toMatchObject({
      type: 'auth',
      sessionToken: 'token-b',
    })
  })

  it('登出回退：session 清空但 apiKey 存在时，凭据比对触发重建为 apiKey 通道', async () => {
    useConnectionStore.setState({ baseUrl: '', apiKey: 'k1', status: 'ready' })
    useAuthStore.setState({ session: makeSession('token-a') })

    renderHook(() => useServerSocket('i-1'), { wrapper: createWrapper() })
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1))
    act(() => {
      openAndAuth(FakeWebSocket.instances[0]!)
    })
    await flushMicrotasks()
    expect(sentAuth(FakeWebSocket.instances[0]!)).toMatchObject({
      type: 'auth',
      sessionToken: 'token-a',
    })

    // session 失效（服务端踢出/改密全踢）：sessionToken 变 null，apiKey 仍可用
    act(() => {
      useAuthStore.setState({ session: null })
    })

    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(2))
    expect(FakeWebSocket.instances[0]!.readyState).toBe(3)
    act(() => {
      openAndAuth(FakeWebSocket.instances[1]!)
    })
    expect(sentAuth(FakeWebSocket.instances[1]!)).toMatchObject({ type: 'auth', apiKey: 'k1' })
  })

  it('会话属于别的面板：WS 回落 API Key 通道（不拿 A 的令牌连 B 的实时通道）', async () => {
    useConnectionStore.setState({ baseUrl: '', apiKey: 'k1', status: 'ready' })
    useAuthStore.setState({
      session: { ...makeSession('token-foreign'), issuedFor: 'https://panel-a.example.com' },
    })

    renderHook(() => useServerSocket('i-1'), { wrapper: createWrapper() })

    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1))
    act(() => {
      openAndAuth(FakeWebSocket.instances[0]!)
    })
    expect(sentAuth(FakeWebSocket.instances[0]!)).toMatchObject({ type: 'auth', apiKey: 'k1' })
  })

  it('effect 重跑（实例切换）不产生双 WebSocket：connect 幂等复用同一连接', async () => {
    useConnectionStore.setState({ baseUrl: '', apiKey: 'k1', status: 'ready' })
    useAuthStore.setState({ session: null })
    // 世界格式升级进度是模块级瞬态 store：不清会把上一条用例的百分比漏给下一条
    useWorldUpgradeProgressStore.setState({ progress: {} })

    const { rerender } = renderHook(({ id }) => useServerSocket(id), {
      wrapper: createWrapper(),
      initialProps: { id: 'i-1' },
    })
    await flushMicrotasks()
    act(() => {
      openAndAuth(FakeWebSocket.instances[0]!)
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

  it('worldUpgrade 会经 hook 分发到通知层（漏 case 会静默丢弃，是死接线）', async () => {
    // 这条专治「加了事件类型与映射、却忘了在 switch 里放行」：hook 的 switch 带
    // `default: break`，未列的 type 会被静默丢掉——前面 playerChat 就这样断过全链路。
    useConnectionStore.setState({ baseUrl: '', apiKey: 'k1', status: 'ready' })
    useAuthStore.setState({ session: makeSession('token-world') })

    renderHook(() => useServerSocket('i-1'), { wrapper: createWrapper() })
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1))
    const ws = FakeWebSocket.instances[0]!
    act(() => {
      openAndAuth(ws)
    })
    await flushMicrotasks()

    act(() => {
      ws.receive({
        type: 'worldUpgrade',
        instanceId: 'i-1',
        data: { state: 'started', progress: null },
      })
    })
    expect(useNotificationStore.getState().items[0]?.type).toBe('worldUpgradeStart')

    act(() => {
      ws.receive({
        type: 'worldUpgrade',
        instanceId: 'i-1',
        data: { state: 'progress', progress: null },
      })
    })
    // progress 刻意不产生条目（1 条/秒），但**不能因此把整个事件丢掉**
    expect(useNotificationStore.getState().items.some((n) => n.type === 'worldUpgradeStart')).toBe(
      true,
    )
    expect(useNotificationStore.getState().items.length).toBe(1)
  })

  it('worldUpgrade 的进度落进瞬态 store 而非通知条目，终态把它清掉', async () => {
    useConnectionStore.setState({ baseUrl: '', apiKey: 'k1', status: 'ready' })
    useAuthStore.setState({ session: makeSession('token-world-progress') })

    renderHook(() => useServerSocket('i-1'), { wrapper: createWrapper() })
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1))
    const ws = FakeWebSocket.instances[0]!
    act(() => {
      openAndAuth(ws)
    })
    await flushMicrotasks()

    act(() => {
      ws.receive({
        type: 'worldUpgrade',
        instanceId: 'i-1',
        data: { state: 'started', progress: null },
      })
      // 夹具用真机量纲：协议给的是 0..1 的**分数**（见 mc-schemas 的载荷 schema）
      ws.receive({
        type: 'worldUpgrade',
        instanceId: 'i-1',
        data: { state: 'progress', progress: 0.37 },
      })
    })
    // 换算成百分数落进进度条的数据源（直灌原值会让条恒在 1% 以下、标签恒 0%）
    expect(useWorldUpgradeProgressStore.getState().progress['i-1']).toBeCloseTo(37)
    expect(useNotificationStore.getState().items[0]?.type).toBe('worldUpgradeStart')

    act(() => {
      ws.receive({
        type: 'worldUpgrade',
        instanceId: 'i-1',
        data: { state: 'finished', progress: null },
      })
    })
    // 终态：进度清掉（否则界面上会留着一条不动的百分比），终态通知照常入中心
    expect(useWorldUpgradeProgressStore.getState().progress['i-1']).toBeUndefined()
    expect(useNotificationStore.getState().items[0]?.type).toBe('worldUpgradeComplete')
  })

  it('状态快照带回在途的世界格式升级：0..1 分数换算成百分数落进进度数据源', async () => {
    useConnectionStore.setState({ baseUrl: '', apiKey: 'k1', status: 'ready' })
    useAuthStore.setState({ session: makeSession('token-snapshot-world') })

    renderHook(() => useServerSocket('i-1'), { wrapper: createWrapper() })
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1))
    const ws = FakeWebSocket.instances[0]!
    act(() => {
      openAndAuth(ws)
    })
    await flushMicrotasks()

    act(() => {
      ws.receive({
        type: 'statusSnapshot',
        instanceId: 'i-1',
        data: {
          status: 'running',
          isRunning: true,
          players: [],
          tps: 20,
          worldUpgrade: { progress: 0.42 },
        },
      })
    })
    // 快照回来的是分数，进度条吃百分数；这一条是「中途才连上的客户端」唯一的权威来源
    expect(useWorldUpgradeProgressStore.getState().progress['i-1']).toBeCloseTo(42)
  })

  it('快照里 worldUpgrade 为 null：确认空闲，清掉本地残留', async () => {
    useConnectionStore.setState({ baseUrl: '', apiKey: 'k1', status: 'ready' })
    useAuthStore.setState({ session: makeSession('token-snapshot-idle') })
    useWorldUpgradeProgressStore.setState({ progress: { 'i-1': 66 } })

    renderHook(() => useServerSocket('i-1'), { wrapper: createWrapper() })
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1))
    const ws = FakeWebSocket.instances[0]!
    act(() => {
      openAndAuth(ws)
    })
    await flushMicrotasks()

    act(() => {
      ws.receive({
        type: 'statusSnapshot',
        instanceId: 'i-1',
        data: { status: 'running', isRunning: true, players: [], tps: 20, worldUpgrade: null },
      })
    })
    expect(useWorldUpgradeProgressStore.getState().progress['i-1']).toBeUndefined()
  })

  it('快照里没有 worldUpgrade 字段：未知 ⇒ 不动已有值（不能读成「没有升级」）', async () => {
    useConnectionStore.setState({ baseUrl: '', apiKey: 'k1', status: 'ready' })
    useAuthStore.setState({ session: makeSession('token-snapshot-unknown') })
    useWorldUpgradeProgressStore.setState({ progress: { 'i-1': 66 } })

    renderHook(() => useServerSocket('i-1'), { wrapper: createWrapper() })
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1))
    const ws = FakeWebSocket.instances[0]!
    act(() => {
      openAndAuth(ws)
    })
    await flushMicrotasks()

    act(() => {
      ws.receive({
        type: 'statusSnapshot',
        instanceId: 'i-1',
        data: { status: 'running', isRunning: true, players: [], tps: 20 },
      })
    })
    expect(useWorldUpgradeProgressStore.getState().progress['i-1']).toBe(66)
  })

  it('快照带 msmpPush：就地写进详情缓存，界面不必等下一次轮询才翻转', async () => {
    useConnectionStore.setState({ baseUrl: '', apiKey: 'k1', status: 'ready' })
    useAuthStore.setState({ session: makeSession('token-msmp-push') })

    const wrapper = createWrapper()
    // 预置一份「已连通」的详情缓存：推送面断连不会让 REST 详情失效，
    // 界面若只靠轮询，会在这段时间里继续说「实时」
    wrapper.qc.setQueryData(queryKeys.instance('i-1'), {
      id: 'i-1',
      capabilities: { rcon: true, msmp: true, msmpPush: true },
    })
    renderHook(() => useServerSocket('i-1'), { wrapper })
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1))
    const ws = FakeWebSocket.instances[0]!
    act(() => {
      openAndAuth(ws)
    })
    await flushMicrotasks()

    act(() => {
      ws.receive({
        type: 'statusSnapshot',
        instanceId: 'i-1',
        data: { status: 'running', isRunning: true, players: [], tps: 20, msmpPush: false },
      })
    })
    expect(
      (
        wrapper.qc.getQueryData(queryKeys.instance('i-1')) as {
          capabilities: { msmpPush: boolean }
        }
      ).capabilities.msmpPush,
    ).toBe(false)
    // 其余能力位与详情字段不能被这次合并弄丢
    expect(
      (wrapper.qc.getQueryData(queryKeys.instance('i-1')) as { capabilities: { msmp: boolean } })
        .capabilities.msmp,
    ).toBe(true)
  })

  it('快照里没有 msmpPush 字段：未知（旧服务端）⇒ 保持缓存现状，不臆断成断开', async () => {
    useConnectionStore.setState({ baseUrl: '', apiKey: 'k1', status: 'ready' })
    useAuthStore.setState({ session: makeSession('token-msmp-unknown') })

    const wrapper = createWrapper()
    wrapper.qc.setQueryData(queryKeys.instance('i-1'), {
      id: 'i-1',
      capabilities: { rcon: true, msmp: true, msmpPush: true },
    })
    renderHook(() => useServerSocket('i-1'), { wrapper })
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1))
    const ws = FakeWebSocket.instances[0]!
    act(() => {
      openAndAuth(ws)
    })
    await flushMicrotasks()

    act(() => {
      ws.receive({
        type: 'statusSnapshot',
        instanceId: 'i-1',
        data: { status: 'running', isRunning: true, players: [], tps: 20 },
      })
    })
    expect(
      (
        wrapper.qc.getQueryData(queryKeys.instance('i-1')) as {
          capabilities: { msmpPush: boolean }
        }
      ).capabilities.msmpPush,
    ).toBe(true)
  })

  it('载荷的 state 不在契约枚举里：留痕，并按终态路径处置（不把整条事件静默丢掉）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    useConnectionStore.setState({ baseUrl: '', apiKey: 'k1', status: 'ready' })
    useAuthStore.setState({ session: makeSession('token-world-drift') })

    renderHook(() => useServerSocket('i-1'), { wrapper: createWrapper() })
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1))
    const ws = FakeWebSocket.instances[0]!
    act(() => {
      openAndAuth(ws)
    })
    await flushMicrotasks()

    act(() => {
      ws.receive({
        type: 'worldUpgrade',
        instanceId: 'i-1',
        data: { state: 'started', progress: null },
      })
      ws.receive({
        type: 'worldUpgrade',
        instanceId: 'i-1',
        data: { state: 'progress', progress: 0.5 },
      })
      // 契约只认 started/progress/finished/failed；大小写写错即漂移
      ws.receive({
        type: 'worldUpgrade',
        instanceId: 'i-1',
        data: { state: 'PROGRESS', progress: 0.9 },
      })
    })

    // 漂移的载荷不能整条消失：留痕 + 按宽松路径处置（非 progress ⇒ 终态：清进度、进通知层）
    expect(warn).toHaveBeenCalledWith(
      '[ws] worldUpgrade 载荷不符合契约，按宽松读取处置',
      expect.anything(),
    )
    expect(useWorldUpgradeProgressStore.getState().progress['i-1']).toBeUndefined()
    expect(useNotificationStore.getState().items.length).toBeGreaterThan(0)
  })

  it.each([
    [
      '字段缺失（零参通知的 params 整个缺席 ⇒ 服务端发 null）',
      { state: 'progress', progress: null },
      // 契约里 progress 是 number|null，故 null 合法，不该留痕
      false,
    ],
    ['字段整个不在', { state: 'progress' }, true],
    ['非数值', { state: 'progress', progress: 'n/a' }, true],
  ])(
    'worldUpgrade 的 progress %s 时不写进度（Number(null) 是 0，会把「没取到」画成 0%）',
    async (_label, data, expectsContractWarning) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      useConnectionStore.setState({ baseUrl: '', apiKey: 'k1', status: 'ready' })
      useAuthStore.setState({ session: makeSession('token-world-nan') })

      renderHook(() => useServerSocket('i-1'), { wrapper: createWrapper() })
      await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1))
      const ws = FakeWebSocket.instances[0]!
      act(() => {
        openAndAuth(ws)
      })
      await flushMicrotasks()

      act(() => {
        ws.receive({ type: 'worldUpgrade', instanceId: 'i-1', data })
      })
      // 契约不认的载荷要留痕，同时**不能整条丢掉**（宽松路径照旧处置）
      if (expectsContractWarning) {
        expect(warn).toHaveBeenCalledWith(
          '[ws] worldUpgrade 载荷不符合契约，按宽松读取处置',
          expect.anything(),
        )
      } else {
        expect(warn).not.toHaveBeenCalled()
      }
      expect(useWorldUpgradeProgressStore.getState().progress['i-1']).toBeUndefined()
    },
  )

  it('凭据重建后断线补齐游标保持有效（lastEventId 存 localStorage，不随单例丢失）', async () => {
    useConnectionStore.setState({ baseUrl: '', apiKey: 'k1', status: 'ready' })
    useAuthStore.setState({ session: makeSession('token-old') })

    renderHook(() => useServerSocket('i-1'), { wrapper: createWrapper() })
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1))
    const ws1 = FakeWebSocket.instances[0]!
    act(() => {
      openAndAuth(ws1)
    })
    await flushMicrotasks()

    // 连接1 收到带 eventId 的通知事件 → 游标写入 localStorage
    act(() => {
      ws1.receive({ type: 'playerJoin', eventId: 42, instanceId: 'i-1', data: {} })
    })

    // 同一信封的 eventId 也随条目录下（跨标签合并的身份）：分发点手写会漏，接线收敛在一处
    expect(useNotificationStore.getState().items[0]?.eventKey).toBe('evt-42-0')

    // 凭据变更重建
    act(() => {
      useAuthStore.setState({ session: makeSession('token-new') })
    })
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(2))
    const ws2 = FakeWebSocket.instances[1]!
    act(() => {
      openAndAuth(ws2)
    })
    await flushMicrotasks()

    // 新连接的 subscribe 携带 lastEventId=42（断线补齐锚点不丢失）
    const subs = sentSubscribe(ws2)
    expect(subs).toEqual([{ type: 'subscribe', instanceId: 'i-1', lastEventId: 42 }])
  })
})

describe('useServerSocket（备份进度与取消接线，清单 #16）', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    localStorage.clear()
    vi.stubGlobal('WebSocket', FakeCtor)
    useConnectionStore.setState({ baseUrl: '', apiKey: '', status: 'unconfigured' })
    useAuthStore.setState({ session: null })
    // 世界格式升级进度是模块级瞬态 store：不清会把上一条用例的百分比漏给下一条
    useWorldUpgradeProgressStore.setState({ progress: {} })
    useNotificationStore.setState({ items: [], unreadCount: 0, activeAlerts: new Set() })
    clearBackupProgress('i-1')
    const { unmount } = renderHook(() => useServerSocket(null), { wrapper: createWrapper() })
    unmount()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  /** 建立已连接的 socket（与上方 describe 同实现；各自作用域内维护） */
  async function connectReady(instanceId: string) {
    useConnectionStore.setState({ baseUrl: '', apiKey: 'k1', status: 'ready' })
    renderHook(() => useServerSocket(instanceId), { wrapper: createWrapper() })
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1))
    const ws = FakeWebSocket.instances[0]!
    act(() => {
      openAndAuth(ws)
    })
    await flushMicrotasks()
    return ws
  }

  it('backupProgress → 进度 store（不进通知中心，1s 级推送不落库）', async () => {
    const ws = await connectReady('i-1')
    act(() => {
      ws.receive({
        type: 'backupProgress',
        instanceId: 'i-1',
        data: { backupId: 7, percent: 41.2 },
      })
    })
    expect(useBackupProgressStore.getState().progress['i-1']).toEqual({
      kind: 'create',
      backupId: 7,
      percent: 41.2,
    })
    expect(useNotificationStore.getState().items.length).toBe(0)
  })

  it('backupStart 清除上一次的进度条目（终态在别处错过时，新操作不得显示陈旧百分比）', async () => {
    useBackupProgressStore.setState({
      progress: { 'i-1': { kind: 'create', backupId: 7, percent: 88 } },
    })
    const ws = await connectReady('i-1')
    act(() => {
      ws.receive({ type: 'backupStart', instanceId: 'i-1', data: { backupId: 8 } })
    })
    expect(useBackupProgressStore.getState().progress['i-1']).toBeUndefined()
  })

  it('终态 backupCancelled 清除进度并入通知中心（跨标签/断线补齐可见取消结局）', async () => {
    useBackupProgressStore.setState({
      progress: { 'i-1': { kind: 'create', backupId: 7, percent: 50 } },
    })
    const ws = await connectReady('i-1')
    act(() => {
      ws.receive({
        type: 'backupCancelled',
        instanceId: 'i-1',
        data: { backupId: 7, content: '备份已取消' },
      })
    })
    expect(useBackupProgressStore.getState().progress['i-1']).toBeUndefined()
    const items = useNotificationStore.getState().items
    expect(items[0]?.type).toBe('backupCancelled')
    expect(items[0]?.content).toBe('备份已取消')
  })
})

describe('useServerSocket（状态跃迁通知接线）', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    localStorage.clear()
    vi.stubGlobal('WebSocket', FakeCtor)
    useConnectionStore.setState({ baseUrl: '', apiKey: '', status: 'unconfigured' })
    useAuthStore.setState({ session: null })
    // 世界格式升级进度是模块级瞬态 store：不清会把上一条用例的百分比漏给下一条
    useWorldUpgradeProgressStore.setState({ progress: {} })
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
      openAndAuth(ws)
    })
    await flushMicrotasks()
    return ws
  }

  it('started/stopped 跃迁入通知中心（回归：此前仅 crash/熔断接线）', async () => {
    const ws = await connectReady('i-1')

    act(() => {
      ws.receive({ type: 'statusEvent', instanceId: 'i-1', data: { event: 'started' } })
    })
    const afterStart = useNotificationStore.getState().items
    expect(afterStart[0]?.type).toBe('serverStart')
    expect(afterStart[0]?.content).toBe('服务器已启动')
    expect(afterStart[0]?.instanceId).toBe('i-1')

    act(() => {
      ws.receive({ type: 'statusEvent', instanceId: 'i-1', data: { event: 'stopped' } })
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
      ws.receive({ type: 'statusEvent', instanceId: 'i-other', data: { event: 'started' } })
    })
    expect(useNotificationStore.getState().items.length).toBe(0)

    act(() => {
      ws.receive({ type: 'statusEvent', instanceId: 'i-other', data: { event: 'crash' } })
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
      openAndAuth(ws)
    })
    await flushMicrotasks()

    act(() => {
      ws.receive({ type: 'statusEvent', instanceId: 'i-1', data: { event: 'stopped' } })
    })

    // 详情与列表都进入失效态：详情 refetch 后 isRunning 翻转，停止状态条即时出现
    expect(qc.getQueryState(queryKeys.instance('i-1'))?.isInvalidated).toBe(true)
    expect(qc.getQueryState(queryKeys.instances())?.isInvalidated).toBe(true)
  })

  it('systemStatsUpdate 失效系统指标 query（接线后该分支才第一次有消费方）', async () => {
    useConnectionStore.setState({ baseUrl: '', apiKey: 'k1', status: 'ready' })
    const wrapper = createWrapper()
    const { qc } = wrapper
    // 预置指标缓存，模拟仪表盘已加载态
    qc.setQueryData(queryKeys.systemStats(), { cpuUsage: 1 })
    renderHook(() => useServerSocket('i-1'), { wrapper })
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1))
    const ws = FakeWebSocket.instances[0]!
    act(() => {
      openAndAuth(ws)
    })
    await flushMicrotasks()

    // 服务端每 15s 推一次（无 instanceId 的全局事件）：前端不直接写 store，
    // 而是失效指标 query 触发 HTTP 重取——数值只有 /system-stats 一个来源
    act(() => {
      ws.receive({ type: 'systemStatsUpdate', data: { cpuUsage: 12.5 } })
    })

    expect(qc.getQueryState(queryKeys.systemStats())?.isInvalidated).toBe(true)
  })

  it('systemStatsUpdate 带阈值且磁盘越线 → 生成磁盘告警通知', async () => {
    useConnectionStore.setState({ baseUrl: '', apiKey: 'k1', status: 'ready' })
    const wrapper = createWrapper()
    renderHook(() => useServerSocket('i-1'), { wrapper })
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1))
    const ws = FakeWebSocket.instances[0]!
    act(() => {
      openAndAuth(ws)
    })
    await flushMicrotasks()

    act(() => {
      ws.receive({
        type: 'systemStatsUpdate',
        data: {
          diskUsage: { primary: { mountpoint: '/', totalGB: 39, usedGB: 37, percent: 96.2 } },
          diskAlert: { warningPercent: 85, errorPercent: 95 },
        },
      })
    })

    const items = useNotificationStore.getState().items
    expect(items).toHaveLength(1)
    expect(items[0]?.type).toBe('criticalDisk')
    expect(items[0]?.content).toContain('磁盘空间严重不足')
  })

  it('systemStatsUpdate 缺阈值 → 不生成磁盘告警（不退回前端自带数字）', async () => {
    useConnectionStore.setState({ baseUrl: '', apiKey: 'k1', status: 'ready' })
    const wrapper = createWrapper()
    renderHook(() => useServerSocket('i-1'), { wrapper })
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1))
    const ws = FakeWebSocket.instances[0]!
    act(() => {
      openAndAuth(ws)
    })
    await flushMicrotasks()

    act(() => {
      ws.receive({
        type: 'systemStatsUpdate',
        data: {
          diskUsage: { primary: { mountpoint: '/', totalGB: 39, usedGB: 37, percent: 96.2 } },
        },
      })
    })

    expect(useNotificationStore.getState().items).toHaveLength(0)
  })

  it('systemStatsUpdate 的整机内存越阈值 → highMemory（读数与阈值同源）', async () => {
    const ws = await connectReady('i-1')

    act(() => {
      ws.receive({
        type: 'systemStatsUpdate',
        data: { memoryPercent: 93.4, memoryAlert: { warningPercent: 90 } },
      })
    })

    const items = useNotificationStore.getState().items
    expect(items).toHaveLength(1)
    expect(items[0]?.type).toBe('highMemory')
    // 阈值来自载荷（90）而非前端兜底（80）：93.4 < 90 才是「不该告警」；
    // 若错用前端 80，同一读数同样告警，故这里用「低于前端兜底、高于服务端阈值」的读数
    expect(items[0]?.content).toContain('93.4%')
  })

  it('服务端阈值高于读数 → 不告警（证明用的是载荷阈值而非前端兜底 80）', async () => {
    const ws = await connectReady('i-1')

    act(() => {
      ws.receive({
        type: 'systemStatsUpdate',
        data: { memoryPercent: 85, memoryAlert: { warningPercent: 90 } },
      })
    })

    // 85 > 前端兜底 80 却 < 服务端 90 ⇒ 无告警。这一条正是「阈值走契约」的判据：
    // 若前端拿自己的 80 判，这里会错误地产生一条 highMemory
    expect(useNotificationStore.getState().items).toHaveLength(0)
  })

  it('systemStatsUpdate 缺 memoryAlert → 不生成内存告警（不退回前端自带数字）', async () => {
    const ws = await connectReady('i-1')

    act(() => {
      ws.receive({ type: 'systemStatsUpdate', data: { memoryPercent: 99 } })
    })

    expect(useNotificationStore.getState().items).toHaveLength(0)
  })

  it('整机内存与磁盘可同时告警（两条链路同源下发，互不吞并）', async () => {
    const ws = await connectReady('i-1')

    act(() => {
      ws.receive({
        type: 'systemStatsUpdate',
        data: {
          memoryPercent: 95,
          memoryAlert: { warningPercent: 90 },
          diskUsage: { primary: { mountpoint: '/', totalGB: 39, usedGB: 37, percent: 96.2 } },
          diskAlert: { warningPercent: 85, errorPercent: 95 },
        },
      })
    })

    const types = useNotificationStore
      .getState()
      .items.map((i) => i.type)
      .sort()
    expect(types).toEqual(['criticalDisk', 'highMemory'])
  })

  it('deployProgress 透传 instanceId（取消部署要按实例 id 精确匹配服务端注册表）', async () => {
    const ws = await connectReady('i-1')

    act(() => {
      ws.receive({
        type: 'deployProgress',
        data: {
          stage: 'download',
          percent: 0.2,
          transferred: 2,
          total: 10,
          instanceId: 'paper-abc1',
          instanceName: '演示实例',
        },
      })
    })

    expect(useDeployStore.getState().progress?.instanceId).toBe('paper-abc1')
  })

  it('deployCancelled 终态事件入通知中心，并收敛部署中视图', async () => {
    const ws = await connectReady('i-1')
    act(() => {
      useDeployStore.getState().applyDeployProgress({
        stage: 'download',
        percent: 0.2,
        transferred: 2,
        total: 10,
        instanceId: 'paper-abc1',
        instanceName: '演示实例',
      })
    })

    act(() => {
      ws.receive({
        type: 'deployCancelled',
        data: { stage: 'cancelled', instanceId: 'paper-abc1', instanceName: '演示实例' },
      })
    })

    // 通知中心可见（用户离开向导后的唯一得知通道）
    const items = useNotificationStore.getState().items
    expect(items[0]?.type).toBe('deployCancelled')
    expect(items[0]?.content).toBe('实例「演示实例」部署已取消')
  })

  it('名单变化：只失效重取，不落通知条目（面板自己的操作不该在通知中心出现两条）', async () => {
    useConnectionStore.setState({ baseUrl: '', apiKey: 'k1', status: 'ready' })
    useAuthStore.setState({ session: makeSession('token-1') })

    // 在渲染前换成探针：hook 在 render 时捕获 action 引用，之后再换就测不到了
    const dispatchSpy = vi.fn()
    useNotificationStore.setState({ dispatchWsEvent: dispatchSpy as never })

    const wrapper = createWrapper()
    // 先在缓存里放两个名单类查询（列表 + 封禁记录），否则「失效」无对象可标
    wrapper.qc.setQueryData(queryKeys.players('i-1'), [])
    wrapper.qc.setQueryData([...queryKeys.players('i-1'), 'bans'], [])
    const listKey = queryKeys.players('i-1')

    renderHook(() => useServerSocket('i-1'), { wrapper })
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1))
    const ws = FakeWebSocket.instances[0]!
    act(() => {
      openAndAuth(ws)
    })
    await flushMicrotasks()

    act(() => {
      ws.receive({
        type: 'nameListChanged',
        instanceId: 'i-1',
        data: { list: 'bans', action: 'added', target: 'Steve' },
      })
    })
    await flushMicrotasks()

    // 失效重取：名单类查询全部落在 players 前缀下（列表与封禁记录一起被标脏）
    expect(wrapper.qc.getQueryState(listKey)?.isInvalidated).toBe(true)
    expect(wrapper.qc.getQueryState([...queryKeys.players('i-1'), 'bans'])?.isInvalidated).toBe(
      true,
    )
    // 不落条目：面板自身封禁已给过反馈，这里再落一条就是双报
    expect(dispatchSpy).not.toHaveBeenCalled()
  })
})
