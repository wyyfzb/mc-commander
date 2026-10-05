import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  McSocket,
  WS_CONNECT_TIMEOUT_MS,
  WS_AUTH_TIMEOUT_MS,
  type WebSocketLike,
  type WebSocketCtor,
} from '../ws'

/**
 * FakeWebSocket：记录消息并支持脚本化触发事件（契约测试用）。
 * 首帧鉴权：open 后客户端发送 {type:'auth', ...}，服务端回
 * {type:'auth', ok:true} 后 connect promise 才 resolve。
 * 凭据值为结构占位（k/t 家族短串，非真实密钥），严禁真实服务器信息
 */
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
    // 模拟真实 WebSocket：close 异步派发 onclose（McSocket 看门狗/断线
    // 重连依赖 onclose 驱动，Fake 不派发会让重连链路在测试里死掉）
    queueMicrotask(() => this.onclose?.({ code: 1006, reason: 'closed by test' }))
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

describe('McSocket（对照服务端 websocket.js 契约，首帧鉴权）', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** 打开最近一条连接并完成首帧鉴权（断言 auth 消息形态），返回该 FakeWebSocket */
  async function openAndAuth(
    _socket: McSocket,
    p: Promise<void>,
    authFields: Record<string, unknown> = { apiKey: 'k' },
  ): Promise<FakeWebSocket> {
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!
    ws.open()
    const authMsg = JSON.parse(ws.sent[0]!) as Record<string, unknown>
    expect(authMsg.type).toBe('auth')
    expect(authMsg).toMatchObject(authFields)
    ws.receive({ type: 'auth', ok: true })
    await p
    return ws
  }

  it('连接不带 subprotocol：open 后首帧发送 {type:auth, apiKey}，auth-ok 后才算连上', async () => {
    const socket = new McSocket({ apiKey: 'k', WebSocketImpl: FakeCtor })
    const p = socket.connect()
    const ws = FakeWebSocket.instances[0]!
    expect(ws.url).toMatch(/\/ws$/)
    // 客户端不再经 subprotocol 传凭据（凭据走首帧消息，代理剥离协议头也能连）
    expect(ws.protocols).toBeUndefined()

    ws.open()
    // auth-ok 之前：未 resolve、isOpen false（防鉴权前发出 subscribe）
    let resolved = false
    void p.then(() => {
      resolved = true
    })
    await Promise.resolve()
    expect(resolved).toBe(false)
    expect(socket.isOpen).toBe(false)

    const authMsg = JSON.parse(ws.sent[0]!) as Record<string, unknown>
    expect(authMsg).toEqual({ type: 'auth', apiKey: 'k' })
    ws.receive({ type: 'auth', ok: true })
    await p
    expect(resolved).toBe(true)
    expect(socket.isOpen).toBe(true)
  })

  it('首帧 auth 携带 sessionToken（会话令牌优先）', async () => {
    const socket = new McSocket({
      apiKey: 'k',
      sessionToken: 't1',
      WebSocketImpl: FakeCtor,
    })
    const p = socket.connect()
    await openAndAuth(socket, p, { sessionToken: 't1' })
    expect(socket.isOpen).toBe(true)
  })

  it('仅会话令牌（无 API Key，密码登录用户）也能完成首帧鉴权', async () => {
    const socket = new McSocket({ apiKey: '', sessionToken: 't1', WebSocketImpl: FakeCtor })
    const p = socket.connect()
    await openAndAuth(socket, p, { sessionToken: 't1' })
    expect(socket.isOpen).toBe(true)
  })

  it('subscribe 发送 {type:subscribe, instanceId, lastEventId?}；首次无游标不带 lastEventId', async () => {
    const socket = new McSocket({ apiKey: 'k', WebSocketImpl: FakeCtor })
    const p = socket.connect()
    const ws = await openAndAuth(socket, p)

    socket.subscribe('instance-1')
    // sent[0] 为 auth 帧，首个业务消息是 subscribe
    const msg = JSON.parse(ws.sent[1]!) as Record<string, unknown>
    expect(msg).toEqual({ type: 'subscribe', instanceId: 'instance-1' })
  })

  it('收到带 eventId 的通知事件后更新游标，重连订阅携带 lastEventId', async () => {
    const socket = new McSocket({ apiKey: 'k', WebSocketImpl: FakeCtor })
    const p = socket.connect()
    const ws = await openAndAuth(socket, p)

    socket.subscribe('instance-1')
    ws.receive({ type: 'playerJoin', eventId: 42, instanceId: 'instance-1', data: {} })

    // 模拟断开重连：新实例订阅恢复
    socket.close()
    const p2 = socket.connect().catch(() => {})
    const ws2 = FakeWebSocket.instances[1]!
    ws2.open()
    ws2.receive({ type: 'auth', ok: true })
    await p2
    const msg = JSON.parse(ws2.sent[1]!) as Record<string, unknown>
    expect(msg).toMatchObject({ type: 'subscribe', instanceId: 'instance-1', lastEventId: 42 })
  })

  it('事件处理器收到消息；解绑后不再收到；auth 回执不派发给 handler', async () => {
    const socket = new McSocket({ apiKey: 'k', WebSocketImpl: FakeCtor })
    const p = socket.connect()
    const ws = await openAndAuth(socket, p)

    const handler = vi.fn()
    const off = socket.on(handler)
    ws.receive({ type: 'performanceUpdate', instanceId: 'i', data: { tps: 20 } })
    expect(handler).toHaveBeenCalledTimes(1)
    off()
    ws.receive({ type: 'performanceUpdate', instanceId: 'i', data: { tps: 19 } })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('未配置任何凭据时 connect 拒绝（API Key 与会话令牌皆空）', async () => {
    const socket = new McSocket({ apiKey: '', WebSocketImpl: FakeCtor })
    await expect(socket.connect()).rejects.toThrow('连接凭据未配置')
  })

  describe('WS 单例治理（issue #311：connect 幂等 + 重建清理 + 登出关闭）', () => {
    it('connect 幂等：OPEN 后重复调用复用同一 promise，仅创建一个 WebSocket（重连按钮防抖）', async () => {
      const socket = new McSocket({ apiKey: 'k', WebSocketImpl: FakeCtor })
      const p1 = socket.connect()
      const ws = await openAndAuth(socket, p1)

      const p2 = socket.connect()
      expect(p2).toBe(p1)
      expect(FakeWebSocket.instances.length).toBe(1)
      await p2
      expect(socket.isOpen).toBe(true)
      void ws
    })

    it('connect 幂等：CONNECTING 期间重复调用复用同一 promise，不产生双连接', async () => {
      const socket = new McSocket({ apiKey: 'k', WebSocketImpl: FakeCtor })
      const p1 = socket.connect()
      const p2 = socket.connect()
      expect(p2).toBe(p1)
      expect(FakeWebSocket.instances.length).toBe(1)
      await openAndAuth(socket, p1)
      expect(socket.isOpen).toBe(true)
    })

    it('事件不重复派发：双 connect 场景订阅消息只发送一次', async () => {
      const socket = new McSocket({ apiKey: 'k', WebSocketImpl: FakeCtor })
      const p1 = socket.connect()
      void socket.connect()
      const ws = await openAndAuth(socket, p1)

      const handler = vi.fn()
      socket.on(handler)
      socket.subscribe('i-1')
      expect(handler).toHaveBeenCalledTimes(0) // subscribe 不派发事件给 handler
      ws.receive({ type: 'playerJoin', eventId: 1, instanceId: 'i-1', data: {} })
      expect(handler).toHaveBeenCalledTimes(1)

      const subscribeCount = ws.sent.filter(
        (m) => (JSON.parse(m) as { type: string }).type === 'subscribe',
      ).length
      expect(subscribeCount).toBe(1)
    })

    it('close() 后 connect() 可重建（重新登录可再建），旧实例事件不再派发', async () => {
      const socket = new McSocket({ apiKey: 'k', WebSocketImpl: FakeCtor })
      const p1 = socket.connect()
      const ws1 = await openAndAuth(socket, p1)

      socket.close()
      expect(socket.isOpen).toBe(false)

      const p2 = socket.connect()
      expect(FakeWebSocket.instances.length).toBe(2)
      const ws2 = FakeWebSocket.instances[1]!
      // 重建连接同样不带 subprotocol，走首帧鉴权
      expect(ws2.protocols).toBeUndefined()
      await openAndAuth(socket, p2, { apiKey: 'k' })
      expect(socket.isOpen).toBe(true)

      // 旧连接已被清理：即使误触发其事件回调也不会派发（handler 已解绑）
      const handler = vi.fn()
      socket.on(handler)
      ws1.receive({ type: 'playerJoin', eventId: 2, instanceId: 'i', data: {} })
      expect(handler).toHaveBeenCalledTimes(0)
      ws2.receive({ type: 'playerJoin', eventId: 3, instanceId: 'i', data: {} })
      expect(handler).toHaveBeenCalledTimes(1)
    })

    it('断线重连：定时触发前清死连接，重建仅产生一个新 WebSocket（防重连风暴叠加）', async () => {
      vi.useFakeTimers()
      try {
        const socket = new McSocket({ apiKey: 'k', WebSocketImpl: FakeCtor })
        const p = socket.connect()
        await openAndAuth(socket, p)

        // 模拟服务端断开（非用户关闭，非鉴权失败）
        FakeWebSocket.instances[0]!.onclose?.({ code: 1006, reason: 'abnormal' })
        expect(FakeWebSocket.instances.length).toBe(1)

        await vi.advanceTimersByTimeAsync(1_000)
        expect(FakeWebSocket.instances.length).toBe(2)
        const ws2 = FakeWebSocket.instances[1]!
        expect(ws2.readyState).toBe(FakeWebSocket.CONNECTING)
        ws2.open()
      } finally {
        vi.useRealTimers()
      }
    })

    it('close() 清空待触发的重连定时器（登出后不再重建）', async () => {
      vi.useFakeTimers()
      try {
        const socket = new McSocket({ apiKey: 'k', WebSocketImpl: FakeCtor })
        const p = socket.connect()
        await openAndAuth(socket, p)

        // 断线 → 安排重连定时器（1s 后）
        FakeWebSocket.instances[0]!.onclose?.({ code: 1006, reason: '' })

        // 用户主动关闭（登出）→ 定时器应被清空
        socket.close()
        await vi.advanceTimersByTimeAsync(60_000)
        expect(FakeWebSocket.instances.length).toBe(1)
      } finally {
        vi.useRealTimers()
      }
    })

    describe('credentialsMatch（单例复用方检测凭据变更）', () => {
      it('apiKey 与 sessionToken 全等时匹配；任一变更不匹配', () => {
        const socket = new McSocket({ apiKey: 'k1', sessionToken: 't1', WebSocketImpl: FakeCtor })
        expect(socket.credentialsMatch({ apiKey: 'k1', sessionToken: 't1' })).toBe(true)
        expect(socket.credentialsMatch({ apiKey: 'k1' })).toBe(false)
        expect(socket.credentialsMatch({ apiKey: 'k2', sessionToken: 't1' })).toBe(false)
        expect(socket.credentialsMatch({ apiKey: 'k2', sessionToken: 't2' })).toBe(false)
      })

      it('无会话令牌的单例：undefined 与 null 视为一致', () => {
        const socket = new McSocket({ apiKey: 'k1', WebSocketImpl: FakeCtor })
        expect(socket.credentialsMatch({ apiKey: 'k1' })).toBe(true)
        expect(socket.credentialsMatch({ apiKey: 'k1', sessionToken: null })).toBe(true)
        expect(socket.credentialsMatch({ apiKey: 'k1', sessionToken: 't2' })).toBe(false)
      })
    })
  })

  describe('连接挂起看门狗与状态回调', () => {
    it('CONNECTING 挂起超时：close 被调用、promise 拒绝、进入重连序列', async () => {
      vi.useFakeTimers()
      try {
        const socket = new McSocket({ apiKey: 'k1', WebSocketImpl: FakeCtor })
        const p = socket.connect()
        const hung = FakeWebSocket.instances[0]!
        const closeSpy = vi.spyOn(hung, 'close')
        const rejection = p.catch((e: Error) => e.message)
        await vi.advanceTimersByTimeAsync(WS_CONNECT_TIMEOUT_MS)
        await expect(rejection).resolves.toBe('WebSocket 连接超时')
        // 死连接被主动关闭（驱动 onclose → 指数退避重连）
        expect(closeSpy).toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1_000)
        // 重连已重建新连接
        expect(FakeWebSocket.instances.length).toBe(2)
      } finally {
        vi.useRealTimers()
      }
    })

    it('鉴权回执等待超时：服务端 open 后不回 auth-ok → close + 拒绝 + 重连', async () => {
      vi.useFakeTimers()
      try {
        const socket = new McSocket({ apiKey: 'k1', WebSocketImpl: FakeCtor })
        const p = socket.connect()
        const ws = FakeWebSocket.instances[0]!
        ws.open() // 发出 auth 后服务端沉默
        const rejection = p.catch((e: Error) => e.message)
        await vi.advanceTimersByTimeAsync(WS_AUTH_TIMEOUT_MS + 1)
        await expect(rejection).resolves.toBe('WebSocket 认证超时')
        await vi.advanceTimersByTimeAsync(1_000)
        expect(FakeWebSocket.instances.length).toBe(2)
      } finally {
        vi.useRealTimers()
      }
    })

    it('鉴权失败（1008 Unauthorized）→ connect 拒绝且不自动重连（防把自己撞进 IP 封禁）', async () => {
      vi.useFakeTimers()
      try {
        const socket = new McSocket({ apiKey: 'bad', WebSocketImpl: FakeCtor })
        const p = socket.connect()
        const ws = FakeWebSocket.instances[0]!
        ws.open()
        const rejection = p.catch((e: Error) => e.message)
        ws.onclose?.({ code: 1008, reason: 'Unauthorized' })
        await expect(rejection).resolves.toBe('WebSocket 认证失败')
        await vi.advanceTimersByTimeAsync(60_000)
        // 终态：无重连尝试
        expect(FakeWebSocket.instances.length).toBe(1)
      } finally {
        vi.useRealTimers()
      }
    })

    it('会话被踢（1008 Session invalidated）同为终态：不自动重连', async () => {
      vi.useFakeTimers()
      try {
        const socket = new McSocket({ apiKey: 'k1', WebSocketImpl: FakeCtor })
        const p = socket.connect()
        await openAndAuth(socket, p, { apiKey: 'k1' })
        FakeWebSocket.instances[0]!.onclose?.({ code: 1008, reason: 'Session invalidated' })
        await vi.advanceTimersByTimeAsync(60_000)
        expect(FakeWebSocket.instances.length).toBe(1)
      } finally {
        vi.useRealTimers()
      }
    })

    it('消息限流 1008（reason 无 auth 语义）不是终态：仍走自动重连', async () => {
      vi.useFakeTimers()
      try {
        const socket = new McSocket({ apiKey: 'k1', WebSocketImpl: FakeCtor })
        const p = socket.connect()
        await openAndAuth(socket, p, { apiKey: 'k1' })
        FakeWebSocket.instances[0]!.onclose?.({ code: 1008, reason: 'Message rate limit exceeded' })
        await vi.advanceTimersByTimeAsync(1_000)
        expect(FakeWebSocket.instances.length).toBe(2)
      } finally {
        vi.useRealTimers()
      }
    })

    it('握手正常完成：看门狗不触发（超时后连接仍存活）', async () => {
      vi.useFakeTimers()
      try {
        const socket = new McSocket({ apiKey: 'k1', WebSocketImpl: FakeCtor })
        const p = socket.connect()
        await openAndAuth(socket, p, { apiKey: 'k1' })
        const closeSpy = vi.spyOn(FakeWebSocket.instances[0]!, 'close')
        await vi.advanceTimersByTimeAsync(WS_CONNECT_TIMEOUT_MS + WS_AUTH_TIMEOUT_MS + 1_000)
        expect(closeSpy).not.toHaveBeenCalled()
        expect(socket.isOpen).toBe(true)
        socket.close()
      } finally {
        vi.useRealTimers()
      }
    })

    it('onStateChange：open/close 边沿各派发一次（degraded 态数据源）', async () => {
      const states: boolean[] = []
      const socket = new McSocket({
        apiKey: 'k1',
        WebSocketImpl: FakeCtor,
        onStateChange: ({ open }) => states.push(open),
      })
      const p = socket.connect()
      await openAndAuth(socket, p, { apiKey: 'k1' })
      FakeWebSocket.instances[0]!.onclose?.({ code: 1006, reason: 'abnormal' })
      expect(states).toEqual([true, false])
      socket.close()
    })

    it('用户主动 close：派发 open=false 但不再自动重连', async () => {
      const states: boolean[] = []
      const socket = new McSocket({
        apiKey: 'k1',
        WebSocketImpl: FakeCtor,
        onStateChange: ({ open }) => states.push(open),
      })
      const p = socket.connect()
      await openAndAuth(socket, p, { apiKey: 'k1' })
      socket.close()
      expect(states).toEqual([true, false])
      expect(FakeWebSocket.instances.length).toBe(1)
    })
  })
})
