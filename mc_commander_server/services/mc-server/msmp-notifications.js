/**
 * MSMP 通知面（一期）：常驻连接 + 只接两族事件。
 *
 * 与 `msmp-client.js` 的分工：那个模块做**请求/响应**（用完即断，握手成本可忽略），
 * 本模块做**推送**——推送必须常驻，因为服务端只往「已建立的连接」上广播。
 *
 * 协议事实（**全部为实机实测**，MC 26.3；不是照文档推的）：
 * - **无需订阅调用**：连上就推。实测连接后不做任何调用，服务端自身的自动保存照样
 *   推来 `server/saving` → `server/saved`。
 * - **通知是 JSON-RPC 通知的形态**：带 `method`、**没有 `id`**；零参通知的 `params`
 *   **整个键缺席**（不是 `null` 也不是 `[]`）⇒ 消费方必须 `params ?? null`，
 *   否则会像我第一次探针那样直接 `undefined.slice()` 崩掉。
 * - `minecraft:server/save` 需**一个必填布尔** `flush`（`params: [true]`），
 *   传 `[]` 会回 `Invalid params: Expected exactly one element`。
 * - `rpc.discover` 实测列出 89 个方法，其中通知 25 个（本模块只接其中 8 个）。
 *
 * **一期白名单＝实测确认「stdout 没有对应用户可见事件」的那些**。这个范围比原计划窄，
 * 是查了输出解析器之后收窄的（原计划写的「两族都与 stdout 零冲突」**不成立**）：
 *
 * | 通知 | stdout 是否已有对应用户可见事件 |
 * | --- | --- |
 * | `world/upgrade_*` | **无** ✓（唯一真正零冲突、且面板今天零能力的一族） |
 * | `server/stopping` | **无** ✓（解析器未接停机行） |
 * | `server/started` | **有**：解析器 `Done (…)` → `status: {event:'ready'}`（output-parser.js 的存档段） |
 * | `server/saving` / `saved` | **有**：解析器 `Saved the game` → `status: {event:'save'}` |
 *
 * ⇒ 有 stdout 对应物的三条**不进一期**：接了就是两个来源报同一件事，而「谁优先、谁在什么
 * 条件下禁用」正是二期要先定的去重策略。一期刻意只接**构造上不可能重复计数**的那些。
 *
 * ⚠️ 命名上要与面板自己的**jar 升级**区分开：`world/upgrade_*` 是 **MC 世界格式升级**，
 * 与 `INSTANCE_UPGRADE`（换服务端 jar / MC 版本）是两件事。事件名刻意不叫
 * `upgradeProgress`——那个名字已经被面板自己的升级流程占用，同名会让两个来源互相打架。
 */

import { WebSocket } from 'ws';

/** 一期白名单：与 stdout 零冲突的两族 */
export const MSMP_NOTIFICATION_ALLOWLIST = new Set([
  // 世界格式升级：面板今天完全无法呈现的能力，且 stdout 无对应物
  'minecraft:notification/world/upgrade_started',
  'minecraft:notification/world/upgrade_progress',
  'minecraft:notification/world/upgrade_finished',
  'minecraft:notification/world/upgrade_failed',
  // 停机：stdout 侧解析器没接，故也不重复
  'minecraft:notification/server/stopping',
]);

/** 心跳周期：半开连接（对端消失但不发 FIN）不会触发 close，只能靠自己探测 */
const HEARTBEAT_MS = 30_000;
/** 发出 ping 后等 pong 的宽限；超时即判定半开并重连 */
const PONG_GRACE_MS = 10_000;
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
/** 握手超时：回环链路上远快于此 */
const HANDSHAKE_TIMEOUT_MS = 5_000;

/**
 * 建立常驻连接（幂等）。未开启 MSMP / 缺密钥 / 端口未知时不产生任何网络开销。
 */
export function _msmpNotifStart() {
  if (this._msmpNotifActive) return;
  this._msmpNotifActive = true;
  this._msmpNotifBackoffMs = RECONNECT_BASE_MS;
  this._msmpNotifConnect();
}

/** 关闭常驻连接并停止重连（实例停止/卸载时调用） */
export function _msmpNotifStop() {
  this._msmpNotifActive = false;
  this._msmpNotifClearTimers();
  const socket = this._msmpNotifSocket;
  this._msmpNotifSocket = null;
  if (socket) {
    // 先摘监听再关，否则 close 回调会把「主动关闭」当成掉线又去重连
    try {
      socket.removeAllListeners();
      socket.close();
    } catch {
      /* 连接可能已销毁 */
    }
  }
}

/** 清掉心跳与重连定时器（stop 与重连前都要清，避免定时器堆积） */
export function _msmpNotifClearTimers() {
  if (this._msmpNotifHeartbeat) {
    clearInterval(this._msmpNotifHeartbeat);
    this._msmpNotifHeartbeat = null;
  }
  if (this._msmpNotifPongTimer) {
    clearTimeout(this._msmpNotifPongTimer);
    this._msmpNotifPongTimer = null;
  }
  if (this._msmpNotifReconnectTimer) {
    clearTimeout(this._msmpNotifReconnectTimer);
    this._msmpNotifReconnectTimer = null;
  }
}

/** 建一条连接。失败一律走 `_msmpNotifScheduleReconnect`，不向外抛。 */
export function _msmpNotifConnect() {
  if (!this._msmpNotifActive) return;
  const endpoint = this._msmpResolveEndpoint();
  if (!endpoint) {
    // 通道不可用（未开启/未起）——不空转重连，等下次实例启动或用户开启后再来
    this._msmpNotifActive = false;
    return;
  }

  const scheme = endpoint.tls ? 'wss' : 'ws';
  let socket;
  try {
    socket = new WebSocket(`${scheme}://${endpoint.host}:${endpoint.port}`, [], {
      headers: { Authorization: `Bearer ${endpoint.secret}` },
      // 与 msmp-client.js 同一口径：目标是本机回环上的自家 MC 进程，证书多为自签，
      // 严格校验必然失败。放开校验只在这条回环链路上成立（host 默认 localhost）。
      rejectUnauthorized: false,
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    });
  } catch {
    return this._msmpNotifScheduleReconnect();
  }
  this._msmpNotifSocket = socket;

  socket.on('open', () => {
    this._msmpNotifBackoffMs = RECONNECT_BASE_MS;
    this._msmpNotifAlive = true;
    this._msmpNotifHeartbeat = setInterval(() => this._msmpNotifPing(), HEARTBEAT_MS);
    this._msmpNotifHeartbeat.unref?.();
  });
  socket.on('message', (data) => this._msmpNotifHandleMessage(data));
  socket.on('pong', () => {
    this._msmpNotifAlive = true;
    if (this._msmpNotifPongTimer) {
      clearTimeout(this._msmpNotifPongTimer);
      this._msmpNotifPongTimer = null;
    }
  });
  socket.on('error', () => this._msmpNotifScheduleReconnect());
  socket.on('close', () => this._msmpNotifScheduleReconnect());
}

/**
 * 心跳：ping 出去后在宽限期内没等到 pong，就判定**半开**（对端静默消失、`close`
 * 永不触发），主动 terminate 让 `close` 走正常重连路径。
 *
 * 这里刻意**不在下一次心跳上再判一次**「上轮没 pong」：宽限期（10s）远短于心跳周期
 * （30s），所以每次 ping 的宽限定时器都先于下一次心跳到期，那条分支永远走不到
 * （变异探针证实：把它删掉测试全绿）。留两套判据只会让读者以为存在两条路径。
 */
export function _msmpNotifPing() {
  const socket = this._msmpNotifSocket;
  if (!socket) return;
  this._msmpNotifAlive = false;
  try {
    socket.ping();
  } catch {
    /* 发送失败交由 close/error 路径处理 */
  }
  if (this._msmpNotifPongTimer) clearTimeout(this._msmpNotifPongTimer);
  this._msmpNotifPongTimer = setTimeout(() => {
    // 到点即判定半开：真的收到 pong 会在 pong 处理里把这个定时器清掉，
    // 所以「到这里还活着」这种情形不存在，不必再判一次 alive
    // （变异探针证实：加上那个判断删掉它测试都全绿）。
    try {
      this._msmpNotifSocket?.terminate();
    } catch {
      /* 可能已销毁 */
    }
  }, PONG_GRACE_MS);
  this._msmpNotifPongTimer.unref?.();
}

/** 指数退避重连（上限 RECONNECT_MAX_MS）。stop 之后不再排新的一次。 */
export function _msmpNotifScheduleReconnect() {
  if (!this._msmpNotifActive) return;
  this._msmpNotifClearTimers();
  const socket = this._msmpNotifSocket;
  this._msmpNotifSocket = null;
  if (socket) {
    try {
      socket.removeAllListeners();
      socket.terminate();
    } catch {
      /* 可能已销毁 */
    }
  }
  const delay = this._msmpNotifBackoffMs ?? RECONNECT_BASE_MS;
  this._msmpNotifBackoffMs = Math.min(delay * 2, RECONNECT_MAX_MS);
  this._msmpNotifReconnectTimer = setTimeout(() => this._msmpNotifConnect(), delay);
  this._msmpNotifReconnectTimer.unref?.();
}

/**
 * 处理一条入站消息。
 *
 * 只认「带 `method` 的通知」；带 `id` 的响应不属于本模块（本模块不发请求）直接忽略。
 * 非白名单的通知也忽略——一期刻意只接两族，接多了就要先解决与 stdout 的去重。
 */
export function _msmpNotifHandleMessage(data) {
  let message;
  try {
    message = JSON.parse(data.toString());
  } catch {
    return; // 非 JSON 一律丢弃：协议会演进，解析失败不该影响连接
  }
  const method = message?.method;
  if (typeof method !== 'string') return;
  if (!MSMP_NOTIFICATION_ALLOWLIST.has(method)) return;

  // 零参通知的 params **整个键缺席**（实测），故统一成 null 再交给消费方
  const params = message.params ?? null;
  this.emit('msmpNotification', { method, params });
}
