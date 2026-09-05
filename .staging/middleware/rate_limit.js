import { ErrorCodes, error } from '../utils/response.js';
import config from '../config.js';

// 简单的内存速率限制
// 记录结构：key -> { hits: number[], lastSeen: number, windowMs: number }
// - hits：窗口内请求时间戳数组
// - lastSeen：最后一次请求时间，用于 LRU 淘汰与窗口级空闲清理
// - windowMs：该键所属限流实例的窗口大小（创建时记录）
const rateLimitMap = new Map();

// 限流 Map 容量上限（LRU 约 10000 键）：防止攻击者用随机 key（随机 x-api-key
// 或伪造 IP 头）无限撑爆内存；超限时淘汰最久未使用的键
const DEFAULT_MAX_KEYS = 10000;

// 获取真实连接 IP：req.socket.remoteAddress 取自 TCP 层，客户端无法伪造
// （trust proxy=1 时 req.ip 取自客户端可控的 X-Forwarded-For，不可作为默认键）
function getRealIp(req) {
  return (req.socket && req.socket.remoteAddress) || req.ip || 'unknown';
}

// 超限时淘汰最久未使用的键（LRU），一次淘汰到上限的 75% 以留缓冲，
// 避免高流量时每次请求都触发全表遍历
function evictToLimit(maxKeys) {
  const targetSize = Math.max(1, Math.floor(maxKeys * 0.75));
  while (rateLimitMap.size > targetSize) {
    let oldestKey = null;
    let oldestSeen = Infinity;
    for (const [key, record] of rateLimitMap.entries()) {
      if (record.lastSeen < oldestSeen) {
        oldestSeen = record.lastSeen;
        oldestKey = key;
      }
    }
    if (oldestKey === null) break;
    rateLimitMap.delete(oldestKey);
  }
}

// 窗口级清理：删除空闲超过其自身窗口两倍的键（空闲键能更快被回收，活跃键不受影响）
function pruneExpired(now = Date.now()) {
  for (const [key, record] of rateLimitMap.entries()) {
    if (now - record.lastSeen > record.windowMs * 2) {
      rateLimitMap.delete(key);
    }
  }
}

export function rateLimit(options = {}) {
  const windowMs = options.windowMs || config.rateLimit.windowMs;
  const max = options.max || config.rateLimit.max;
  const maxKeys = options.maxKeys || DEFAULT_MAX_KEYS;
  // 默认使用真实连接 IP（req.socket.remoteAddress，不可伪造）
  const keyGenerator = options.keyGenerator || ((req) => getRealIp(req));

  return (req, res, next) => {
    const key = keyGenerator(req);
    const now = Date.now();
    const windowStart = now - windowMs;

    // 获取该 key 的请求记录（不存在则创建）
    let record = rateLimitMap.get(key);
    if (!record) {
      record = { hits: [], lastSeen: now, windowMs };
      rateLimitMap.set(key, record);
    }
    record.lastSeen = now;

    // 清理窗口外的过期请求记录
    record.hits = record.hits.filter(time => time > windowStart);

    // 检查是否超过限制
    if (record.hits.length >= max) {
      const retryAfter = Math.ceil((record.hits[0] + windowMs - now) / 1000);

      res.setHeader('X-RateLimit-Limit', max);
      res.setHeader('X-RateLimit-Remaining', 0);
      res.setHeader('X-RateLimit-Reset', Math.ceil((record.hits[0] + windowMs) / 1000));
      res.setHeader('Retry-After', retryAfter);

      return res.status(429).json(error(
        ErrorCodes.RATE_LIMITED,
        `Too many requests, please try again after ${retryAfter} seconds`
      ));
    }

    // 添加当前请求时间
    record.hits.push(now);
    rateLimitMap.set(key, record);

    // 容量上限保护：超过 maxKeys 时淘汰最久未使用的键（LRU），
    // 防止恶意随机键（随机 x-api-key / 伪造 IP）导致内存 DoS
    if (rateLimitMap.size > maxKeys) {
      evictToLimit(maxKeys);
    }

    // 设置响应头
    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', max - record.hits.length);
    res.setHeader('X-RateLimit-Reset', Math.ceil((record.hits[0] + windowMs) / 1000));

    next();
  };
}

// 针对 API Key 的速率限制
export function apiKeyRateLimit(options = {}) {
  return rateLimit({
    ...options,
    keyGenerator: (req) => {
      const apiKey = req.headers['x-api-key'];
      // 对 x-api-key 截断 128 字符：x-api-key 完全由客户端控制，
      // 超长随机值（如几十 KB）会无限撑爆 Map，截断后同一键只能落在有限桶内
      const truncated = apiKey ? String(apiKey).slice(0, 128) : '';
      return `apikey:${truncated || getRealIp(req)}`;
    }
  });
}

// 定期清理过期数据 (每分钟)
// .unref()：模块级定时器不应阻止事件循环自然退出（服务器停机/测试子进程
// 加载该模块时，进程无需等待此 interval 即可退出）；进程存活期间定时清理照常生效。
// 清理周期为窗口级：键空闲超过其自身 windowMs×2 即删除。
setInterval(() => {
  pruneExpired();
}, 60 * 1000).unref();

// 以下内部接口仅供测试使用，不构成对外 API
export function _clearRateLimitMap() {
  rateLimitMap.clear();
}

export function _getRateLimitMapSize() {
  return rateLimitMap.size;
}

export function _pruneExpired(now = Date.now()) {
  pruneExpired(now);
}

export default { rateLimit, apiKeyRateLimit };
