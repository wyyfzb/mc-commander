/**
 * WebSocket 封装（设计文档 §5.1 ws.ts）
 * 契约（服务端 websocket.js）：
 *  - 鉴权：subprotocol `mc-commander-apikey.<apiKey>`（握手失败 1008）
 *  - 消息：{type:'subscribe'|'unsubscribe'|'ping', instanceId?, lastEventId?}
 *  - 订阅即回 status 快照；通知事件带自增 id（断线补齐游标，上限 500 条）
 *  - 服务端 30s ping 心跳；客户端消息限速 60 条/分钟
 *  - 重连节流：同一实例 5s 内重放一次
 * WebSocket 实现可注入（测试友好，vitest 用 FakeWebSocket）
 */
import type { WsMessage } from './types'

export type { WsMessage }

/** 可注入的 WebSocket 构造器（默认全局 WebSocket） */
export type WebSocketCtor = new (url: string, protocols?: string | string[]) => WebSocketLike

export interface WebSocketLike {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: string }) => void) | null
  onclose: ((ev: { code: number; reason: string }) => void) | null
  onerror: ((ev: unknown) => void) | null
}

/** 原生 WebSocket 常量（测试环境可能没有） */
const WS_OPEN = 1

const MAX_RECONNECT_DELAY_MS = 30_000
const RECONNECT_BASE_DELAY_MS = 1_000
const LAST_EVENT_KEY_PREFIX = 'mcs-ws-last-event'

type MessageHandler = (msg: WsMessage) => void

interface McSocketOptions {
  /** 连接地址（ws://host:port/ws），默认同源推导 */
  url?: string
  /** 面板 baseUrl（远程部署时用于推导 ws 地址；空串=同源） */
  baseUrl?: string
  apiKey: string
  WebSocketImpl?: WebSocketCtor
}

export class McSocket {
  private ws: WebSocketLike | null = null
  private readonly url: string
  private readonly apiKey: string
  private readonly WebSocketImpl: WebSocketCtor
  private handlers = new Set<MessageHandler>()
  private subscribed = new Set<string>()
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private closedByUser = false

  constructor(options: McSocketOptions) {
    this.apiKey = options.apiKey
    this.url = options.url ?? deriveWsUrl(options.baseUrl)
    this.WebSocketImpl = options.WebSocketImpl ?? (WebSocket as unknown as WebSocketCtor)
  }

  /** 建立连接（subprotocol 鉴权） */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.apiKey) {
        reject(new Error('API Key 未配置'))
        return
      }
      const ws = new this.WebSocketImpl(this.url, [`mc-commander-apikey.${this.apiKey}`])
      this.ws = ws

      ws.onopen = () => {
        this.reconnectAttempts = 0
        // 重连后恢复订阅（携带各实例断线补齐游标）
        for (const instanceId of this.subscribed) {
          this.sendSubscribe(instanceId)
        }
        resolve()
      }
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as WsMessage
          if (msg.type === 'pong') return
          // 通知事件携带自增 id：更新游标（断线补齐锚点）
          if (msg.eventId !== undefined && msg.instanceId) {
            this.saveLastEventId(msg.instanceId, msg.eventId)
          }
          for (const handler of this.handlers) {
            handler(msg)
          }
        } catch {
          // 非法消息忽略（服务端已限速，本地只消费）
        }
      }
      ws.onclose = (ev) => {
        if (!this.closedByUser) {
          this.scheduleReconnect()
        }
        void ev
      }
      ws.onerror = () => {
        // onclose 随后触发，统一走重连逻辑
        reject(new Error('WebSocket 连接失败'))
      }
    })
  }

  /** 订阅实例（幂等；断线后重连自动恢复） */
  subscribe(instanceId: string): void {
    this.subscribed.add(instanceId)
    this.sendSubscribe(instanceId)
  }

  unsubscribe(instanceId: string): void {
    this.subscribed.delete(instanceId)
    this.sendRaw({ type: 'unsubscribe', instanceId })
  }

  /** 注册事件处理器；返回解绑函数 */
  on(handler: MessageHandler): () => void {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  /** 主动关闭（不再重连） */
  close(): void {
    this.closedByUser = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.ws?.close()
    this.ws = null
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WS_OPEN
  }

  /** 读取某实例的断线补齐游标（通知事件自增 id） */
  getLastEventId(instanceId: string): number {
    try {
      const raw = localStorage.getItem(`${LAST_EVENT_KEY_PREFIX}-${instanceId}`)
      const n = Number(raw)
      return Number.isFinite(n) && n > 0 ? n : 0
    } catch {
      return 0
    }
  }

  private sendSubscribe(instanceId: string): void {
    if (!this.isOpen) return
    const lastEventId = this.getLastEventId(instanceId)
    this.sendRaw({
      type: 'subscribe',
      instanceId,
      ...(lastEventId > 0 ? { lastEventId } : {}),
    })
  }

  private sendRaw(msg: Record<string, unknown>): void {
    if (!this.isOpen) return
    try {
      this.ws?.send(JSON.stringify(msg))
    } catch {
      // 连接竞态：忽略（重连逻辑会恢复订阅）
    }
  }

  private saveLastEventId(instanceId: string, eventId: number): void {
    try {
      localStorage.setItem(`${LAST_EVENT_KEY_PREFIX}-${instanceId}`, String(eventId))
    } catch {
      // 忽略持久化失败
    }
  }

  /** 指数退避重连（1s → 2s → 4s → … 上限 30s） */
  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer) return
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempts,
      MAX_RECONNECT_DELAY_MS,
    )
    this.reconnectAttempts += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect().catch(() => {
        // 连接失败由 onclose 继续驱动重连
      })
    }, delay)
  }
}

/** 同源推导：/ws（dev 走 Vite proxy；生产同源托管） */
export function deriveWsUrl(baseUrl = ''): string {
  const base = baseUrl.replace(/\/+$/, '')
  const protocol = base.startsWith('https:') || base.startsWith('wss:')
    ? 'wss:'
    : typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  if (base.startsWith('ws')) return base.replace(/\/+$/, '') + '/ws'
  if (base) return base.replace(/^https?:/, protocol) + '/ws'
  const host = typeof window !== 'undefined' ? window.location.host : 'localhost:25566'
  return `${protocol}//${host}/ws`
}
