import crypto from 'crypto';
import config from '../config.js';
import { ErrorCodes, error } from '../utils/response.js';
import { AdminSessionModel } from '../db/index.js';
import { hashToken } from '../utils/password.js';

/** 恒时比对 API Key：对入站明文做 SHA-256 后与存储的哈希比较 */
function verifyApiKey(incomingKey) {
  const storedHash = config.apiKeyHash;
  if (!storedHash) return false;
  const incomingHash = hashToken(incomingKey);
  return safeEqual(incomingHash, storedHash);
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * 登录前必须可达的公开端点（req.path 相对挂载点 /api/，尾部斜杠归一化）：
 * - /v1/auth/status：登录页探测是否已设密（未认证时的唯一信息面）
 * - /v1/auth/setup：首访设密（未设密才允许，路由层二次校验）
 * - /v1/auth/login：登录换取会话令牌
 */
const PUBLIC_ENDPOINTS = new Set(['/v1/auth/status', '/v1/auth/login', '/v1/auth/setup']);

/** 滑动续期写库节流：距上次触达超过该值才刷新 expires_at（降低写放大） */
const SESSION_TOUCH_INTERVAL_MS = 60_000;

export function authMiddleware(req, res, next) {
  // 不处理 Upgrade: websocket 请求：真实 WS 升级由 Node http server 的 upgrade 事件处理（不经过本中间件），WS 认证由 handleProtocols + authenticateWebSocket 独立完成，与此中间件无关。
  const relPath = (req.path || '').replace(/\/+$/, '') || '/';
  if (PUBLIC_ENDPOINTS.has(relPath)) {
    return next();
  }

  // 通道一：API Key（自动化 / API 调用通道，与既有行为完全兼容）
  const apiKey = req.headers['x-api-key'];
  if (apiKey != null) {
    if (!verifyApiKey(apiKey)) {
      return res.status(401).json(error(
        ErrorCodes.INVALID_API_KEY,
        'Invalid API Key'
      ));
    }
    req.auth = { source: 'apiKey', key: apiKey };
    return next();
  }

  // 通道二：管理员会话（安全主线：浏览器登录后持 Bearer 令牌，替代明文 Key 直连）
  const authHeader = req.headers['authorization'];
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (!token) {
      return res.status(401).json(error(ErrorCodes.AUTH_SESSION_EXPIRED, '会话凭据缺失，请重新登录'));
    }
    const session = AdminSessionModel.findByTokenHash(hashToken(token));
    if (!session) {
      return res.status(401).json(error(ErrorCodes.AUTH_SESSION_EXPIRED, '会话不存在或已登出，请重新登录'));
    }
    if (new Date(session.expires_at).getTime() <= Date.now()) {
      AdminSessionModel.deleteById(session.id);
      return res.status(401).json(error(ErrorCodes.AUTH_SESSION_EXPIRED, '会话已过期，请重新登录'));
    }
    // 滑动续期（节流写库）
    if (Date.now() - new Date(session.last_seen_at).getTime() > SESSION_TOUCH_INTERVAL_MS) {
      AdminSessionModel.touch(session.id, new Date(Date.now() + config.adminSession.ttlMs).toISOString());
    }
    req.auth = { source: 'session', sessionId: session.id, userAgent: session.user_agent, ip: session.ip };
    return next();
  }

  return res.status(401).json(error(
    ErrorCodes.INVALID_API_KEY,
    'API Key is required. Use X-API-Key header or Bearer session token.'
  ));
}

/**
 * WebSocket 升级认证（双通道，与 authMiddleware 的 HTTP 语义对齐）：
 * - 通道一：API Key（handleProtocols 提取的 mc-commander-apikey.* subprotocol）
 * - 通道二：管理员会话令牌（mc-commander-session.* subprotocol）——
 *   浏览器会话化后 WS 握手不再依赖明文 API Key，与 HTTP Bearer 同源凭据。
 *   会话需存在且未过期；不在此处 touch 续期（重连频率不可控，避免绕过
 *   HTTP 通道的 60s 写库节流），会话活性由 HTTP Bearer 请求持续滑动续期。
 *   校验失败一律返回 false，由调用方以 1008 关闭。
 * @param {string|null} apiKey
 * @param {string|null} sessionToken 明文会话令牌（内部立即做 SHA-256，不留存）
 * @returns {boolean}
 */
export function authenticateWebSocket(apiKey, sessionToken = null) {
  if (apiKey) {
    return verifyApiKey(apiKey);
  }
  if (sessionToken) {
    const session = AdminSessionModel.findByTokenHash(hashToken(sessionToken));
    if (!session) return false;
    if (new Date(session.expires_at).getTime() <= Date.now()) {
      // 过期会话顺手清理（与 HTTP 中间件的惰性清理语义一致）
      AdminSessionModel.deleteById(session.id);
      return false;
    }
    return true;
  }
  return false;
}

export default { authMiddleware, authenticateWebSocket };
