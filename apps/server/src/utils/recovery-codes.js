import crypto from 'crypto';

/**
 * TOTP 恢复码（一次性、只存哈希）。
 *
 * 形态：10 字符、去混淆字母表（剔除 I / O / 0 / 1 四个字符）——数字 1 与 0 不
 * 出现，I/L 与 1、O 与 0 的抄写歧义随之消失。展示时分两组 `XXXXX-XXXXX`
 * （可读性），存储与比对前
 * 一律先归一化（去分隔符 + 大写），因此用户带不带连字符都能通过。
 *
 * 熵：字母表 32 字符 ^ 10 = 2^50（≥ 50 bit），由 CSPRNG 直接取字节映射——
 * 32 整除 256，`byte % 32` 无取模偏置，无需拒绝采样。
 *
 * 哈希算法取舍（为什么 SHA-256 而不是 scrypt）：scrypt 的慢哈希是为了抵抗
 * 「低熵人类口令」的离线爆破，而恢复码是 50 bit 随机串——没有字典可猜，慢
 * 哈希只带来成本。同时恢复码校验位于登录热路径（密码校验已付一次 scrypt），
 * 再叠 10 次慢哈希会显著拖慢登录。故用 SHA-256 单轮 + 恒定长度摘要，比对
 * 走 crypto.timingSafeEqual。
 *
 * 明确边界：库文件可读的攻击者拿到的是哈希，但 2^50 空间离线爆破在算力充足
 * 时并非不可能——**这条防线只为「只泄漏了库文件、攻击者离线慢慢跑」延长窗口，
 * 不承诺库泄漏后恢复码绝对不可逆推**（库可读本身已意味着 totp_secret 明文
 * 可读，见 routes/auth.js 的 secret 静态存储说明）。故恢复码另有两道不依赖
 * 哈希强度的防线：一次性（used_at 置位）+ 与密码同链路校验。
 */

/** 去混淆字母表：无 I/O/0/1（32 字符，2^5） */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** 每码有效字符数：32^10 = 2^50 */
const CODE_LENGTH = 10;
/** 生成数量（一次性恢复码池大小） */
export const RECOVERY_CODE_COUNT = 10;

/** 原始 10 字符 → 展示形态 `XXXXX-XXXXX` */
export function formatRecoveryCode(raw) {
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

/**
 * 归一化用户输入的恢复码：去空格/连字符并大写。
 * 形状不符（长度或字母表）返回 null——不静默截断（截断会把两个不同的错误
 * 输入算成同一个哈希，掩盖输入错误）。
 */
export function normalizeRecoveryCode(input) {
  if (typeof input !== 'string') return null;
  const cleaned = input.replace(/[\s-]/g, '').toUpperCase();
  if (cleaned.length !== CODE_LENGTH) return null;
  for (const ch of cleaned) {
    if (!ALPHABET.includes(ch)) return null;
  }
  return cleaned;
}

/** 恢复码落库摘要：对**归一化形态**取 SHA-256 hex（用户输入的编码差异不影响命中） */
export function hashRecoveryCode(input) {
  const normalized = normalizeRecoveryCode(input);
  if (normalized === null) return null;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * 生成 count 个互不相同的恢复码（展示形态）。
 * 去重是防御性的：2^50 空间下碰撞概率可忽略，但「两条同码哈希」会因
 * code_hash 唯一约束直接写库失败，生成侧先排除更稳。
 */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT) {
  const codes = new Set();
  while (codes.size < count) {
    const bytes = crypto.randomBytes(CODE_LENGTH);
    let raw = '';
    for (const byte of bytes) raw += ALPHABET[byte % ALPHABET.length];
    codes.add(formatRecoveryCode(raw));
  }
  return [...codes];
}

export default {
  RECOVERY_CODE_COUNT,
  formatRecoveryCode,
  normalizeRecoveryCode,
  hashRecoveryCode,
  generateRecoveryCodes,
};
