import crypto from 'crypto';
import config from '../config.js';
import { ErrorCodes, error } from '../utils/response.js';

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function authMiddleware(req, res, next) {
  // 不处理 Upgrade: websocket 请求：真实 WS 升级由 Node http server 的 upgrade 事件处理（不经过本中间件），WS 认证由 handleProtocols + authenticateWebSocket 独立完成，与此中间件无关。
  const apiKey = req.headers['x-api-key'];

  if (!apiKey) {
    return res.status(401).json(error(
      ErrorCodes.INVALID_API_KEY,
      'API Key is required. Use X-API-Key header.'
    ));
  }

  if (!safeEqual(apiKey, config.apiKey)) {
    return res.status(401).json(error(
      ErrorCodes.INVALID_API_KEY,
      'Invalid API Key'
    ));
  }

  req.apiKey = { key: apiKey };
  next();
}

export function authenticateWebSocket(apiKey) {
  if (!apiKey) return false;
  return safeEqual(apiKey, config.apiKey);
}

export default { authMiddleware, authenticateWebSocket };
