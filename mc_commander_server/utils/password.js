import crypto from 'crypto';

/**
 * 管理员密码与令牌哈希工具（安全主线：单管理员密码登录）
 *
 * - 密码：Node 内置 scrypt（零新依赖，与项目极简依赖哲学一致）。
 *   存储格式：`scrypt$N$r$p$<salt b64>$<hash b64>`，参数随格式自描述，
 *   未来调参/换算法（argon2 等）时旧哈希仍可校验并可在改密时透明升级。
 *   当前 N=2^17（OWASP 推荐）；旧参数（如 2^14）哈希校验仍按存储参数
 *   重算，登录成功后由 needsRehash + 调用方透明重哈希升级（P2-5）。
 * - 会话令牌：仅存 SHA-256 摘要——数据库泄露不等于会话泄露（服务端不存明文令牌）。
 */

// scrypt 成本参数（P2-5：16384=2^14 低于 OWASP 推荐 2^17，提至 131072）。
// 哈希校验按存储参数自适应，旧哈希不受本值影响；登录成功后透明升级。
// maxmem：scrypt 内存占用 ≈ 128·N·r = 128MB，Node 默认 32MB 会直接抛
// memory limit exceeded，显式放宽至 192MB（当前参数 1.5 倍余量）
const SCRYPT_N = 131072;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 192 * 1024 * 1024;
const KEY_LEN = 64;

/** 哈希明文密码（随机盐 + 自描述参数编码） */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/**
 * 校验密码：按存储格式解析参数重算后恒时比较（safeEqual：先 SHA-256 归一化，
 * 消除长度不等路径的提前返回——P2-6）。
 * 任何解析/格式异常一律返回 false（不抛出，登录失败语义统一）。
 */
export function verifyPassword(password, stored) {
  try {
    const parts = String(stored).split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, n, r, p, saltB64, hashB64] = parts;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(String(password), salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      // maxmem 按存储参数动态放宽：旧参数 128·N·r 远小于新参数，统一给
      // 1.5 倍余量避免恶意/损坏存储行（超大 N）触发无谓异常路径
      maxmem: Math.max(32 * 1024 * 1024, Math.ceil(128 * Number(n) * Number(r) * 1.5)),
    });
    return safeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * 恒时比较（P2-6）：两侧先做 SHA-256 归一化（32B 定长）再 timingSafeEqual。
 * 原实现长度不等时提前返回 false，攻击者可通过响应时序差异探测存储摘要
 * 长度；归一化后任意输入路径耗时一致，长度信息不再泄漏。
 */
export function safeEqual(a, b) {
  const da = crypto.createHash('sha256').update(String(a)).digest();
  const db = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(da, db);
}

/**
 * 是否需要重哈希升级（P2-5）：存储哈希参数 ≠ 当前参数时返回 true，
 * 由登录路径在验证成功后透明重哈希（旧参数哈希仍可校验，升级不阻塞登录）。
 */
export function needsRehash(stored) {
  try {
    const parts = String(stored).split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    return (
      Number(parts[1]) !== SCRYPT_N ||
      Number(parts[2]) !== SCRYPT_R ||
      Number(parts[3]) !== SCRYPT_P
    );
  } catch {
    return false;
  }
}

/** 会话令牌指纹（SHA-256 hex）：库中只存摘要，不存明文 */
export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** 生成新会话令牌：32 字节随机 → base64url（约 43 字符，URL 安全） */
export function generateSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}
