import config from '../config.js';
import { ErrorCodes, error } from '../utils/response.js';
import { AdminSessionModel } from '../db/index.js';
import { hashToken, safeEqual } from '../utils/password.js';
import { parseDbTime } from '../utils/db-time.js';
import { logger } from '../utils/logger.js';

/** 直连 IP（日志用；与锁定键同源，不信任可伪造的代理头） */
function clientIp(req) {
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * 401 分支补日志（此前认证失败全静默，爆破不可见）。
 * 级别分档：无效凭据（key 错 / 令牌未知 / 头缺失）= 潜在攻击信号 → warn；
 * 会话正常生命周期（到期 / 绝对过期）= 客户端会自动重登 → debug。
 * 日志只含 IP 与路径，永不记录凭据/令牌本体。
 */
function logAuthRejection(req, reason, level = 'warn', status = 401) {
  logger[level](`[auth] ${status} ${reason} ip=${clientIp(req)} path=${req.path}`);
}

/** 恒时比对 API Key：对入站明文做 SHA-256 后与存储的哈希比较。
 * safeEqual 复用 utils/password.js 的 SHA-256 归一化实现（P2-6：
 * 消除长度不等路径的提前返回，任意输入耗时一致） */
function verifyApiKey(incomingKey) {
  const storedHash = config.apiKeyHash;
  if (!storedHash) return false;
  const incomingHash = hashToken(incomingKey);
  return safeEqual(incomingHash, storedHash);
}

/**
 * 恒时比对只读 Key：与 verifyApiKey 同款（摘要比对 + 恒时）。
 * 未配置 READONLY_API_KEY_HASH 时恒返回 false —— 通道不存在，而不是「不校验」；
 * 因此不会出现「空哈希与空输入相等」而意外放行的路径
 */
function verifyReadonlyApiKey(incomingKey) {
  const storedHash = config.readonlyApiKeyHash;
  if (!storedHash) return false;
  const incomingHash = hashToken(incomingKey);
  return safeEqual(incomingHash, storedHash);
}

/**
 * 登录前必须可达的公开端点（req.path 相对挂载点 /api/，尾部斜杠归一化）：
 * - /v1/auth/status：登录页探测是否已设密（未认证时的唯一信息面）
 * - /v1/auth/setup：首访设密（未设密才允许，路由层二次校验）
 * - /v1/auth/login：登录换取会话令牌
 */
export const PUBLIC_ENDPOINTS = new Set(['/v1/auth/status', '/v1/auth/login', '/v1/auth/setup']);

/** 滑动续期写库节流：距上次触达超过该值才刷新 expires_at（降低写放大） */
const SESSION_TOUCH_INTERVAL_MS = 60_000;

/**
 * 会话创建时刻（epoch ms）。created_at 由 SQLite CURRENT_TIMESTAMP 写入——无时区
 * 标记的 UTC 串，必须经 parseDbTime 归一化：裸 new Date() 按本地时区解释，UTC+8
 * 下会把绝对过期边界前移 8 小时。
 * 取不到（列缺失/格式异常）返回 0，调用方按「不施加绝对上限」处理——不据此把
 * 会话判死，否则旧库缺列时全部会话会在下一次请求即失效（admin 会被锁在门外，
 * 只能走 API Key 通道自救）；主过期由 expires_at 兜底不受影响。
 */
function sessionCreatedAt(session) {
  return parseDbTime(session.created_at);
}

/**
 * 会话绝对过期判定（P2-11）：无论滑动续期多久，自创建起超过
 * absoluteTtlMs 后会话必须重新登录（限制被窃取令牌的永久有效窗口）。
 * 导出供跨时区用例直接断言（`auth-session-time.test.js` 在子进程固定 TZ 复算）。
 * @returns {boolean} true = 已达绝对过期
 */
export function isAbsolutelyExpired(session) {
  const absoluteTtlMs = config.adminSession.absoluteTtlMs;
  if (!(absoluteTtlMs > 0)) return false; // 0/负值 = 关闭绝对过期（不建议）
  const createdAt = sessionCreatedAt(session);
  if (!createdAt) return false;
  return Date.now() >= createdAt + absoluteTtlMs;
}

/**
 * 滑动续期目标过期时间（P2-11）：不超过 created_at + absoluteTtlMs 上限，
 * 防止活跃会话的续期无限推迟绝对重登边界。
 * absoluteTtlMs 为 0/负值（关闭绝对过期）时不参与 cap，与 isAbsolutelyExpired
 * 的守卫语义一致：否则 absolute = created_at（过去时刻）会把续期目标写回
 * 创建时刻，下一次请求即被判过期删除——「关闭绝对过期」退化为会话自毁。
 * created_at 取不到时同样不 cap（见 sessionCreatedAt）。
 */
export function slidingExpiry(session) {
  const sliding = Date.now() + config.adminSession.ttlMs;
  const absoluteTtlMs = config.adminSession.absoluteTtlMs;
  if (!(absoluteTtlMs > 0)) return new Date(sliding).toISOString();
  const createdAt = sessionCreatedAt(session);
  if (!createdAt) return new Date(sliding).toISOString();
  return new Date(Math.min(sliding, createdAt + absoluteTtlMs)).toISOString();
}

export function authMiddleware(req, res, next) {
  // 不处理 Upgrade: websocket 请求：真实 WS 升级由 Node http server 的 upgrade 事件处理（不经过本中间件），WS 认证由 handleProtocols + authenticateWebSocket 独立完成，与此中间件无关。
  const relPath = (req.path || '').replace(/\/+$/, '') || '/';
  if (PUBLIC_ENDPOINTS.has(relPath)) {
    // 显式标记公开角色：角色门只放行「有角色」的请求，装配不变量由此变成代码事实——
    // 少了这一步，任何未经本中间件的请求都会带着 undefined 抵达角色门
    req.auth = { source: 'public', role: 'public' };
    return next();
  }

  // 通道一：API Key（自动化 / API 调用通道，与既有行为完全兼容）
  // API_KEY_ENABLED=false 时整条通道 fail-closed：不校验、不降级，直接拒绝并
  // 指引会话登录（关掉自动化凭据的部署形态下，浏览器通道是唯一正常入口）
  // 空白 header（`X-API-Key: `、`"   "`）视同「未提供凭据」：按 40101 报「Key 无效」
  // 会把从环境变量取值的脚本引向轮换一把其实没问题的 Key（与 40107 的定向文案同理）
  const apiKey =
    typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'].trim() : null;
  if (apiKey) {
    // 只读凭据先判定：两条机器通道的开关相互独立，先吃 API_KEY_ENABLED 会把
    // 「关闭管理员 Key」绑架成「只读监控也不可用」；未配置只读哈希时此处恒 false，
    // 既有部署（含 API_KEY_ENABLED=false）的判定顺序与结果逐字不变
    if (verifyReadonlyApiKey(apiKey)) {
      if (!config.readonlyApiKeyEnabled) {
        logAuthRejection(req, 'readonly API key channel disabled', 'warn', 403);
        return res
          .status(403)
          .json(
            error(
              ErrorCodes.READONLY_API_KEY_DISABLED,
              '只读 API Key 通道已关闭，请改用管理员凭据',
            ),
          );
      }
      req.auth = { source: 'apiKey', role: 'readonly', key: apiKey };
      return next();
    }
    if (!config.apiKeyEnabled) {
      logAuthRejection(req, 'API key channel disabled', 'warn', 403);
      return res
        .status(403)
        .json(error(ErrorCodes.API_KEY_DISABLED, 'API Key 通道已关闭，请改用管理员会话登录'));
    }
    if (!verifyApiKey(apiKey)) {
      logAuthRejection(req, 'invalid API key');
      return res.status(401).json(error(ErrorCodes.INVALID_API_KEY, 'Invalid API Key'));
    }
    req.auth = { source: 'apiKey', role: 'admin', key: apiKey };
    return next();
  }

  // 通道二：管理员会话（安全主线：浏览器登录后持 Bearer 令牌，替代明文 Key 直连）
  const authHeader = req.headers['authorization'];
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (!token) {
      logAuthRejection(req, 'empty bearer token');
      return res
        .status(401)
        .json(error(ErrorCodes.AUTH_SESSION_EXPIRED, '会话凭据缺失，请重新登录'));
    }
    const session = AdminSessionModel.findByTokenHash(hashToken(token));
    if (!session) {
      logAuthRejection(req, 'unknown session token');
      return res
        .status(401)
        .json(error(ErrorCodes.AUTH_SESSION_EXPIRED, '会话不存在或已登出，请重新登录'));
    }
    if (new Date(session.expires_at).getTime() <= Date.now()) {
      AdminSessionModel.deleteById(session.id);
      logAuthRejection(req, 'session expired', 'debug');
      return res.status(401).json(error(ErrorCodes.AUTH_SESSION_EXPIRED, '会话已过期，请重新登录'));
    }
    // 绝对过期（P2-11）：created_at + 30d 后强制重登，滑动续期不能绕过
    if (isAbsolutelyExpired(session)) {
      AdminSessionModel.deleteById(session.id);
      logAuthRejection(req, 'session absolute expired', 'debug');
      return res
        .status(401)
        .json(error(ErrorCodes.AUTH_SESSION_EXPIRED, '会话已达到最长存活期，请重新登录'));
    }
    // 滑动续期（节流写库；上限 cap 在绝对过期边界，P2-11）
    // last_seen_at 同为无时区 UTC 串，裸解析在 UTC+8 下恒判「已超 60s」→ 节流失效（每请求写库）
    if (Date.now() - parseDbTime(session.last_seen_at) > SESSION_TOUCH_INTERVAL_MS) {
      AdminSessionModel.touch(session.id, slidingExpiry(session));
    }
    req.auth = {
      source: 'session',
      role: 'admin',
      sessionId: session.id,
      userAgent: session.user_agent,
      ip: session.ip,
    };
    return next();
  }

  logAuthRejection(req, 'missing credentials');
  // 定向文案：此处是「没带凭据」，与「带了但不对」（40101）分开报码——
  // 复用 40101 会让客户端提示「Key 无效或已过期」，把用户引向轮换一把本来没问题的 Key
  return res.status(401).json(error(ErrorCodes.AUTH_CREDENTIALS_REQUIRED));
}

/**
 * 只读角色可达的端点白名单（唯一事实源，逐条理由见 SECURITY.md「只读凭据」）。
 *
 * 判定方向是「不在表里 ⇒ 要求 admin」：新增端点无需在此登记即自动对只读关闭，
 * 逐条列举的是**放行**而非拒绝，所以漏登记只会更严、不会更松。键为
 * `METHOD 路径`，路径相对 v1Router 挂载点（/api/v1）；:param 为任意单段占位。
 * 收录标准：只读监控/仪表盘真正需要的实时状态观测端点，且不返回凭据、文件内容、
 * 日志、配置内容、命令史、备份、会话或审计明细。返回历史/管理记录的一律不收。
 * 白名单只决定「能不能进」，不保证「进来后看到什么」：命中白名单的端点若其响应
 * 含凭据可能驻留的字段，必须在**出参构造处**按角色裁剪（见 routes/status.js 的
 * statusForRole —— /instances 两条即此例）；只加白名单不裁剪等于把该数据交出去。
 */
export const READONLY_ALLOWED = Object.freeze([
  'GET /overview',
  'GET /system-stats',
  'GET /instances',
  'GET /instances/:id',
  'GET /instances/:id/players',
]);

/**
 * 段级匹配：白名单项与请求路径段数必须一致，:param 段接受任意非空段。
 * 路径尾部斜杠在调用前已归一化（与 Express 路由 `strict:false` 一致）：`/instances/`
 * 与 `/instances` 命中同一个已授权处理器，故不算放宽权限面。
 * 空段（`//`）一律不匹配：Express 的 `:param` 不匹配空段，若在此按「过滤空段后比对」
 * 放行，角色门的判断就会比路由表更宽。
 */
function matchesPattern(method, pattern, reqPath) {
  const [patternMethod, patternPath] = pattern.split(' ');
  if (patternMethod !== method) return false;
  const expected = segments(patternPath);
  const actual = segments(reqPath);
  if (expected.includes('') || actual.includes('')) return false;
  if (expected.length !== actual.length) return false;
  return expected.every((seg, i) => seg.startsWith(':') || seg === actual[i]);
}

/** 路径 → 非空段数组（首尾斜杠不产生段） */
function segments(p) {
  const trimmed = p.replace(/^\/+/, '').replace(/\/+$/, '');
  return trimmed === '' ? [] : trimmed.split('/');
}

/**
 * 只读凭据是否可访问该方法+路径（路径相对 v1Router）。
 * 导出供路由表枚举测试直接断言，避免测试另写一份匹配逻辑而与运行时漂移
 */
export function isReadonlyAllowed(method, reqPath) {
  return READONLY_ALLOWED.some((entry) => matchesPattern(method, entry, reqPath));
}

/**
 * fail-closed 角色门（挂载在 routes/index.js 的 v1Router 上，早于全部子 router）：
 * 默认要求 admin，仅命中白名单的请求放行 readonly，公开端点由认证层标记为
 * `role: 'public'` 后放行。
 *
 * **只放行有角色的请求**：`req.auth` 缺失（未经认证层赋值）一律 403。这样「角色门必须
 * 挂在认证层之后」就是代码事实而非装配约定——把 v1Router 复用到别的挂载点时会立刻
 * 全量 403（可见的故障），而不是静默放行所有无凭据请求（不可见的 fail-open）。
 * 角色未知（未来新增角色未在此登记）同样拒绝，不给「角色字段缺失」留口子。
 */
export function requireAdminRole(req, res, next) {
  const role = req.auth?.role;
  if (role === 'admin' || role === 'public') return next();
  const relPath = (req.path || '/').replace(/\/+$/, '') || '/';
  if (role === 'readonly' && isReadonlyAllowed(req.method, relPath)) return next();
  logAuthRejection(req, `role=${role ?? 'none'} denied`, 'warn', 403);
  return res.status(403).json(error(ErrorCodes.AUTH_INSUFFICIENT_ROLE));
}

/**
 * WebSocket 升级认证（双通道，与 authMiddleware 的 HTTP 语义对齐）：
 * - 通道一：API Key（handleProtocols 提取的 mc-commander-apikey.* subprotocol）；
 *   API_KEY_ENABLED=false 时与 HTTP 同款 fail-closed——即使同时带了会话令牌也不
 *   回退到它（关闭通道的语义是「该通道不可用」，而非「尽力而为」）
 * - 通道二：管理员会话令牌（mc-commander-session.* subprotocol）——
 *   浏览器会话化后 WS 握手不再依赖明文 API Key，与 HTTP Bearer 同源凭据。
 *   会话需存在且未过期；不在此处 touch 续期（重连频率不可控，避免绕过
 *   HTTP 通道的 60s 写库节流），会话活性由 HTTP Bearer 请求持续滑动续期。
 *   校验失败一律返回 null，由调用方以 1008 关闭。
 *
 * **返回值携带角色**（Phase 2）：只读凭据不再一律拒握手，而是以
 * `{ role: 'readonly' }` 放行，由 websocket.js 按事件白名单过滤投递面。
 * 返回对象而非 boolean 的必要性：角色必须在连接建立时落定（`ws._role`），
 * 否则每条投递路径都要重验凭据。对象本身是 truthy，既有 `if (!ok)` 调用
 * （心跳会话复验）语义不变。
 * @param {string|null} apiKey
 * @param {string|null} sessionToken 明文会话令牌（内部立即做 SHA-256，不留存）
 * @returns {{role: 'admin'|'readonly'}|null}
 */
export function authenticateWebSocket(apiKey, sessionToken = null) {
  if (apiKey) {
    // 只读凭据先判定（与 HTTP 中间件同序）：两条机器通道开关相互独立，
    // 先吃 API_KEY_ENABLED 会把「关闭管理员 Key」绑架成「只读监控也不可用」
    if (verifyReadonlyApiKey(apiKey)) {
      return config.readonlyApiKeyEnabled ? { role: 'readonly' } : null;
    }
    if (!config.apiKeyEnabled) return null;
    return verifyApiKey(apiKey) ? { role: 'admin' } : null;
  }
  if (sessionToken) {
    const session = AdminSessionModel.findByTokenHash(hashToken(sessionToken));
    if (!session) return null;
    if (new Date(session.expires_at).getTime() <= Date.now()) {
      // 过期会话顺手清理（与 HTTP 中间件的惰性清理语义一致）
      AdminSessionModel.deleteById(session.id);
      return null;
    }
    // 绝对过期同步校验（P2-11）：WS 通道与 HTTP 语义对齐，不给窃取令牌
    // 绕过 HTTP 重登边界的口子
    if (isAbsolutelyExpired(session)) {
      AdminSessionModel.deleteById(session.id);
      return null;
    }
    return { role: 'admin' };
  }
  return null;
}

export default { authMiddleware, authenticateWebSocket };
