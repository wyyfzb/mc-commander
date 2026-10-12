/**
 * 认证失败 IP 临时封禁（内存级 LRU，HTTP 登录与 WS 握手共用）
 *
 * 同一份管理员凭据（管理员密码 / API Key / 会话令牌）在两条通道上被爆破：
 * HTTP 登录（routes/auth.js）与 WS 升级（websocket.js）。封禁状态必须共享，
 * 否则攻击者可把失败流量分流到不受限的通道绕开锁定。
 *
 * 进程重启即清零（配合全局速率限流双层防护，与既有登录锁定同口径）；
 * 容量上限对齐 rate_limit.js 的 LRU 模式，防止恶意随机 IP 无界撑爆内存。
 * 锁定键始终取直连 IP（socket.remoteAddress），不信任可伪造的代理头。
 */
import config from '../config.js';

const MAX_KEYS = 10000;
const failures = new Map(); // key: ip → { count, lockedUntil, lastSeen }

/** IP 是否处于锁定窗口内（无记录 / 已过锁定到期时间 = 未锁定） */
export function isLocked(ip) {
  const f = failures.get(ip);
  return Boolean(f?.lockedUntil && f.lockedUntil > Date.now());
}

/** 超限时淘汰最久未访问的条目（LRU），一次淘汰到上限的 75% 留缓冲 */
function evictFailures() {
  const targetSize = Math.max(1, Math.floor(MAX_KEYS * 0.75));
  while (failures.size > targetSize) {
    let oldestKey = null;
    let oldestSeen = Infinity;
    for (const [key, f] of failures.entries()) {
      if (f.lastSeen < oldestSeen) {
        oldestSeen = f.lastSeen;
        oldestKey = key;
      }
    }
    if (oldestKey === null) break;
    failures.delete(oldestKey);
  }
}

/**
 * 记录一次认证失败；连续失败达到阈值（config.adminSession.loginLockMaxFails）
 * 即锁定 config.adminSession.loginLockMs 时长。
 * @returns {boolean} 本次记录后是否处于锁定状态（供调用方一次性告警，避免每请求刷日志）
 */
export function recordFailure(ip) {
  const f = failures.get(ip) || { count: 0, lockedUntil: 0, lastSeen: 0 };
  f.count += 1;
  f.lastSeen = Date.now();
  if (f.count >= config.adminSession.loginLockMaxFails) {
    f.lockedUntil = Date.now() + config.adminSession.loginLockMs;
  }
  failures.set(ip, f);
  // 容量保护：超限时 LRU 淘汰
  if (failures.size > MAX_KEYS) {
    evictFailures();
  }
  return Boolean(f.lockedUntil && f.lockedUntil > Date.now());
}

/** 认证成功：清除该 IP 的失败计数（失败计数只衡量连续失败） */
export function clearFailures(ip) {
  failures.delete(ip);
}

// ── 测试钩子（生产代码不调用；进程重启同样等效清零）──

/** 测试钩子：清空锁定状态 */
export function resetForTests() {
  failures.clear();
}

/** 测试钩子：获取 Map 大小（容量上限验证） */
export function sizeForTests() {
  return failures.size;
}

/** 测试钩子：模拟失败记录（容量淘汰 + 正常锁定路径测试用） */
export function recordFailureForTests(ip) {
  return recordFailure(ip);
}

/** 测试钩子：查询 IP 是否被锁定 */
export function isLockedForTests(ip) {
  return isLocked(ip);
}

/** 测试钩子：清除指定 IP 的失败记录 */
export function clearFailuresForTests(ip) {
  clearFailures(ip);
}
