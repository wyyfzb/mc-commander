/**
 * WebSocket 封装（设计文档 §5.1 ws.ts）
 * 契约（服务端 websocket.js）：
 *  - 鉴权（首帧通道，主线）：连接建立后客户端第一条消息必须是
 *    {type:'auth', apiKey? | sessionToken?}，服务端校验通过回执
 *    {type:'auth', ok:true}，失败/超时/首条非 auth 一律 close(1008)。
 *    1008 + auth 类 reason 为终态：不自动重连（无效凭据重试会把自己
 *    撞进服务端 IP 封禁），凭据变更由上层凭据比对后重建连接。
 *    旧 subprotocol 通道（mc-commander-apikey./mc-commander-session.）
 *    服务端继续接受（向后兼容），客户端不再使用。
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
const WS_CONNECTING = 0
const WS_OPEN = 1

const MAX_RECONNECT_DELAY_MS = 30_000
const RECONNECT_BASE_DELAY_MS = 1_000
const LAST_EVENT_KEY_PREFIX = 'mcs-ws-last-event'
/** 连接挂起超时：CONNECTING 态超过该时长视为死连接（首连挂起时
 *  原生 WebSocket 可能既不 open 也不 error，UI 会永远停留在「连接中」） */
export const WS_CONNECT_TIMEOUT_MS = 15_000
/** 鉴权回执等待超时：open 后服务端须在此时限内回 auth 回执（与服务端
 *  pending 超时同量级；超时主动 close 走重连，服务端正常时不可达） */
export const WS_AUTH_TIMEOUT_MS = 10_000

type MessageHandler = (msg: WsMessage) => void

interface McSocketOptions {
  /** 连接地址（ws://host:port/ws），默认同源推导 */
  url?: string
  /** 面板 baseUrl（远程部署时用于推导 ws 地址；空串=同源） */
  baseUrl?: string
  /** API Key（自动化通道；与会话令牌二选一，会话令牌优先） */
  apiKey: string
  /** 管理员会话令牌（安全主线：浏览器登录后与 HTTP Bearer 同源凭据） */
  sessionToken?: string | null
  WebSocketImpl?: WebSocketCtor
  /** 连接生命周期回调（open/close 边沿；UI 指示器与降级横幅的数据源） */
  onStateChange?: (state: { open: boolean }) => void
}

/** WS 鉴权 subprotocol 前缀（服务端向后兼容通道仍接受；客户端已改走首帧鉴权） */
export const WS_APIKEY_PROTOCOL_PREFIX = 'mc-commander-apikey.'
export const WS_SESSION_PROTOCOL_PREFIX = 'mc-commander-session.'

/** 按凭据选择鉴权 subprotocol（会话优先，回退 API Key）——兼容通道用，客户端主线不走 */
export function resolveAuthProtocol(apiKey: string, sessionToken?: string | null): string | null {
  if (sessionToken) return `${WS_SESSION_PROTOCOL_PREFIX}${sessionToken}`
  if (apiKey) return `${WS_APIKEY_PROTOCOL_PREFIX}${apiKey}`
  return null
}

export class McSocket {
  private ws: WebSocketLike | null = null
  /** 进行中/已建立连接的 connect promise（幂等锚点：重复 connect 复用同一连接，防双 WebSocket） */
  private connectPromise: Promise<void> | null = null
  private readonly url: string
  private readonly apiKey: string
  private readonly sessionToken: string | null
  private readonly WebSocketImpl: WebSocketCtor
  private handlers = new Set<MessageHandler>()
  private subscribed = new Set<string>()
  /** 本连接已成功发送 subscribe 的实例（onopen 后重置：新连接需全部重发） */
  private subscribedSent = new Set<string>()
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private connectTimeoutTimer: ReturnType<typeof setTimeout> | null = null
  private authTimeoutTimer: ReturnType<typeof setTimeout> | null = null
  /** 首帧鉴权是否已通过（auth-ok 到达前不派发事件、不发送订阅） */
  private authenticated = false
  private closedByUser = false
  private readonly onStateChange: McSocketOptions['onStateChange']

  constructor(options: McSocketOptions) {
    this.apiKey = options.apiKey
    this.sessionToken = options.sessionToken ?? null
    this.url = options.url ?? deriveWsUrl(options.baseUrl)
    this.WebSocketImpl = options.WebSocketImpl ?? (WebSocket as unknown as WebSocketCtor)
    this.onStateChange = options.onStateChange
  }

  /** 比对连接凭据是否一致（单例复用方检测凭据变更：改密/踢单设备/换账号/登出） */
  credentialsMatch(options: { apiKey: string; sessionToken?: string | null }): boolean {
    return this.apiKey === options.apiKey && this.sessionToken === (options.sessionToken ?? null)
  }

  /** 建立连接并完成首帧鉴权（open 后发 auth 消息，auth-ok 到达才算连上）。
   *  幂等：连接进行中（CONNECTING）或已建立（OPEN）时复用既有 promise，
   *  不再新建 WebSocket —— effect 重跑/重复点重连按钮不会产生双连接、事件不会重复派发 */
  connect(): Promise<void> {
    if (
      this.connectPromise &&
      this.ws &&
      (this.ws.readyState === WS_CONNECTING || this.ws.readyState === WS_OPEN)
    ) {
      return this.connectPromise
    }
    if (!this.apiKey && !this.sessionToken) {
      return Promise.reject(new Error('连接凭据未配置（API Key 或会话令牌）'))
    }
    // 重建前清理旧连接：断开/半开的旧 socket 先关掉，事件不再派发，防重连风暴叠加
    this.disposeSocket()
    const promise = new Promise<void>((resolve, reject) => {
      const ws = new this.WebSocketImpl(this.url)
      this.ws = ws
      // 连接挂起看门狗：CONNECTING 超时视为死连接，主动 close
      // （close 回调清锚点并进入指数退避重连）——否则 UI 永远停在「连接中」
      this.connectTimeoutTimer = setTimeout(() => {
        if (this.ws === ws && ws.readyState === WS_CONNECTING) {
          try {
            ws.close()
          } catch {
            // 竞态安全：close 失败仍走 reject，由上层重建
          }
          reject(new Error('WebSocket 连接超时'))
        }
      }, WS_CONNECT_TIMEOUT_MS)

      ws.onopen = () => {
        this.clearConnectTimeout()
        this.reconnectAttempts = 0
        // 首帧鉴权：open 后立即发 auth（绕过 isOpen 门控直接 send），auth-ok 到达才 resolve/open 派发
        try {
          ws.send(
            JSON.stringify({
              type: 'auth',
              ...(this.sessionToken
                ? { sessionToken: this.sessionToken }
                : { apiKey: this.apiKey }),
            }),
          )
        } catch {
          // 发送失败由 onclose 走重连
        }
        this.authTimeoutTimer = setTimeout(() => {
          if (!this.authenticated && this.ws === ws) {
            try {
              ws.close()
            } catch {
              // 竞态安全：close 失败仍走 reject，由上层重建
            }
            reject(new Error('WebSocket 认证超时'))
          }
        }, WS_AUTH_TIMEOUT_MS)
      }
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as WsMessage
          // 鉴权回执：ok 才算连上（失败路径由服务端 close 1008 处理，不回执）
          if (msg.type === 'auth') {
            if (msg.ok) {
              this.finishAuth(ws)
              resolve()
            }
            return
          }
          if (!this.authenticated) return
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
        this.clearConnectTimeout()
        this.clearAuthTimeout()
        // 连接已终止：幂等锚点失效，允许后续 connect() 重建
        const wasPending = this.connectPromise === promise
        this.clearConnectPromise(promise)
        this.authenticated = false
        this.onStateChange?.({ open: false })
        // 鉴权失败类 1008 为终态：不自动重连——无效凭据的重试会把自己撞进
        // 服务端 IP 封禁；凭据变更由上层凭据比对后重建连接
        if (this.isAuthRejection(ev.code, ev.reason)) {
          if (wasPending) reject(new Error('WebSocket 认证失败'))
          return
        }
        if (wasPending) reject(new Error('WebSocket 连接失败'))
        if (!this.closedByUser) {
          this.scheduleReconnect()
        }
      }
      ws.onerror = () => {
        this.clearConnectPromise(promise)
        // onclose 随后触发，统一走重连逻辑
        reject(new Error('WebSocket 连接失败'))
      }
    })
    this.connectPromise = promise
    return promise
  }

  /** 鉴权完成：派发 open 边沿 + 重发全部订阅（resolve 由 onmessage 闭包执行） */
  private finishAuth(ws: WebSocketLike): void {
    if (this.authenticated || this.ws !== ws) return
    this.authenticated = true
    this.clearAuthTimeout()
    // 新连接：清发送标记后重发全部订阅（携带各实例断线补齐游标）
    this.subscribedSent.clear()
    for (const instanceId of this.subscribed) {
      this.sendSubscribe(instanceId)
    }
    this.onStateChange?.({ open: true })
  }

  /** 认证失败类 1008 终态判断（Unauthorized/Auth timeout/Too many auth failures/
   *  Session invalidated）——重试只会再次失败并把自己撞进服务端 IP 封禁 */
  private isAuthRejection(code: number, reason: string): boolean {
    return code === 1008 && (/auth/i.test(reason) || reason === 'Session invalidated')
  }

  /** 订阅实例（幂等；同一连接内不重复发送订阅消息，断线重连自动恢复） */
  subscribe(instanceId: string): void {
    this.subscribed.add(instanceId)
    if (this.isOpen && this.subscribedSent.has(instanceId)) return
    this.sendSubscribe(instanceId)
  }

  unsubscribe(instanceId: string): void {
    this.subscribed.delete(instanceId)
    this.subscribedSent.delete(instanceId)
    this.sendRaw({ type: 'unsubscribe', instanceId })
  }

  /** 注册事件处理器；返回解绑函数 */
  on(handler: MessageHandler): () => void {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  /** 主动关闭（不再重连；登出/凭据重建时调用，重连定时器一并清空） */
  close(): void {
    this.closedByUser = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.clearConnectTimeout()
    this.connectPromise = null
    this.disposeSocket()
    this.onStateChange?.({ open: false })
  }

  get isOpen(): boolean {
    // 「可用」= 首帧鉴权已通过且 socket 处于 OPEN——鉴权前发送的 subscribe 会被
    // 服务端 pending 管线计数并断开，必须以 authenticated 门控
    return this.authenticated && this.ws?.readyState === WS_OPEN
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
    const ok = this.sendRaw({
      type: 'subscribe',
      instanceId,
      ...(lastEventId > 0 ? { lastEventId } : {}),
    })
    if (ok) this.subscribedSent.add(instanceId)
  }

  private sendRaw(msg: Record<string, unknown>): boolean {
    if (!this.isOpen) return false
    try {
      this.ws?.send(JSON.stringify(msg))
      return true
    } catch {
      // 连接竞态：忽略（重连逻辑会恢复订阅）
      return false
    }
  }

  private saveLastEventId(instanceId: string, eventId: number): void {
    try {
      localStorage.setItem(`${LAST_EVENT_KEY_PREFIX}-${instanceId}`, String(eventId))
    } catch {
      // 忽略持久化失败
    }
  }

  private clearConnectTimeout(): void {
    if (this.connectTimeoutTimer) {
      clearTimeout(this.connectTimeoutTimer)
      this.connectTimeoutTimer = null
    }
  }

  private clearAuthTimeout(): void {
    if (this.authTimeoutTimer) {
      clearTimeout(this.authTimeoutTimer)
      this.authTimeoutTimer = null
    }
  }

  /** 清理当前连接：解绑事件处理器（旧 socket 事件不再派发）+ 关闭 + 置空引用 */
  private disposeSocket(): void {
    this.authenticated = false
    this.clearAuthTimeout()
    const stale = this.ws
    this.ws = null
    if (!stale) return
    stale.onopen = null
    stale.onmessage = null
    stale.onclose = null
    stale.onerror = null
    try {
      stale.close()
    } catch {
      // 竞态安全：close 失败不影响后续重建
    }
  }

  /** 幂等锚点失效（连接已终止时），允许后续 connect() 重建 */
  private clearConnectPromise(p: Promise<void>): void {
    if (this.connectPromise === p) {
      this.connectPromise = null
    }
  }

  /** 指数退避重连（1s → 2s → 4s → … 上限 30s）；触发时先清死连接，防重连风暴叠加 */
  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer) return
    this.disposeSocket()
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
  const protocol =
    base.startsWith('https:') || base.startsWith('wss:')
      ? 'wss:'
      : typeof window !== 'undefined' && window.location.protocol === 'https:'
        ? 'wss:'
        : 'ws:'
  if (base.startsWith('ws')) return base.replace(/\/+$/, '') + '/ws'
  if (base) return base.replace(/^https?:/, protocol) + '/ws'
  const host = typeof window !== 'undefined' ? window.location.host : 'localhost:25566'
  return `${protocol}//${host}/ws`
}
