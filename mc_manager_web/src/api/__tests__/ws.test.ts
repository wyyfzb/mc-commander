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
})
