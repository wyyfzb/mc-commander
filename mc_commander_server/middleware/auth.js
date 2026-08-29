import crypto from 'crypto';
import config from '../config.js';
import { ErrorCodes, error } from '../utils/response.js';
import { AdminSessionModel } from '../db/index.js';
import { hashToken } from '../utils/password.js';

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
    if (!safeEqual(apiKey, config.apiKey)) {
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

export function authenticateWebSocket(apiKey) {
  if (!apiKey) return false;
  return safeEqual(apiKey, config.apiKey);
}

export default { authMiddleware, authenticateWebSocket };
