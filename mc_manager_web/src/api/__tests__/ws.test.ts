import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { McSocket, type WebSocketLike, type WebSocketCtor } from '../ws'

/**
 * FakeWebSocket：记录消息并支持脚本化触发事件（契约测试用）
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

describe('McSocket（对照服务端 websocket.js 契约）', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('握手携带 subprotocol 鉴权（mc-commander-apikey.<key>）', async () => {
    const socket = new McSocket({ apiKey: 'secret-key-123', WebSocketImpl: FakeCtor })
    const p = socket.connect()
    const ws = FakeWebSocket.instances[0]!
    expect(ws.url).toMatch(/\/ws$/)
    expect(ws.protocols).toEqual(['mc-commander-apikey.secret-key-123'])
    ws.open()
    await p
    expect(socket.isOpen).toBe(true)
  })

  it('会话令牌优先：subprotocol 切换为 mc-commander-session.<token>', async () => {
    const socket = new McSocket({
      apiKey: 'secret-key-123',
      sessionToken: 'session-token-abc',
      WebSocketImpl: FakeCtor,
    })
    const p = socket.connect()
    const ws = FakeWebSocket.instances[0]!
    expect(ws.protocols).toEqual(['mc-commander-session.session-token-abc'])
    ws.open()
    await p
    expect(socket.isOpen).toBe(true)
  })

  it('仅会话令牌（无 API Key）也能握手（密码登录用户）', async () => {
    const socket = new McSocket({ apiKey: '', sessionToken: 'only-token', WebSocketImpl: FakeCtor })
    const p = socket.connect()
    const ws = FakeWebSocket.instances[0]!
    expect(ws.protocols).toEqual(['mc-commander-session.only-token'])
    ws.open()
    await p
    expect(socket.isOpen).toBe(true)
  })

  it('subscribe 发送 {type:subscribe, instanceId, lastEventId?}；首次无游标不带 lastEventId', async () => {
    const socket = new McSocket({ apiKey: 'k', WebSocketImpl: FakeCtor })
    const p = socket.connect()
    FakeWebSocket.instances[0]!.open()
    await p

    socket.subscribe('instance-1')
    const msg = JSON.parse(FakeWebSocket.instances[0]!.sent[0]!) as Record<string, unknown>
    expect(msg).toEqual({ type: 'subscribe', instanceId: 'instance-1' })
  })

  it('收到带 eventId 的通知事件后更新游标，重连订阅携带 lastEventId', async () => {
    const socket = new McSocket({ apiKey: 'k', WebSocketImpl: FakeCtor })
    const p = socket.connect()
    const ws = FakeWebSocket.instances[0]!
    ws.open()
    await p

    socket.subscribe('instance-1')
    ws.receive({ type: 'playerJoin', eventId: 42, instanceId: 'instance-1', data: {} })

    // 模拟断开重连：新实例订阅恢复
    socket.close()
    socket.connect().catch(() => {})
    const ws2 = FakeWebSocket.instances[1]!
    ws2.open()
    const msg = JSON.parse(ws2.sent[0]!) as Record<string, unknown>
    expect(msg).toMatchObject({ type: 'subscribe', instanceId: 'instance-1', lastEventId: 42 })
  })

  it('事件处理器收到消息；解绑后不再收到', async () => {
    const socket = new McSocket({ apiKey: 'k', WebSocketImpl: FakeCtor })
    const p = socket.connect()
    FakeWebSocket.instances[0]!.open()
    await p

    const handler = vi.fn()
    const off = socket.on(handler)
    FakeWebSocket.instances[0]!.receive({ type: 'tpsUpdate', instanceId: 'i', data: { tps: 20 } })
    expect(handler).toHaveBeenCalledTimes(1)
    off()
    FakeWebSocket.instances[0]!.receive({ type: 'tpsUpdate', instanceId: 'i', data: { tps: 19 } })
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
      FakeWebSocket.instances[0]!.open()
      await p1

      const p2 = socket.connect()
      expect(p2).toBe(p1)
      expect(FakeWebSocket.instances.length).toBe(1)
      await p2
      expect(socket.isOpen).toBe(true)
    })

    it('connect 幂等：CONNECTING 期间重复调用复用同一 promise，不产生双连接', async () => {
      const socket = new McSocket({ apiKey: 'k', WebSocketImpl: FakeCtor })
      const p1 = socket.connect()
      const p2 = socket.connect()
      expect(p2).toBe(p1)
      expect(FakeWebSocket.instances.length).toBe(1)
      FakeWebSocket.instances[0]!.open()
      await Promise.all([p1, p2])
      expect(socket.isOpen).toBe(true)
    })

    it('事件不重复派发：双 connect 场景订阅消息只发送一次', async () => {
      const socket = new McSocket({ apiKey: 'k', WebSocketImpl: FakeCtor })
      const p1 = socket.connect()
      void socket.connect()
      FakeWebSocket.instances[0]!.open()
      await p1

      const handler = vi.fn()
      socket.on(handler)
      socket.subscribe('i-1')
      expect(handler).toHaveBeenCalledTimes(0) // subscribe 不派发事件给 handler
      FakeWebSocket.instances[0]!.receive({ type: 'playerJoin', eventId: 1, instanceId: 'i-1', data: {} })
      expect(handler).toHaveBeenCalledTimes(1)

      const subscribeCount = FakeWebSocket.instances[0]!.sent.filter(
        (m) => (JSON.parse(m) as { type: string }).type === 'subscribe',
      ).length
      expect(subscribeCount).toBe(1)
    })

    it('close() 后 connect() 可重建（重新登录可再建），旧实例事件不再派发', async () => {
      const socket = new McSocket({ apiKey: 'k', WebSocketImpl: FakeCtor })
      const p1 = socket.connect()
      FakeWebSocket.instances[0]!.open()
      await p1

      socket.close()
      expect(socket.isOpen).toBe(false)

      const p2 = socket.connect()
      expect(FakeWebSocket.instances.length).toBe(2)
      const ws2 = FakeWebSocket.instances[1]!
      expect(ws2.protocols).toEqual(['mc-commander-apikey.k'])
      ws2.open()
      await p2
      expect(socket.isOpen).toBe(true)

      // 旧连接已被清理：即使误触发其事件回调也不会派发（handler 已解绑）
      const handler = vi.fn()
      socket.on(handler)
      FakeWebSocket.instances[0]!.receive({ type: 'playerJoin', eventId: 2, instanceId: 'i', data: {} })
      expect(handler).toHaveBeenCalledTimes(0)
      FakeWebSocket.instances[1]!.receive({ type: 'playerJoin', eventId: 3, instanceId: 'i', data: {} })
      expect(handler).toHaveBeenCalledTimes(1)
    })

    it('断线重连：定时触发前清死连接，重建仅产生一个新 WebSocket（防重连风暴叠加）', async () => {
      vi.useFakeTimers()
      try {
        const socket = new McSocket({ apiKey: 'k', WebSocketImpl: FakeCtor })
        const p = socket.connect()
        FakeWebSocket.instances[0]!.open()
        await p

        // 模拟服务端断开（非用户关闭）
        FakeWebSocket.instances[0]!.onclose?.({ code: 1006, reason: 'abnormal' })
        expect(FakeWebSocket.instances.length).toBe(1)

        await vi.advanceTimersByTimeAsync(1_000)
        expect(FakeWebSocket.instances.length).toBe(2)
        const ws2 = FakeWebSocket.instances[1]!
        expect(ws2.protocols).toEqual(['mc-commander-apikey.k'])
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
        FakeWebSocket.instances[0]!.open()
        await p

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
})
