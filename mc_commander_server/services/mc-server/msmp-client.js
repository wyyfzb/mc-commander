/**
 * MSMP（Minecraft Server Management Protocol）客户端。
 *
 * 只服务**查询面**：MSMP 没有执行控制台命令的方法（实测 26.1 的 `rpc.discover`
 * 共 85 个方法，名字匹配 run/command/execute 的为 0 个），所以命令通道永远走
 * RCON/stdin，本模块不参与。它替代的是「读结构化事实」这一类来源——例如在线名单：
 * RCON 给的是要解析的单行文本，MSMP 给的是 `Array<{id, name}>`。
 *
 * 认证只用 `Authorization: Bearer <secret>`。另一条 `Sec-WebSocket-Protocol` 路径
 * 受 `management-server-allowed-origins` 门控，而该键默认为空，实测那条路径必然
 * 401（补 `Origin` 头也无效）——它是浏览器用的通道，不是本模块的退路。
 *
 * 协议要点（实测 26.1）：参数按位置包在单元素数组里（`params: [[...]]`）；
 * `result` 是**裸值**，外面没有信封；`server/status` 的 `players` 字段在名单为空时
 * **整个键缺席**（不是空数组），消费方不得假定它存在。
 */

import { WebSocket } from 'ws';

/** 探测超时：握手 + 一次 `server/status`，回环链路上远快于此 */
const MSMP_PROBE_TIMEOUT_MS = 2000;
/** 取数据超时：比探测宽松，避免服务端忙于保存世界时误判不可用 */
const MSMP_QUERY_TIMEOUT_MS = 3000;

/**
 * 服务端自己播报的绑定行。`management-server-port` 默认 0＝启动时随机分配，
 * 此时面板无从预知端口，只能取服务端播报的实际值。
 * 实测原文：`Starting json RPC server on localhost:25585`。
 */
const MSMP_BIND_LINE_RE =
  /(?:Starting json RPC server|Json-RPC Management connection listening) on .*:(\d+)/;

/**
 * 解析 MSMP 端点，并回报**为什么没有端点**。
 *
 * 分原因是为了让调用方分得清两件完全不同的事：`disabled` 是用户的决定（不该空转重试），
 * `no-secret` / `no-port` 只是还没到点（值得在窗口内等一小会儿）。
 *
 * **每次重读 server.properties**，与 `isRconConnected` 同一口径：文件会被 files 路由、
 * 游戏内命令与面板代开流程改写，构造时缓存的那份可能已经过期。端口则**默认是 0**
 * （实测 26.3：`management-server-port=0` 时服务端打印 `Starting json RPC server on
 * localhost:0`，真实端口只出现在紧接着的 `Json-RPC Management connection listening on
 * localhost:41997`，且**不会写回文件**）⇒ 端口只能从播报行取，也**不缓存**（不钉住），
 * 每次按当时的事实重新解析。
 *
 * @returns {{endpoint: {host: string, port: number, secret: string, tls: boolean} | null,
 *   reason: 'disabled' | 'no-secret' | 'no-port' | null}}
 */
export function _msmpResolveEndpointResult() {
  const fresh = this._loadProperties?.();
  if (fresh && Object.keys(fresh).length > 0) this.properties = fresh;
  const props = this.properties || {};
  if (props['management-server-enabled'] !== 'true') return { endpoint: null, reason: 'disabled' };
  const secret = props['management-server-secret'];
  if (!secret) return { endpoint: null, reason: 'no-secret' };
  const host = props['management-server-host'] || 'localhost';
  let port = Number.parseInt(props['management-server-port'] || '0', 10);
  if (!Number.isInteger(port) || port <= 0) port = this._msmpPortFromLog();
  if (!port) return { endpoint: null, reason: 'no-port' };
  return {
    endpoint: { host, port, secret, tls: props['management-server-tls-enabled'] === 'true' },
    reason: null,
  };
}

/**
 * 从 server.properties + 运行日志解析出可连接的 MSMP 端点。
 * @returns {{host: string, port: number, secret: string, tls: boolean} | null}
 *   MSMP 未开启 / 缺密钥 / 端口未知时返回 null（不产生任何网络开销）
 */
export function _msmpResolveEndpoint() {
  return this._msmpResolveEndpointResult().endpoint;
}

/** 从已摄取日志里取 MSMP 实际绑定的端口（仅 `port=0` 随机分配时需要）。 */
export function _msmpPortFromLog() {
  const buffer = this.logBuffer || [];
  for (let i = buffer.length - 1; i >= 0; i--) {
    const match = MSMP_BIND_LINE_RE.exec(buffer[i].text);
    if (match) return Number.parseInt(match[1], 10);
  }
  return null;
}

/**
 * 发一次 JSON-RPC 调用，用完即断。
 *
 * 每次调用各建一条连接：MSMP 是本机回环上的自家进程，握手成本可忽略，而
 * 常驻连接要处理重连、半开、服务端重启这一整套状态机——本模块只做只读查询，
 * 不值得为它引入连接生命周期。将来接推送通知时再改成常驻。
 *
 * @returns {Promise<unknown | null>} 失败一律 null（调用方按「取不到」处理）
 */
export function _msmpRequest(method, params = [], timeoutMs = MSMP_QUERY_TIMEOUT_MS) {
  const endpoint = this._msmpResolveEndpoint();
  if (!endpoint) return Promise.resolve(null);

  return new Promise((resolve) => {
    let socket = null;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        /* 连接可能已销毁 */
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();

    const scheme = endpoint.tls ? 'wss' : 'ws';
    try {
      socket = new WebSocket(`${scheme}://${endpoint.host}:${endpoint.port}`, [], {
        headers: { Authorization: `Bearer ${endpoint.secret}` },
        // 连接目标是本机回环上的自家 MC 进程，不是用户提供的外部 URL，也不是
        // url-guard 覆盖的 webhook 链路：MSMP 的证书来自用户自建的 keystore
        // （默认自签），严格校验必然失败。放开校验只在这条回环链路上成立。
        rejectUnauthorized: false,
        handshakeTimeout: timeoutMs,
      });
    } catch {
      return finish(null);
    }

    socket.on('open', () => {
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
    });
    socket.on('message', (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return finish(null);
      }
      // 通知没有 id：本模块不订阅通知，忽略即可（不得当成响应）
      if (message.id !== 1) return;
      finish(message.error ? null : message.result);
    });
    // 401（认证失败）、超时、服务端重启一律归为「取不到」
    socket.on('error', () => finish(null));
    socket.on('close', () => finish(null));
  });
}

/**
 * 探测 MSMP 是否此刻可用：握手成功且 `server/status` 可调。
 *
 * 判据是**握手**而非版本号：服务端可能没开 MSMP、端口随机、或经反代，
 * 版本号推不出可用性。世界加载窗口内 `rpc.discover` 与 `server/status` 仍可调，
 * 故用 `status` 作探测既能确认通道、又不受「服务器还没起来」影响。
 */
export async function _msmpProbe() {
  if (!this.isRunning) return false;
  const status = await this._msmpRequest('minecraft:server/status', [], MSMP_PROBE_TIMEOUT_MS);
  return !!status && typeof status.started === 'boolean';
}

/**
 * 取在线名单（结构化）。
 * @returns {Promise<{names: string[]} | null>} 取不到返回 null
 */
export async function _msmpFetchOnlinePlayers() {
  if (!this.isRunning) return null;
  const players = await this._msmpRequest('minecraft:players', []);
  // 不认识这个返回值（协议变了/被中间层改了）时按「取不到」处理，
  // 不能当成空名单——把名单清空正是要避免的方向
  if (!Array.isArray(players)) return null;
  const names = [];
  for (const entry of players) {
    if (entry && typeof entry.name === 'string' && entry.name) names.push(entry.name);
  }
  return { names };
}
